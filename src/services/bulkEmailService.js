/**
 * Email to many leads at once, two ways:
 *  - template: ONE AI-written email for the whole selection, lightly
 *    personalised per lead (first name, company, one line about them)
 *  - bespoke: a fully unique AI email per lead (emailGenerationService)
 * Drafts are always returned for review first; sending applies the
 * compliance gates (suppression, rate limit, unsubscribe), threads the
 * message, logs the attempt and schedules the next follow-up.
 */
const { v4: uuid } = require('uuid');
const { db } = require('../db/database');
const llm = require('./llm');
const leads = require('./leadsService');
const emailService = require('./emailService');
const emailGeneration = require('./emailGenerationService');
const outreach = require('./outreachService');
const { getDirections } = require('./directionsService');
const { playbookPromptBlock } = require('../config/playbook');

const MAX_BATCH = 200;

function firstName(l) { return l.contact_name ? l.contact_name.split(' ')[0] : ''; }

function companyLine(l) {
  const where = l.city ? ` in ${l.city}` : '';
  if (l.lead_type === 'person') return `I thought of you${where} when we opened a few spots this month.`;
  if (l.industry) return `${l.company_name} stood out to me among ${l.industry} businesses${where}.`;
  return `${l.company_name}${where} came up while I was looking at businesses we could genuinely help.`;
}

function fillTemplate(tpl, l, line) {
  const name = firstName(l);
  return tpl
    .replace(/\{\{\s*first_name\s*\}\}/gi, name || 'there')
    .replace(/\{\{\s*company\s*\}\}/gi, l.company_name || l.contact_name || 'your business')
    .replace(/\{\{\s*company_line\s*\}\}/gi, line)
    .replace(/\{\{\s*city\s*\}\}/gi, l.city || 'your area');
}

function fallbackTemplate(directions, goal) {
  const s = directions.sender || {};
  const booking = directions.bookingLink ? `\n\nPick a time that suits you: ${directions.bookingLink}` : '';
  return {
    subject: '{{first_name}}, a quick idea for {{company}}',
    body: `Hi {{first_name}},\n\n{{company_line}}\n\n${goal ? goal.trim().replace(/\.?$/, '.') + ' ' : ''}We only work with a handful of businesses in {{city}} at a time, and I'd like {{company}} to be one of them.\n\nCould we find 15 minutes this week? Any questions, I'll answer in the meeting.${booking}\n\n${s.senderName || ''}\n${s.companyName || ''}`.trim(),
    _generatedBy: 'local_template'
  };
}

async function aiTemplate(directions, goal) {
  const system = `You write one outreach email that will be sent to many leads, lightly personalised with merge fields. Use exactly these merge fields: {{first_name}}, {{company}}, {{company_line}} (one sentence about the lead, inserted for you), {{city}}. The only goal is to book a meeting. Under 110 words. No em dashes. Return ONLY JSON {"subject":"","body":""}.\n\n${playbookPromptBlock()}`;
  const user = `SENDER: ${JSON.stringify(directions.sender || {})}\n${directions.bookingLink ? 'BOOKING LINK (include it): ' + directions.bookingLink + '\n' : ''}CAMPAIGN GOAL: ${goal || 'Book an introductory meeting'}`;
  const t = await llm.completeJson({ system, user, effort: 'low', maxTokens: 4000 });
  return { ...t, _generatedBy: 'anthropic:' + llm.MODEL };
}

/** One personal sentence per lead, in a single AI call. */
async function aiCompanyLines(rows) {
  const system = 'For each lead write ONE short, specific, plausible sentence showing we noticed them (no invented facts, no pitch). Return ONLY JSON {"<lead id>":"sentence"}.';
  const user = JSON.stringify(rows.map(l => ({ id: l.id, type: l.lead_type, company: l.company_name, contact: l.contact_name, industry: l.industry, city: l.city, notes: l.notes })));
  return llm.completeJson({ system, user, effort: 'low', maxTokens: 12000 });
}

async function mapLimit(items, limit, fn) {
  const out = new Array(items.length);
  let i = 0;
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (i < items.length) { const idx = i++; out[idx] = await fn(items[idx], idx); }
  }));
  return out;
}

/**
 * @param {object} o - { leadIds, mode: 'template'|'bespoke', goal?, stepId? }
 * @returns {Promise<{mode, template?, drafts: object[], skipped: object[]}>}
 */
async function compose(companyId, { leadIds, mode = 'template', goal, stepId = 'intro' }) {
  if (!Array.isArray(leadIds) || !leadIds.length) throw new Error('leadIds[] is required');
  if (leadIds.length > MAX_BATCH) throw new Error(`At most ${MAX_BATCH} leads per batch`);
  const directions = getDirections(companyId);
  const rows = leadIds.map(id => leads.getLeadRow(companyId, id)).filter(Boolean);
  const skipped = [];
  const withEmail = rows.filter(l => {
    if (!l.email) { skipped.push({ leadId: l.id, name: leads.displayName(l), reason: 'no email address' }); return false; }
    if (emailService.isSuppressed(companyId, l.email)) { skipped.push({ leadId: l.id, name: leads.displayName(l), reason: 'unsubscribed / suppressed' }); return false; }
    return true;
  });

  if (mode === 'bespoke') {
    const drafts = await mapLimit(withEmail, 4, async (l) => {
      const g = await emailGeneration.generateEmailForLead(leads.toLeadShape(l), directions, stepId);
      return { leadId: l.id, name: leads.displayName(l), to: l.email, subject: g.subject, body: g.body, angle: g.angle, mode: 'bespoke' };
    });
    return { mode, drafts, skipped };
  }

  let template;
  let lines = {};
  if (llm.enabled()) {
    try {
      [template, lines] = await Promise.all([aiTemplate(directions, goal), aiCompanyLines(withEmail).catch(() => ({}))]);
    } catch (err) {
      console.warn(`[bulkEmailService] AI template failed (${err.message}), using fallback.`);
    }
  }
  template = template || fallbackTemplate(directions, goal);
  // Every bulk email must still greet the lead and mention them.
  if (!/\{\{\s*first_name\s*\}\}/i.test(template.body)) template.body = `Hi {{first_name}},\n\n${template.body}`;
  if (!/\{\{\s*company_line\s*\}\}/i.test(template.body)) template.body = template.body.replace(/^(Hi \{\{\s*first_name\s*\}\},?\n\n)?/i, (m) => `${m}{{company_line}}\n\n`);
  const drafts = withEmail.map(l => {
    const line = lines[l.id] || companyLine(l);
    return { leadId: l.id, name: leads.displayName(l), to: l.email, subject: fillTemplate(template.subject, l, line), body: fillTemplate(template.body, l, line), angle: 'template', mode: 'bulk_template' };
  });
  return { mode, template, drafts, skipped };
}

/**
 * Send one email to one lead and record everything about it.
 * @param {object} d - { leadId, subject, body, mode?, angle?, inReplyTo?, automated? }
 */
async function sendOne(companyId, userId, d) {
  const lead = leads.getLeadRow(companyId, d.leadId);
  if (!lead) return { leadId: d.leadId, status: 'skipped_not_found' };
  if (!d.subject || !d.body) return { leadId: lead.id, status: 'skipped_empty' };
  const directions = getDirections(companyId);
  const fromName = directions.sender?.senderName ? `${directions.sender.senderName}${directions.sender.companyName ? ' - ' + directions.sender.companyName : ''}` : directions.sender?.companyName;
  const result = await emailService.sendGeneratedToLead(companyId, { email: lead.email }, { subject: d.subject, body: d.body }, fromName, null, { inReplyTo: d.inReplyTo });
  const id = uuid();
  const now = new Date().toISOString();
  db.prepare(`INSERT INTO email_messages (id, company_id, lead_id, direction, from_addr, to_addr, subject, body, message_id, in_reply_to, status, mode, angle, auto_generated, preview_url, sent_at)
    VALUES (?, ?, ?, 'outbound', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
    .run(id, companyId, lead.id, result.from || null, lead.email, d.subject, d.body, result.messageId || null, d.inReplyTo || null,
      result.status, d.mode || 'manual', d.angle || null, d.automated ? 1 : 0, result.previewUrl || null, result.status === 'sent' ? now : null);
  if (result.status === 'sent') {
    outreach.recordAttempt(companyId, userId, {
      leadId: lead.id, method: 'email_dm', channel: 'email', result: 'sent', message: `${d.subject}\n\n${d.body}`, automated: d.automated, occurredAt: now
    });
  }
  return { leadId: lead.id, emailId: id, status: result.status, previewUrl: result.previewUrl || undefined };
}

async function sendMany(companyId, userId, drafts) {
  if (!Array.isArray(drafts) || !drafts.length) throw new Error('drafts[] is required');
  if (drafts.length > MAX_BATCH) throw new Error(`At most ${MAX_BATCH} emails per batch`);
  const results = [];
  for (const d of drafts) {
    const r = await sendOne(companyId, userId, d);
    results.push(r);
    if (r.status === 'skipped_rate_limited') {
      drafts.slice(results.length).forEach(rest => results.push({ leadId: rest.leadId, status: 'skipped_rate_limited' }));
      break;
    }
  }
  const sent = results.filter(r => r.status === 'sent').length;
  return { sent, total: drafts.length, results };
}

module.exports = { compose, sendOne, sendMany, fillTemplate };
