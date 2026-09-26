/**
 * Lead records and their contact points - shared by discovery, import,
 * manual entry, inbound webhooks, outreach and the AI assistant.
 */
const { v4: uuid } = require('uuid');
const { db } = require('../db/database');
const scoring = require('./leadScoring');
const { getDirections } = require('./directionsService');
const { CONTACT_CHANNELS } = require('../config/playbook');

function getLeadRow(companyId, leadId) {
  return db.prepare('SELECT * FROM leads WHERE id = ? AND company_id = ?').get(leadId, companyId);
}

/** camelCase shape the AI/generation services expect. */
function toLeadShape(l) {
  return {
    id: l.id, leadType: l.lead_type || 'business', companyName: l.company_name, contactName: l.contact_name, title: l.title,
    email: l.email, phone: l.phone, industry: l.industry, city: l.city, country: l.country, address: l.address,
    website: l.website, companySize: l.company_size, status: l.status, score: l.score, notes: l.notes
  };
}

function displayName(l) {
  return l.company_name || l.contact_name || 'Unnamed lead';
}

function listContacts(leadId) {
  return db.prepare('SELECT * FROM lead_contacts WHERE lead_id = ? ORDER BY is_primary DESC, created_at ASC').all(leadId);
}

function normalizeChannel(channel) {
  const c = String(channel || '').toLowerCase().trim();
  if (c === 'twitter') return 'x';
  if (c === 'mobile' || c === 'tel') return 'phone';
  return CONTACT_CHANNELS.includes(c) ? c : 'other';
}

function addContact(companyId, leadId, { channel, value, personName, personRole, isDecisionMaker, isPrimary, source }) {
  if (!value || !String(value).trim()) throw new Error('contact value is required');
  const ch = normalizeChannel(channel);
  const v = String(value).trim();
  const dup = db.prepare('SELECT id FROM lead_contacts WHERE lead_id = ? AND channel = ? AND lower(value) = lower(?)').get(leadId, ch, v);
  if (dup) return db.prepare('SELECT * FROM lead_contacts WHERE id = ?').get(dup.id);
  const id = uuid();
  db.prepare(`INSERT INTO lead_contacts (id, company_id, lead_id, channel, value, person_name, person_role, is_decision_maker, is_primary, source)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
    .run(id, companyId, leadId, ch, v, personName || null, personRole || null, isDecisionMaker ? 1 : 0, isPrimary ? 1 : 0, source || 'manual');
  // Keep the quick-access columns filled so lists, dedupe and email sending still work.
  const lead = db.prepare('SELECT email, phone, linkedin_url, website, address FROM leads WHERE id = ?').get(leadId);
  const column = { email: 'email', phone: 'phone', linkedin: 'linkedin_url', website: 'website', address: 'address' }[ch];
  if (column && !lead[column]) db.prepare(`UPDATE leads SET ${column} = ? WHERE id = ?`).run(v, leadId);
  return db.prepare('SELECT * FROM lead_contacts WHERE id = ?').get(id);
}

function removeContact(companyId, leadId, contactId) {
  return db.prepare('DELETE FROM lead_contacts WHERE id = ? AND lead_id = ? AND company_id = ?').run(contactId, leadId, companyId).changes > 0;
}

/** Expected value of one lead, from the workspace's value pyramid. */
function valuePerLead(companyId) {
  const row = db.prepare('SELECT value_pyramid_json FROM companies WHERE id = ?').get(companyId);
  try { return JSON.parse(row.value_pyramid_json || 'null')?.valuePerLead || null; } catch { return null; }
}

/**
 * Create one lead with any number of contact points.
 * @param {object} data - camelCase lead fields + contacts: [{channel, value, personName, personRole, isDecisionMaker}]
 */
function createLead(companyId, data, { source = 'manual', geoScope = null, geoTier = null } = {}) {
  const leadType = data.leadType === 'person' ? 'person' : 'business';
  if (leadType === 'business' && !data.companyName) throw new Error('companyName is required for a business lead');
  if (leadType === 'person' && !data.contactName) throw new Error('contactName is required for a person lead');
  const directions = getDirections(companyId);
  const lead = {
    id: uuid(), companyId, leadType,
    companyName: data.companyName || null, contactName: data.contactName || null, title: data.title || null,
    email: data.email || null, phone: data.phone || null, linkedinUrl: data.linkedinUrl || null,
    website: data.website || null, address: data.address || null,
    country: data.country || null, region: data.region || null, city: data.city || null,
    latitude: data.latitude ?? null, longitude: data.longitude ?? null,
    industry: data.industry || null, companySize: data.companySize || null,
    source: data.source || source, geoTier: data.geoTier ?? geoTier, geoScope: data.geoScope || geoScope,
    notes: data.notes || null, estimatedValue: valuePerLead(companyId)
  };
  lead.score = scoring.scoreLead(lead, directions, companyId);
  db.prepare(`
    INSERT INTO leads (id, company_id, lead_type, company_name, contact_name, title, email, phone, linkedin_url, website, address,
      country, region, city, latitude, longitude, industry, company_size, source, geo_tier, geo_scope, score, status, notes, estimated_value)
    VALUES (@id, @companyId, @leadType, @companyName, @contactName, @title, @email, @phone, @linkedinUrl, @website, @address,
      @country, @region, @city, @latitude, @longitude, @industry, @companySize, @source, @geoTier, @geoScope, @score, 'new', @notes, @estimatedValue)
  `).run(lead);

  const contacts = [...(data.contacts || [])];
  // Explicitly labelled contacts (e.g. "Main line / reception") win over the auto-attributed quick fields.
  const explicit = new Set(contacts.map(c => `${normalizeChannel(c.channel)}|${String(c.value || '').toLowerCase().trim()}`));
  const decisionMaker = { personName: data.contactName, personRole: data.title, isDecisionMaker: !!data.contactName };
  for (const [channel, value] of [['email', lead.email], ['phone', lead.phone], ['linkedin', lead.linkedinUrl], ['website', lead.website], ['address', lead.address]]) {
    if (value && !explicit.has(`${channel}|${String(value).toLowerCase().trim()}`)) {
      contacts.unshift({ channel, value, ...(['website', 'address'].includes(channel) ? {} : decisionMaker), isPrimary: true });
    }
  }
  for (const [channel, value] of Object.entries(data.socials || {})) {
    if (value) contacts.push({ channel, value });
  }
  for (const c of contacts) {
    try { addContact(companyId, lead.id, { source: lead.source, ...c }); } catch { /* skip empty contact values */ }
  }
  return getLeadRow(companyId, lead.id);
}

/** Everything about one lead, for the clickable lead view. */
function leadDetail(companyId, leadId) {
  const lead = getLeadRow(companyId, leadId);
  if (!lead) return null;
  const parse = (j) => { try { return JSON.parse(j); } catch { return null; } };
  return {
    ...lead,
    preferred_methods: parse(lead.preferred_methods_json) || [],
    contacts: listContacts(leadId),
    attempts: db.prepare('SELECT * FROM outreach_attempts WHERE lead_id = ? ORDER BY occurred_at DESC').all(leadId)
      .map(a => ({ ...a, standards: parse(a.standards_json) })),
    emails: db.prepare('SELECT * FROM email_messages WHERE lead_id = ? ORDER BY COALESCE(sent_at, received_at, created_at) DESC').all(leadId),
    meetings: db.prepare('SELECT * FROM meetings WHERE lead_id = ? ORDER BY start_at DESC').all(leadId)
      .map(m => ({ ...m, cps_brief: parse(m.cps_brief_json), cps_notes: parse(m.cps_notes_json) })),
    tasks: db.prepare('SELECT * FROM tasks WHERE lead_id = ? ORDER BY created_at DESC').all(leadId),
    calls: db.prepare('SELECT id, outcome, notes, created_at FROM calls WHERE lead_id = ? ORDER BY created_at DESC').all(leadId)
  };
}

/**
 * Feed an outcome into this workspace's self-improving scorer.
 * Returns the lead's new score (or null when the event carries no signal).
 */
function learnFromEvent(companyId, lead, eventType, notes) {
  const directions = getDirections(companyId);
  db.prepare('INSERT INTO feedback_events (id, company_id, lead_id, event_type, notes) VALUES (?, ?, ?, ?, ?)')
    .run(uuid(), companyId, lead.id, eventType, notes || null);
  const label = scoring.labelForEvent(eventType, directions);
  if (label === null) return null;
  const { newScore } = scoring.updateFromFeedback(
    { ...lead, companyName: lead.company_name, geoTier: lead.geo_tier, companySize: lead.company_size }, directions, label, companyId);
  db.prepare('UPDATE leads SET score = ? WHERE id = ?').run(newScore, lead.id);
  return newScore;
}

// Statuses that should never be moved backwards by a routine attempt.
const STATUS_RANK = { new: 0, contacted: 1, no_response: 1, replied: 2, on_fence: 3, opportunity: 3, meeting_booked: 4, closed_won: 5, closed_lost: 5, bounced: 5, unsubscribed: 5, spam: 5 };

function advanceStatus(leadId, status) {
  const lead = db.prepare('SELECT status FROM leads WHERE id = ?').get(leadId);
  if (!lead || !status) return;
  const terminal = ['closed_won', 'closed_lost', 'bounced', 'unsubscribed', 'spam'];
  const forward = (STATUS_RANK[status] ?? 0) >= (STATUS_RANK[lead.status] ?? 0);
  if (terminal.includes(status) || (forward && !terminal.includes(lead.status))) {
    db.prepare("UPDATE leads SET status = ?, updated_at = datetime('now') WHERE id = ?").run(status, leadId);
  }
}

module.exports = {
  getLeadRow, toLeadShape, displayName, listContacts, addContact, removeContact, createLead, leadDetail,
  learnFromEvent, advanceStatus, valuePerLead, normalizeChannel
};
