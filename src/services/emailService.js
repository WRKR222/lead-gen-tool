/**
 * Bulk cold-email sender - per-company suppression list, warm-up ramp and
 * rate limits, so one tenant's sending behavior never affects another's.
 *
 * Compliance guardrails baked in (do not remove these - most
 * jurisdictions' anti-spam laws, e.g. CAN-SPAM/GDPR/CASL, require them):
 *  - Every email includes a working one-click unsubscribe link.
 *  - Anyone on a company's suppression_list (unsubscribed/bounced/
 *    complained) is skipped automatically, forever, for THAT company.
 *  - Sending is rate-limited (configurable via env) to protect
 *    deliverability and avoid being flagged as spam.
 *  - The From address/name must be real and accurate; don't fake headers.
 *
 * Each company is responsible for having a lawful basis to email each
 * contact in its jurisdiction (e.g. legitimate interest / opt-out regimes
 * vs. opt-in-only regimes like most of the EU under GDPR/PECR) - this tool
 * does not determine that for you.
 */
const nodemailer = require('nodemailer');
const crypto = require('crypto');
const { db } = require('../db/database');

// Cached Ethereal (fake SMTP sandbox) transport + account, created lazily
// on first use so a fresh throwaway test inbox is generated once per
// process run when no real SMTP is configured. Nothing here costs money
// or requires signup - https://ethereal.email
let cachedTransportPromise = null;

function buildConsoleStubTransport() {
  return {
    async sendMail(opts) {
      console.log('\n[demo mode - no network] Would send email:');
      console.log(`  To: ${opts.to}`);
      console.log(`  Subject: ${opts.subject}`);
      console.log(`  Body:\n${opts.text}\n`);
      return { messageId: `stub-${Date.now()}`, __stub: true };
    }
  };
}

async function getTransport() {
  if (process.env.SMTP_HOST) {
    return nodemailer.createTransport({
      host: process.env.SMTP_HOST,
      port: Number(process.env.SMTP_PORT || 587),
      secure: Number(process.env.SMTP_PORT) === 465,
      auth: { user: process.env.SMTP_USER, pass: process.env.SMTP_PASS }
    });
  }
  if (!cachedTransportPromise) {
    cachedTransportPromise = nodemailer.createTestAccount()
      .then(account => {
        console.log(`[demo mode] Using Ethereal test inbox: ${account.user} / ${account.pass}`);
        console.log('[demo mode] View "sent" emails via the preview URL logged after each send.');
        return nodemailer.createTransport({
          host: account.smtp.host,
          port: account.smtp.port,
          secure: account.smtp.secure,
          auth: { user: account.user, pass: account.pass }
        });
      })
      .catch(err => {
        console.warn(`[demo mode] Ethereal unreachable (${err.message}) - falling back to console-only stub transport. No email will actually be delivered anywhere.`);
        return buildConsoleStubTransport();
      });
  }
  return cachedTransportPromise;
}

function isSuppressed(companyId, email) {
  const row = db.prepare('SELECT 1 FROM suppression_list WHERE company_id = ? AND email = ?').get(companyId, email.toLowerCase());
  return !!row;
}

function suppress(companyId, email, reason) {
  db.prepare('INSERT OR REPLACE INTO suppression_list (company_id, email, reason) VALUES (?, ?, ?)')
    .run(companyId, email.toLowerCase(), reason);
}

function unsubscribeToken(companyId, email) {
  const secret = process.env.SMTP_PASS || process.env.JWT_SECRET || 'dev-secret'; // any stable server secret
  return crypto.createHmac('sha256', secret).update(`${companyId}:${email.toLowerCase()}`).digest('hex').slice(0, 24);
}

function unsubscribeUrl(companyId, email) {
  const base = process.env.PUBLIC_BASE_URL || 'http://localhost:4000';
  return `${base}/api/unsubscribe?company=${encodeURIComponent(companyId)}&email=${encodeURIComponent(email)}&token=${unsubscribeToken(companyId, email)}`;
}

// In-memory rolling counters for simple rate limiting, per company (swap
// for Redis in a multi-instance deployment).
const sendLogByCompany = new Map();

/**
 * Domain warm-up ramp, per company. On a company's very first send,
 * records today as day 0. From then on, the allowed daily cap grows
 * linearly from WARMUP_START_PER_DAY toward MAX_EMAILS_PER_DAY over
 * WARMUP_RAMP_DAYS, so a brand-new sending domain doesn't jump straight to
 * full volume (one of the fastest ways to get flagged as spam). Set
 * WARMUP_ENABLED=false once a domain has an established reputation.
 */
function getEffectiveDailyCap(companyId) {
  const configuredMax = Number(process.env.MAX_EMAILS_PER_DAY || 500);
  if (process.env.WARMUP_ENABLED === 'false') return configuredMax;

  const startPerDay = Number(process.env.WARMUP_START_PER_DAY || 20);
  const rampDays = Number(process.env.WARMUP_RAMP_DAYS || 21);

  let row = db.prepare('SELECT first_send_date FROM warmup_state WHERE company_id = ?').get(companyId);
  if (!row) {
    db.prepare('INSERT INTO warmup_state (company_id, first_send_date) VALUES (?, ?)').run(companyId, new Date().toISOString());
    row = { first_send_date: new Date().toISOString() };
  }

  const daysSinceStart = Math.floor((Date.now() - new Date(row.first_send_date).getTime()) / 86400000);
  if (daysSinceStart >= rampDays) return configuredMax;

  const ramped = startPerDay + (configuredMax - startPerDay) * (daysSinceStart / rampDays);
  return Math.max(startPerDay, Math.round(ramped));
}

function withinRateLimit(companyId) {
  const now = Date.now();
  const hourAgo = now - 60 * 60 * 1000;
  const dayAgo = now - 24 * 60 * 60 * 1000;
  const log = sendLogByCompany.get(companyId) || [];
  const lastHour = log.filter(t => t > hourAgo).length;
  const lastDay = log.filter(t => t > dayAgo).length;
  const maxHour = Number(process.env.MAX_EMAILS_PER_HOUR || 100);
  const maxDay = getEffectiveDailyCap(companyId);
  return lastHour < maxHour && lastDay < maxDay;
}

function recordSend(companyId) {
  const log = sendLogByCompany.get(companyId) || [];
  log.push(Date.now());
  sendLogByCompany.set(companyId, log);
}

/**
 * Send one AI-generated, lead-unique email on behalf of `companyId`.
 * `generated` comes from emailGenerationService.generateEmailForLead() -
 * { subject, body, angle }. The unsubscribe link/header is appended here
 * (not by the model) so it is always present and always correct.
 */
async function sendGeneratedToLead(companyId, lead, generated, fromName, fromEmail) {
  if (!lead.email) return { status: 'skipped_no_email' };
  if (isSuppressed(companyId, lead.email)) return { status: 'skipped_suppressed' };
  if (!withinRateLimit(companyId)) return { status: 'skipped_rate_limited' };

  const transport = await getTransport();
  const unsubUrl = unsubscribeUrl(companyId, lead.email);

  const info = await transport.sendMail({
    from: `"${fromName || process.env.FROM_NAME || 'Demo Sender'}" <${fromEmail || process.env.FROM_EMAIL || 'demo@example.com'}>`,
    to: lead.email,
    subject: generated.subject,
    text: `${generated.body}\n\n---\nUnsubscribe: ${unsubUrl}`,
    html: `<div>${generated.body.replace(/\n/g, '<br/>')}</div><p style="font-size:12px;color:#888">\
      <a href="${unsubUrl}">Unsubscribe</a></p>`,
    headers: { 'List-Unsubscribe': `<${unsubUrl}>` }
  });

  recordSend(companyId);
  const previewUrl = (!process.env.SMTP_HOST && !info.__stub) ? nodemailer.getTestMessageUrl(info) : null;
  if (previewUrl) console.log(`[demo mode] Preview this email: ${previewUrl}`);
  return { status: 'sent', previewUrl };
}

module.exports = { sendGeneratedToLead, isSuppressed, suppress, unsubscribeUrl, unsubscribeToken, withinRateLimit, getEffectiveDailyCap };
