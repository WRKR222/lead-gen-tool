/**
 * Inbound email: replies from leads arrive through the inbound webhook
 * (Postmark / Mailgun / any JSON forwarder) or IMAP polling. Each one is
 * matched to its lead (by In-Reply-To, then sender address), classified,
 * stored in the lead's thread, pushed as a real-time notification, and -
 * depending on the workspace's auto-reply mode - answered by the reply bot
 * (off / draft for approval / send). The bot follows the meeting-setting
 * standards: acknowledge, answer generically, steer to the meeting.
 */
const { v4: uuid } = require('uuid');
const { db } = require('../db/database');
const llm = require('./llm');
const leads = require('./leadsService');
const outreach = require('./outreachService');
const cadence = require('./cadenceService');
const notifications = require('./notificationService');
const emailService = require('./emailService');
const bulkEmail = require('./bulkEmailService');
const tasksService = require('./tasksService');
const { getDirections, getSettings } = require('./directionsService');
const { playbookPromptBlock } = require('../config/playbook');

const CLASSES = ['interested', 'meeting_request', 'question', 'not_interested', 'out_of_office', 'unsubscribe', 'other'];
const AUTO_REPLY_CLASSES = ['interested', 'meeting_request', 'question'];

function parseReceivedAt(v) {
  if (v == null || v === '') return new Date().toISOString();
  const n = Number(v);
  const d = Number.isFinite(n) ? new Date(n < 1e12 ? n * 1000 : n) : new Date(v);
  return isNaN(d) ? new Date().toISOString() : d.toISOString();
}

function extractAddress(from) {
  const m = String(from || '').match(/<([^>]+)>/);
  return (m ? m[1] : String(from || '')).trim().toLowerCase();
}

function stripQuoted(text) {
  return String(text || '').split(/\n(?:On .+wrote:|-{2,}\s*Original Message|From: .+)\s*\n/i)[0]
    .split('\n').filter(l => !l.startsWith('>')).join('\n').trim();
}

function heuristicClassify(text) {
  const t = text.toLowerCase();
  if (/unsubscribe|remove me|stop emailing|do not contact|opt.?out/.test(t)) return 'unsubscribe';
  if (/out of (the )?office|on leave|auto.?reply|automatic reply|away until/.test(t)) return 'out_of_office';
  if (/not interested|no thanks|no thank you|we('| a)re good|not for us|not at this time/.test(t)) return 'not_interested';
  if (/meet|call me|schedule|book|available|free on|what time|tomorrow|next week/.test(t)) return 'meeting_request';
  if (/interested|sounds good|tell me more|let's talk|keen/.test(t)) return 'interested';
  if (/\?|how much|price|cost|what do you|how does/.test(t)) return 'question';
  return 'other';
}

async function classify(text) {
  // An explicit opt-out is always honoured, whatever the model says.
  if (heuristicClassify(text) === 'unsubscribe') return 'unsubscribe';
  if (!llm.enabled()) return heuristicClassify(text);
  try {
    const out = await llm.completeJson({
      system: `Classify a reply to a sales outreach email. Return ONLY JSON {"class":"one of ${CLASSES.join('|')}"}.`,
      user: text.slice(0, 4000), effort: 'low', maxTokens: 2000
    });
    return CLASSES.includes(out.class) ? out.class : heuristicClassify(text);
  } catch { return heuristicClassify(text); }
}

async function draftAutoReply(companyId, lead, inbound) {
  const directions = getDirections(companyId);
  const s = directions.sender || {};
  const first = lead.contact_name ? lead.contact_name.split(' ')[0] : '';
  const booking = directions.bookingLink ? ` You can pick a time here: ${directions.bookingLink}` : ' What day and time suit you this week?';
  const fallback = {
    subject: /^re:/i.test(inbound.subject || '') ? inbound.subject : `Re: ${inbound.subject || 'our conversation'}`,
    body: `Hi${first ? ' ' + first : ''},\n\nThanks for getting back to me - great question, and it's exactly what I'd like to go through properly with you, since the answer depends on your situation. It only takes 15 minutes.${booking}\n\n${s.senderName || ''}\n${s.companyName || ''}`.trim(),
    _generatedBy: 'local_template'
  };
  if (!llm.enabled()) return fallback;
  try {
    const out = await llm.completeJson({
      system: `You are the reply assistant for ${s.companyName || 'a sales team'}. Write a short, warm, human reply to the lead's email. Acknowledge what they said, answer only in general terms, and steer to booking a short meeting - details and prices are covered in the meeting. Never invent facts, prices or promises. Under 90 words. Return ONLY JSON {"subject":"","body":""}.\n\n${playbookPromptBlock()}`,
      user: `SENDER: ${JSON.stringify(s)}\n${directions.bookingLink ? 'BOOKING LINK: ' + directions.bookingLink + '\n' : ''}LEAD: ${JSON.stringify(leads.toLeadShape(lead))}\nTHEIR EMAIL (subject: ${inbound.subject || ''}):\n${inbound.body.slice(0, 4000)}`,
      effort: 'low', maxTokens: 4000
    });
    return { subject: out.subject || fallback.subject, body: out.body || fallback.body, _generatedBy: 'anthropic:' + llm.MODEL };
  } catch { return fallback; }
}

/** Find the lead an inbound email belongs to, within the given workspaces. */
function matchLead(workspaceIds, fromAddr, inReplyTo) {
  const marks = workspaceIds.map(() => '?').join(',');
  if (inReplyTo) {
    const m = db.prepare(`SELECT company_id, lead_id FROM email_messages WHERE message_id = ? AND company_id IN (${marks}) AND lead_id IS NOT NULL LIMIT 1`).get(inReplyTo, ...workspaceIds);
    if (m) return m;
  }
  const byLead = db.prepare(`SELECT company_id, id AS lead_id FROM leads WHERE lower(email) = ? AND company_id IN (${marks}) ORDER BY updated_at DESC LIMIT 1`).get(fromAddr, ...workspaceIds);
  if (byLead) return byLead;
  const byContact = db.prepare(`SELECT company_id, lead_id FROM lead_contacts WHERE channel = 'email' AND lower(value) = ? AND company_id IN (${marks}) LIMIT 1`).get(fromAddr, ...workspaceIds);
  return byContact || null;
}

/** Workspaces an inbound email to `companyId` may belong to (an agency inbox also covers its clients). */
function scopeFor(companyId) {
  const c = db.prepare('SELECT id, kind FROM companies WHERE id = ?').get(companyId);
  if (!c) return [];
  if (c.kind !== 'agency') return [c.id];
  return [c.id, ...db.prepare("SELECT id FROM companies WHERE agency_id = ? AND kind = 'client'").all(c.id).map(r => r.id)];
}

/**
 * @param {string} receivingCompanyId - the workspace whose inbox/webhook received it
 * @param {object} msg - { from, to, subject, text, messageId, inReplyTo, receivedAt }
 */
async function processInbound(receivingCompanyId, msg) {
  if (msg.messageId && db.prepare('SELECT 1 FROM email_messages WHERE message_id = ? AND direction = ?').get(msg.messageId, 'inbound')) {
    return { duplicate: true };
  }
  const fromAddr = extractAddress(msg.from);
  const match = matchLead(scopeFor(receivingCompanyId), fromAddr, msg.inReplyTo);
  const companyId = match ? match.company_id : receivingCompanyId;
  const lead = match ? leads.getLeadRow(companyId, match.lead_id) : null;
  const body = stripQuoted(msg.text) || String(msg.text || '').trim();
  const classification = await classify(`${msg.subject || ''}\n${body}`);
  const id = uuid();
  const receivedAt = parseReceivedAt(msg.receivedAt);
  db.prepare(`INSERT INTO email_messages (id, company_id, lead_id, direction, from_addr, to_addr, subject, body, message_id, in_reply_to, status, mode, classification, received_at)
    VALUES (?, ?, ?, 'inbound', ?, ?, ?, ?, ?, ?, 'received', 'manual', ?, ?)`)
    .run(id, companyId, lead ? lead.id : null, fromAddr, msg.to || null, msg.subject || null, body, msg.messageId || null, msg.inReplyTo || null, classification, receivedAt);

  if (!lead) {
    notifications.notify({ companyId, type: 'email_reply', title: `New email from ${fromAddr}`, body: msg.subject || body.slice(0, 120) });
    return { emailId: id, matched: false, classification };
  }

  const name = leads.displayName(lead);
  if (classification === 'unsubscribe') {
    emailService.suppress(companyId, fromAddr, 'replied_unsubscribe');
    db.prepare("UPDATE leads SET status = 'unsubscribed', next_follow_up_at = NULL, updated_at = datetime('now') WHERE id = ?").run(lead.id);
    leads.learnFromEvent(companyId, lead, 'unsubscribed');
  } else if (classification !== 'out_of_office') {
    const result = classification === 'not_interested' ? 'said_no' : ['interested', 'meeting_request'].includes(classification) ? 'interested' : 'replied';
    outreach.recordAttempt(companyId, null, {
      leadId: lead.id, method: 'email_dm', channel: 'email', direction: 'inbound', result,
      reasonCategory: result === 'said_no' ? 'no_need' : undefined, message: body.slice(0, 2000), occurredAt: receivedAt
    });
    // A human (or the bot) now owes them a reply - pause the automatic cadence.
    if (result !== 'said_no') cadence.stop(lead.id);
  }

  notifications.notify({
    companyId, type: 'email_reply', leadId: lead.id,
    title: `${name} replied (${classification.replace(/_/g, ' ')})`, body: body.slice(0, 160)
  });

  let autoReply = null;
  const { autoReplyMode } = getSettings(companyId);
  if (autoReplyMode !== 'off' && AUTO_REPLY_CLASSES.includes(classification)) {
    const draft = await draftAutoReply(companyId, lead, { subject: msg.subject, body });
    if (autoReplyMode === 'send') {
      autoReply = await bulkEmail.sendOne(companyId, null, { leadId: lead.id, subject: draft.subject, body: draft.body, mode: 'auto_reply', inReplyTo: msg.messageId, automated: true });
    } else {
      const draftId = uuid();
      db.prepare(`INSERT INTO email_messages (id, company_id, lead_id, direction, to_addr, subject, body, in_reply_to, status, mode, auto_generated)
        VALUES (?, ?, ?, 'outbound', ?, ?, ?, ?, 'draft', 'auto_reply', 1)`).run(draftId, companyId, lead.id, lead.email, draft.subject, draft.body, msg.messageId || null);
      notifications.notify({ companyId, type: 'auto_reply_draft', leadId: lead.id, title: `AI drafted a reply to ${name}`, body: 'Review and send it from the inbox.' });
      autoReply = { status: 'draft', emailId: draftId };
    }
  } else if (!['out_of_office', 'unsubscribe', 'not_interested'].includes(classification)) {
    tasksService.createTask(companyId, { leadId: lead.id, title: `Reply to ${name}`, description: body.slice(0, 500), priority: 'high', dueAt: new Date(Date.now() + 4 * 3600000).toISOString(), createdBy: 'ai_assistant' });
  }
  return { emailId: id, matched: true, leadId: lead.id, companyId, classification, autoReply };
}

/** Send (optionally edited) an AI draft reply. */
async function sendDraft(companyId, userId, emailId, { subject, body } = {}) {
  const draft = db.prepare("SELECT * FROM email_messages WHERE id = ? AND company_id = ? AND status = 'draft'").get(emailId, companyId);
  if (!draft) return null;
  const result = await bulkEmail.sendOne(companyId, userId, {
    leadId: draft.lead_id, subject: subject || draft.subject, body: body || draft.body, mode: 'auto_reply', inReplyTo: draft.in_reply_to
  });
  if (result.status === 'sent') db.prepare('DELETE FROM email_messages WHERE id = ?').run(emailId);
  return result;
}

function discardDraft(companyId, emailId) {
  return db.prepare("DELETE FROM email_messages WHERE id = ? AND company_id = ? AND status = 'draft'").run(emailId, companyId).changes > 0;
}

function listInbox(companyId, { limit = 100 } = {}) {
  return db.prepare(`
    SELECT e.*, l.company_name, l.contact_name FROM email_messages e LEFT JOIN leads l ON l.id = e.lead_id
    WHERE e.company_id = ? AND (e.direction = 'inbound' OR e.status = 'draft')
    ORDER BY COALESCE(e.received_at, e.created_at) DESC LIMIT ?
  `).all(companyId, Number(limit));
}

/** Normalise the common inbound-email webhook payloads into one shape. */
function normalizeWebhookPayload(body = {}) {
  const header = (name) => {
    const list = body.Headers || body.headers;
    if (Array.isArray(list)) return (list.find(h => (h.Name || h.name || '').toLowerCase() === name.toLowerCase()) || {}).Value;
    return undefined;
  };
  return {
    from: body.from || body.From || body.sender || body.FromFull?.Email,
    to: body.to || body.To || body.recipient,
    subject: body.subject || body.Subject,
    text: body.text || body.TextBody || body['body-plain'] || body['stripped-text'] || body.body || '',
    messageId: body.messageId || body.MessageID || body['Message-Id'] || header('Message-ID'),
    inReplyTo: body.inReplyTo || body['In-Reply-To'] || header('In-Reply-To'),
    receivedAt: body.receivedAt || body.Date || body.timestamp
  };
}

module.exports = { processInbound, sendDraft, discardDraft, listInbox, normalizeWebhookPayload, heuristicClassify, extractAddress, scopeFor };
