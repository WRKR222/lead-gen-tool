/**
 * AI tool integrations for appointment booking:
 *  - HighLevel (LeadConnector API v2): upsert leads as contacts in the
 *    client's sub-account (location), so its pipelines/calendars take over.
 *    Needs HIGHLEVEL_API_KEY (private integration token) + a location id
 *    (per workspace in Settings, or HIGHLEVEL_LOCATION_ID).
 *  - Appointwise: pushes leads to the workspace's Appointwise inbound
 *    webhook URL (or APPOINTWISE_WEBHOOK_URL) as JSON.
 * Without credentials both run in logged mock mode. Every push is recorded
 * in integration_events.
 *
 * BEFORE GOING LIVE: confirm endpoint paths/payload fields against each
 * vendor's current API docs - same caveat as clayService.js.
 */
const fetch = require('node-fetch');
const { v4: uuid } = require('uuid');
const { db } = require('../db/database');
const leads = require('./leadsService');
const { getSettings } = require('./directionsService');

const HIGHLEVEL_BASE = process.env.HIGHLEVEL_API_BASE || 'https://services.leadconnectorhq.com';

function log(companyId, leadId, provider, action, status, detail) {
  db.prepare('INSERT INTO integration_events (id, company_id, lead_id, provider, action, status, detail) VALUES (?, ?, ?, ?, ?, ?, ?)')
    .run(uuid(), companyId, leadId || null, provider, action, status, detail ? String(detail).slice(0, 1000) : null);
}

/** Only public https endpoints - the server must not be usable to reach internal hosts. */
function isPublicHttpsUrl(value) {
  let u;
  try { u = new URL(value); } catch { return false; }
  if (u.protocol !== 'https:') return false;
  const h = u.hostname.toLowerCase().replace(/^\[|\]$/g, '');
  if (h === 'localhost' || h.endsWith('.localhost') || h.endsWith('.local') || h.endsWith('.internal')) return false;
  if (/^(127\.|10\.|0\.|169\.254\.|192\.168\.|172\.(1[6-9]|2\d|3[01])\.)/.test(h)) return false;
  if (h === '::1' || /^f[cd][0-9a-f]{2}:/.test(h) || /^fe80:/.test(h)) return false;
  return true;
}

function splitName(full) {
  const parts = String(full || '').trim().split(/\s+/);
  return { firstName: parts[0] || '', lastName: parts.slice(1).join(' ') };
}

function status(companyId) {
  const s = getSettings(companyId);
  return {
    highlevel: { configured: !!(process.env.HIGHLEVEL_API_KEY && (s.highlevel.locationId || process.env.HIGHLEVEL_LOCATION_ID)), enabled: s.highlevel.enabled, locationId: s.highlevel.locationId || process.env.HIGHLEVEL_LOCATION_ID || '' },
    appointwise: { configured: !!(s.appointwise.webhookUrl || process.env.APPOINTWISE_WEBHOOK_URL), enabled: s.appointwise.enabled, webhookUrl: s.appointwise.webhookUrl || '' },
    recent: db.prepare('SELECT provider, action, status, detail, created_at FROM integration_events WHERE company_id = ? ORDER BY created_at DESC LIMIT 20').all(companyId)
  };
}

async function pushToHighLevel(companyId, lead, workspaceName) {
  const s = getSettings(companyId);
  const locationId = s.highlevel.locationId || process.env.HIGHLEVEL_LOCATION_ID;
  const token = process.env.HIGHLEVEL_API_KEY;
  const { firstName, lastName } = splitName(lead.contact_name || lead.company_name);
  const body = {
    locationId, firstName, lastName, name: lead.contact_name || lead.company_name, email: lead.email || undefined, phone: lead.phone || undefined,
    companyName: lead.company_name || undefined, website: lead.website || undefined, address1: lead.address || undefined, city: lead.city || undefined,
    country: lead.country || undefined, source: 'Chunguza lead platform', tags: ['chunguza', workspaceName, lead.status].filter(Boolean)
  };
  if (!token || !locationId) {
    log(companyId, lead.id, 'highlevel', 'upsert_contact', 'mock', 'No HIGHLEVEL_API_KEY / location id configured - nothing sent.');
    return { leadId: lead.id, status: 'mock' };
  }
  try {
    const res = await fetch(`${HIGHLEVEL_BASE}/contacts/upsert`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}`, Version: '2021-07-28', 'Content-Type': 'application/json', Accept: 'application/json' },
      body: JSON.stringify(body)
    });
    const text = await res.text();
    log(companyId, lead.id, 'highlevel', 'upsert_contact', res.ok ? 'ok' : 'error', `${res.status} ${text.slice(0, 300)}`);
    return { leadId: lead.id, status: res.ok ? 'ok' : 'error', httpStatus: res.status };
  } catch (err) {
    log(companyId, lead.id, 'highlevel', 'upsert_contact', 'error', err.message);
    return { leadId: lead.id, status: 'error', error: err.message };
  }
}

async function pushToAppointwise(companyId, lead, workspaceName) {
  const url = getSettings(companyId).appointwise.webhookUrl || process.env.APPOINTWISE_WEBHOOK_URL;
  const payload = {
    event: 'lead.push', source: 'chunguza', workspace: workspaceName,
    lead: { id: lead.id, type: lead.lead_type, name: lead.contact_name, company: lead.company_name, title: lead.title, email: lead.email, phone: lead.phone,
      city: lead.city, country: lead.country, status: lead.status, notes: lead.notes, contacts: leads.listContacts(lead.id).map(c => ({ channel: c.channel, value: c.value, person: c.person_name, role: c.person_role })) }
  };
  if (!url) {
    log(companyId, lead.id, 'appointwise', 'push_lead', 'mock', 'No Appointwise webhook URL configured - nothing sent.');
    return { leadId: lead.id, status: 'mock' };
  }
  if (!isPublicHttpsUrl(url)) {
    log(companyId, lead.id, 'appointwise', 'push_lead', 'error', 'Webhook URL must be a public https URL');
    return { leadId: lead.id, status: 'error', error: 'Webhook URL must be a public https URL' };
  }
  try {
    const res = await fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(payload), timeout: 15000 });
    log(companyId, lead.id, 'appointwise', 'push_lead', res.ok ? 'ok' : 'error', `${res.status}`);
    return { leadId: lead.id, status: res.ok ? 'ok' : 'error', httpStatus: res.status };
  } catch (err) {
    log(companyId, lead.id, 'appointwise', 'push_lead', 'error', err.message);
    return { leadId: lead.id, status: 'error', error: err.message };
  }
}

/** @param {'highlevel'|'appointwise'} provider */
async function push(companyId, provider, leadIds) {
  if (!Array.isArray(leadIds) || !leadIds.length) throw new Error('leadIds[] is required');
  const ws = db.prepare('SELECT name FROM companies WHERE id = ?').get(companyId);
  const fn = provider === 'highlevel' ? pushToHighLevel : provider === 'appointwise' ? pushToAppointwise : null;
  if (!fn) throw new Error('provider must be highlevel or appointwise');
  const results = [];
  for (const id of leadIds.slice(0, 200)) {
    const lead = leads.getLeadRow(companyId, id);
    if (lead) results.push(await fn(companyId, lead, ws.name));
  }
  return { provider, results };
}

module.exports = { push, status, isPublicHttpsUrl };
