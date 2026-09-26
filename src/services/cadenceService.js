/**
 * Follow-up cadence for leads that have not responded: keep trying, never
 * spam. After each outbound touch the next one is scheduled further out
 * (2, 4, 7, 14, 21 days by default), methods rotate so the same channel is
 * not hammered, and hard caps apply per lead: a minimum gap between touches
 * and a maximum number of touches per 30 days. After the last attempt the
 * lead is marked "not responded" and drops to a slow nurture interval.
 */
const { db } = require('../db/database');
const { getSettings } = require('./directionsService');
const { OUTREACH_METHODS } = require('../config/playbook');

const STOP_STATUSES = ['closed_won', 'closed_lost', 'bounced', 'unsubscribed', 'spam', 'meeting_booked'];
const DIGITAL_CHANNELS = ['whatsapp', 'instagram', 'facebook', 'linkedin', 'tiktok', 'x'];
const DAY = 86400000;

function isoIn(ms) { return new Date(Date.now() + ms).toISOString(); }

/** Called after every outbound touch on a lead. */
function scheduleNext(companyId, leadId) {
  const lead = db.prepare('SELECT * FROM leads WHERE id = ? AND company_id = ?').get(leadId, companyId);
  if (!lead) return null;
  const now = new Date().toISOString();
  if (lead.follow_up_paused || STOP_STATUSES.includes(lead.status)) {
    db.prepare('UPDATE leads SET next_follow_up_at = NULL, last_contacted_at = ? WHERE id = ?').run(now, leadId);
    return null;
  }
  const c = getSettings(companyId).cadence;
  const count = (lead.follow_up_count || 0) + 1;
  let waitMs;
  if (count >= c.maxAttempts) {
    waitMs = c.nurtureIntervalDays * DAY;
    if (['new', 'contacted'].includes(lead.status)) {
      db.prepare("UPDATE leads SET status = 'no_response', updated_at = datetime('now') WHERE id = ?").run(leadId);
    }
  } else {
    waitMs = c.intervalsDays[Math.min(count - 1, c.intervalsDays.length - 1)] * DAY;
  }
  waitMs = Math.max(waitMs, c.minHoursBetweenTouches * 3600000);
  const next = isoIn(waitMs);
  db.prepare('UPDATE leads SET follow_up_count = ?, next_follow_up_at = ?, last_contacted_at = ? WHERE id = ?').run(count, next, now, leadId);
  return next;
}

/** Push the next touch to a specific delay (e.g. "on the fence": check back in a week). */
function scheduleIn(leadId, days) {
  db.prepare('UPDATE leads SET next_follow_up_at = ? WHERE id = ?').run(isoIn(days * DAY), leadId);
}

function stop(leadId) {
  db.prepare('UPDATE leads SET next_follow_up_at = NULL WHERE id = ?').run(leadId);
}

function setPaused(companyId, leadId, paused) {
  db.prepare('UPDATE leads SET follow_up_paused = ? WHERE id = ? AND company_id = ?').run(paused ? 1 : 0, leadId, companyId);
}

/** Which method to use next: the strongest one this lead can be reached by, rotating away from the last one used. */
function suggestMethod(contacts, lastMethod, suppressedEmail) {
  const channels = new Set(contacts.map(c => c.channel));
  const available = OUTREACH_METHODS.filter(m => {
    if (m.key === 'door_to_door') return channels.has('address');
    if (m.key === 'cold_call') return channels.has('phone');
    if (m.key === 'digital') return DIGITAL_CHANNELS.some(ch => channels.has(ch));
    if (m.key === 'email_dm') return channels.has('email') && !suppressedEmail;
    return false;
  });
  if (!available.length) return null;
  const rotated = available.filter(m => m.key !== lastMethod);
  return (rotated.length ? rotated : available).sort((a, b) => a.rank - b.rank)[0].key;
}

/**
 * Leads whose next follow-up is due, with the suggested method. Leads that
 * already hit the per-30-day touch cap or were touched too recently are
 * held back automatically.
 */
function dueQueue(companyId, { limit = 100 } = {}) {
  const c = getSettings(companyId).cadence;
  const now = new Date().toISOString();
  const rows = db.prepare(`
    SELECT * FROM leads WHERE company_id = ? AND follow_up_paused = 0 AND next_follow_up_at IS NOT NULL
      AND next_follow_up_at <= ? AND status NOT IN (${STOP_STATUSES.map(() => '?').join(',')})
    ORDER BY next_follow_up_at ASC LIMIT ?
  `).all(companyId, now, ...STOP_STATUSES, limit);

  const recentTouches = db.prepare(`
    SELECT COUNT(*) AS n, MAX(occurred_at) AS last FROM outreach_attempts
    WHERE lead_id = ? AND direction = 'outbound' AND datetime(occurred_at) >= datetime(?)
  `);
  const lastAttempt = db.prepare("SELECT method, result, occurred_at FROM outreach_attempts WHERE lead_id = ? AND direction = 'outbound' ORDER BY occurred_at DESC LIMIT 1");
  const contactsOf = db.prepare('SELECT channel, value FROM lead_contacts WHERE lead_id = ?');
  const suppressed = db.prepare('SELECT 1 FROM suppression_list WHERE company_id = ? AND email = ?');

  const out = [];
  for (const lead of rows) {
    const touches = recentTouches.get(lead.id, new Date(Date.now() - 30 * DAY).toISOString());
    if (touches.n >= c.maxTouchesPer30Days) continue;
    if (touches.last && Date.now() - new Date(touches.last).getTime() < c.minHoursBetweenTouches * 3600000) continue;
    const last = lastAttempt.get(lead.id);
    const contacts = contactsOf.all(lead.id);
    const emailSuppressed = !!(lead.email && suppressed.get(companyId, lead.email.toLowerCase()));
    const method = suggestMethod(contacts, last && last.method, emailSuppressed);
    out.push({
      lead: { id: lead.id, company_name: lead.company_name, contact_name: lead.contact_name, status: lead.status, email: lead.email, phone: lead.phone, lead_type: lead.lead_type },
      dueAt: lead.next_follow_up_at,
      attemptsSoFar: lead.follow_up_count || 0,
      lastAttempt: last || null,
      suggestedMethod: method,
      reason: method ? `Attempt ${(lead.follow_up_count || 0) + 1} of ${c.maxAttempts}${last ? `, rotating from ${last.method.replace(/_/g, ' ')}` : ''}` : 'No usable contact - add a phone, email, address or social handle'
    });
  }
  return out;
}

module.exports = { scheduleNext, scheduleIn, stop, setPaused, dueQueue, suggestMethod, STOP_STATUSES, DIGITAL_CHANNELS };
