/**
 * Multi-method outreach for one lead. A rep picks any combination of the
 * four methods (door to door, cold call, digital platforms, email/DM);
 * this service prepares AI guidance for each, records every attempt and
 * its result, moves the lead through its pipeline, and applies the four
 * outcomes (converted / on the fence / said no / not responded).
 */
const { v4: uuid } = require('uuid');
const { db } = require('../db/database');
const llm = require('./llm');
const leads = require('./leadsService');
const cadence = require('./cadenceService');
const customers = require('./customersService');
const notifications = require('./notificationService');
const callsService = require('./callsService');
const emailGeneration = require('./emailGenerationService');
const { getDirections, getSettings } = require('./directionsService');
const { resultByKey, methodForChannel, playbookPromptBlock, MEETING_STANDARDS, OUTREACH_METHODS } = require('../config/playbook');

const DIGITAL = ['whatsapp', 'instagram', 'facebook', 'linkedin', 'tiktok', 'x'];

function digits(phone) { return String(phone || '').replace(/[^\d]/g, ''); }

/** A link that opens the right app/profile for a contact point. */
function deepLink(channel, value, text) {
  const v = String(value || '').trim();
  const isUrl = /^https?:\/\//i.test(v);
  const handle = v.replace(/^@/, '');
  switch (channel) {
    case 'whatsapp': return `https://wa.me/${digits(v)}${text ? '?text=' + encodeURIComponent(text) : ''}`;
    case 'phone': return `tel:${v.replace(/\s+/g, '')}`;
    case 'sms': return `sms:${v.replace(/\s+/g, '')}${text ? '?body=' + encodeURIComponent(text) : ''}`;
    case 'email': return `mailto:${v}`;
    case 'instagram': return isUrl ? v : `https://instagram.com/${handle}`;
    case 'facebook': return isUrl ? v : `https://facebook.com/${handle}`;
    case 'linkedin': return isUrl ? v : `https://www.linkedin.com/search/results/all/?keywords=${encodeURIComponent(v)}`;
    case 'tiktok': return isUrl ? v : `https://www.tiktok.com/@${handle}`;
    case 'x': return isUrl ? v : `https://x.com/${handle}`;
    case 'address': return `https://www.google.com/maps/search/?api=1&query=${encodeURIComponent(v)}`;
    case 'website': return isUrl ? v : `https://${v}`;
    default: return null;
  }
}

/** "I'm Amina from Chunguza" - or just "I'm with Chunguza" when the sender is a generic team name. */
function introduce(directions) {
  const s = directions.sender || {};
  const person = s.senderName && !/team|sales|department|^business/i.test(s.senderName) ? s.senderName : null;
  return person ? `I'm ${person} from ${s.companyName || 'our team'}` : `I'm with ${s.companyName || 'our team'}`;
}

function fallbackDoorToDoor(lead, directions) {
  const who = lead.companyName || lead.contactName;
  const decisionMaker = lead.contactName || 'the owner';
  return {
    bestTime: lead.leadType === 'person' ? 'Early evening or weekend' : 'Mid-morning (10-11am) or mid-afternoon (2-4pm), avoid rush hours',
    walkInOpener: `Hi - is ${decisionMaker} in? ${introduce(directions)}, I only need two minutes with them.`,
    ifGatekeeper: `No problem - when is the best time to catch ${decisionMaker}? Could I leave my number for them personally?`,
    hook: `I walked past ${who} and noticed something about how you're bringing in ${lead.leadType === 'person' ? 'bookings' : 'customers'} that I think is costing you.`,
    scarcityLine: 'We only work with one business like yours per area, so I wanted to speak with you before anyone else nearby.',
    meetingAsk: 'Can we sit down properly for 15 minutes - later this week, here at your place?',
    leaveBehind: 'Leave a card with your WhatsApp number and write the meeting time on the back.',
    checklist: MEETING_STANDARDS.map(s => s.label),
    _generatedBy: 'local_template'
  };
}

function fallbackDm(platform, lead, directions) {
  const first = lead.contactName ? lead.contactName.split(' ')[0] : null;
  const who = lead.companyName || 'your business';
  const base = {
    whatsapp: `${first ? 'Hi ' + first : 'Hi'}, ${directions.sender?.senderName || 'this is'} from ${directions.sender?.companyName || 'our team'}. I came across ${who} and have one idea to bring you more customers - we only offer it to one ${lead.industry || 'business'} in your area. 15 minutes this week?`,
    instagram: `${first ? first + ', ' : ''}love what ${who} is posting. I have a quick idea to turn more of your followers into customers - it's exclusive to one business in your area. Open to a short call this week?`,
    facebook: `${first ? 'Hi ' + first + ', ' : 'Hi, '}saw ${who}'s page - one idea to get you more bookings, only offered to one business per area. Worth 15 minutes this week?`,
    linkedin: `${first ? first + ' - ' : ''}reaching out personally about ${who}. We help a small number of ${lead.industry || 'businesses'} get more of the right customers. Would a 15-minute conversation this week make sense?`,
    tiktok: `${first ? first + ', ' : ''}your content is great - I have an idea to turn views into paying customers for ${who}. Only for one business per area. Quick chat?`,
    x: `${first ? first + ', ' : ''}quick one about growing ${who} - exclusive to one business in your area. Open to 15 minutes?`
  };
  return base[platform] || base.whatsapp;
}

async function aiDoorAndDigital(lead, directions, platforms) {
  const system = `You prepare field sales reps for an AI lead-generation agency. The ONLY goal of any first contact is to book a meeting. Return ONLY valid JSON, no markdown.\n\n${playbookPromptBlock()}`;
  const user = `SENDER: ${JSON.stringify(directions.sender || {})}
LEAD: ${JSON.stringify(lead)}
Write (a) a door-to-door visit brief and (b) one short DM per platform in ${JSON.stringify(platforms)} (under 50 words each, platform-appropriate tone, no pitch, ask for a short meeting).
SHAPE: {"doorToDoor":{"bestTime":"","walkInOpener":"","ifGatekeeper":"","hook":"","scarcityLine":"","meetingAsk":"","leaveBehind":""},"dms":{"<platform>":"message"}}`;
  return llm.completeJson({ system, user, effort: 'low', maxTokens: 8000 });
}

/**
 * Prepare guidance for each chosen method.
 * @returns {Promise<object>} { lead, methods: { door_to_door?, cold_call?, digital?, email_dm? } }
 */
async function prepare(companyId, leadId, methods) {
  const row = leads.getLeadRow(companyId, leadId);
  if (!row) throw new Error('lead not found');
  const chosen = (methods && methods.length ? methods : OUTREACH_METHODS.map(m => m.key)).filter(m => OUTREACH_METHODS.some(x => x.key === m));
  db.prepare('UPDATE leads SET preferred_methods_json = ? WHERE id = ?').run(JSON.stringify(chosen), leadId);

  const lead = leads.toLeadShape(row);
  const directions = getDirections(companyId);
  const contacts = leads.listContacts(leadId);
  const digitalContacts = contacts.filter(c => DIGITAL.includes(c.channel));
  const platforms = digitalContacts.length ? [...new Set(digitalContacts.map(c => c.channel))] : ['whatsapp', 'instagram', 'facebook', 'linkedin'];

  let ai = null;
  if (llm.enabled() && (chosen.includes('door_to_door') || chosen.includes('digital'))) {
    try { ai = await aiDoorAndDigital(lead, directions, platforms); } catch (err) { console.warn(`[outreachService] AI prep failed (${err.message}), using templates.`); }
  }

  const out = {};
  if (chosen.includes('door_to_door')) {
    const addresses = contacts.filter(c => c.channel === 'address');
    out.door_to_door = {
      addresses: addresses.map(a => ({ contactId: a.id, value: a.value, mapUrl: deepLink('address', a.value) })),
      brief: ai?.doorToDoor ? { ...llm.withFallback(ai.doorToDoor, fallbackDoorToDoor(lead, directions)), checklist: MEETING_STANDARDS.map(s => s.label), _generatedBy: 'anthropic:' + llm.MODEL } : fallbackDoorToDoor(lead, directions),
      missing: addresses.length ? null : 'No address yet - add one to plan the visit.'
    };
  }
  if (chosen.includes('cold_call')) {
    const phones = contacts.filter(c => c.channel === 'phone' || c.channel === 'whatsapp');
    out.cold_call = {
      numbers: phones.map(p => ({ contactId: p.id, value: p.value, person: p.person_name, role: p.person_role, decisionMaker: !!p.is_decision_maker, telUrl: deepLink('phone', p.value) })),
      script: await callsService.generateCallScript(lead, directions),
      missing: phones.length ? null : 'No phone number yet.'
    };
  }
  if (chosen.includes('digital')) {
    out.digital = {
      messages: platforms.map(platform => {
        const contact = digitalContacts.find(c => c.channel === platform);
        const text = ai?.dms?.[platform] || fallbackDm(platform, lead, directions);
        return { platform, contactId: contact?.id || null, handle: contact?.value || null, text, openUrl: contact ? deepLink(platform, contact.value, text) : null };
      }),
      note: 'Send these by hand from the business account - platforms do not allow automated bulk DMs.',
      missing: digitalContacts.length ? null : 'No social handles yet - these are drafts for when you find them.'
    };
  }
  if (chosen.includes('email_dm')) {
    const emails = contacts.filter(c => c.channel === 'email');
    const draft = await emailGeneration.generateEmailForLead(lead, directions, row.follow_up_count ? 'follow_up' : 'intro');
    out.email_dm = { to: emails.map(e => ({ contactId: e.id, value: e.value, person: e.person_name })), draft, missing: emails.length ? null : 'No email address yet.' };
  }
  return { lead: row, contacts, methods: out };
}

/**
 * Apply one of the four outcomes to a lead.
 * @param {string} outcome - converted | on_fence | said_no | no_response
 */
function setOutcome(companyId, leadId, { outcome, reasonCategory, reason, tier, value, userId }) {
  const lead = leads.getLeadRow(companyId, leadId);
  if (!lead) throw new Error('lead not found');
  const name = leads.displayName(lead);
  const now = new Date().toISOString();
  const result = { outcome };

  if (outcome === 'converted') {
    db.prepare("UPDATE leads SET status = 'closed_won', converted_at = ?, next_follow_up_at = NULL, updated_at = datetime('now') WHERE id = ?").run(now, leadId);
    leads.learnFromEvent(companyId, lead, 'closed_won');
    const ws = db.prepare('SELECT kind FROM companies WHERE id = ?').get(companyId);
    // A client's converted lead becomes one of its customers; an agency prospect becomes a client via /leads/:id/convert-to-client.
    if (ws.kind === 'client') result.customer = customers.createFromLead(companyId, lead, { tier, totalValue: value ?? lead.estimated_value });
    notifications.notify({ companyId, type: 'lead_converted', title: `${name} converted`, body: ws.kind === 'agency' ? 'Set them up as a client workspace from the lead view.' : 'Added to customers.', leadId });
  } else if (outcome === 'on_fence') {
    db.prepare("UPDATE leads SET status = 'on_fence', updated_at = datetime('now') WHERE id = ?").run(leadId);
    cadence.scheduleIn(leadId, 7);
  } else if (outcome === 'said_no') {
    db.prepare(`UPDATE leads SET status = 'closed_lost', lost_reason_category = ?, lost_reason = ?, next_follow_up_at = NULL,
      updated_at = datetime('now') WHERE id = ?`).run(reasonCategory || 'other', reason || null, leadId);
    leads.learnFromEvent(companyId, lead, 'closed_lost', reason);
    customers.recordChurn(companyId, { subjectKind: 'lead', leadId, reasonCategory, reasonText: reason, recordedBy: userId });
  } else if (outcome === 'no_response') {
    db.prepare("UPDATE leads SET status = 'no_response', updated_at = datetime('now') WHERE id = ?").run(leadId);
    cadence.scheduleIn(leadId, getSettings(companyId).cadence.nurtureIntervalDays);
  } else {
    throw new Error('outcome must be converted, on_fence, said_no or no_response');
  }
  return { ...result, lead: leads.getLeadRow(companyId, leadId) };
}

/**
 * Record one contact attempt and apply its result.
 * @param {object} a - { leadId, method?, channel?, contactId?, result, notes?, message?, standards?, spokeToDecisionMaker?,
 *                       direction?, automated?, occurredAt?, reasonCategory?, reason? }
 */
function recordAttempt(companyId, userId, a) {
  const lead = leads.getLeadRow(companyId, a.leadId);
  if (!lead) throw new Error('lead not found');
  const method = a.method || methodForChannel(a.channel);
  const def = resultByKey(a.result);
  if (!def) throw new Error(`unknown result "${a.result}"`);
  const id = uuid();
  const occurredAt = a.occurredAt ? new Date(a.occurredAt).toISOString() : new Date().toISOString();
  const direction = a.direction === 'inbound' ? 'inbound' : 'outbound';
  db.prepare(`INSERT INTO outreach_attempts (id, company_id, lead_id, user_id, method, channel, contact_id, direction, result,
      spoke_to_decision_maker, standards_json, message, notes, automated, occurred_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
    .run(id, companyId, lead.id, userId || null, method, a.channel || null, a.contactId || null, direction, a.result,
      a.spokeToDecisionMaker == null ? null : (a.spokeToDecisionMaker ? 1 : 0), a.standards ? JSON.stringify(a.standards) : null,
      a.message || null, a.notes || null, a.automated ? 1 : 0, occurredAt);

  let outcome = null;
  if (a.result === 'converted') outcome = setOutcome(companyId, lead.id, { outcome: 'converted', userId });
  else if (a.result === 'said_no') outcome = setOutcome(companyId, lead.id, { outcome: 'said_no', reasonCategory: a.reasonCategory, reason: a.reason || a.notes, userId });
  else if (a.result === 'on_fence') outcome = setOutcome(companyId, lead.id, { outcome: 'on_fence', userId });
  else {
    leads.advanceStatus(lead.id, def.leadStatus);
    if (['replied', 'interested'].includes(a.result) && !['replied', 'meeting_booked'].includes(lead.status)) leads.learnFromEvent(companyId, lead, 'replied');
    if (a.result === 'meeting_booked') {
      leads.learnFromEvent(companyId, lead, 'meeting_booked');
      cadence.stop(lead.id);
      notifications.notify({ companyId, type: 'meeting_booked', title: `Meeting booked with ${leads.displayName(lead)}`, body: `via ${method.replace(/_/g, ' ')}`, leadId: lead.id });
    }
  }

  if (direction === 'outbound' && def.followUp) cadence.scheduleNext(companyId, lead.id);
  else if (direction === 'outbound') db.prepare('UPDATE leads SET last_contacted_at = ? WHERE id = ?').run(occurredAt, lead.id);
  if (a.result === 'wrong_contact' && a.contactId) {
    db.prepare("UPDATE lead_contacts SET person_role = COALESCE(person_role, '') || ' (wrong/dead)' WHERE id = ? AND company_id = ?").run(a.contactId, companyId);
  }

  return { attempt: db.prepare('SELECT * FROM outreach_attempts WHERE id = ?').get(id), outcome, lead: leads.getLeadRow(companyId, lead.id) };
}

module.exports = { prepare, recordAttempt, setOutcome, deepLink, introduce };
