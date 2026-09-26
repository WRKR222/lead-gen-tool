/**
 * Public webhooks (no login): each workspace has a secret inbound token,
 * shown in Settings, that authenticates these URLs.
 *
 *   POST /api/inbound/email/:token  - replies from leads (Postmark inbound,
 *        Mailgun routes, or any forwarder posting JSON/form fields)
 *   POST /api/inbound/lead/:token   - new leads from ad lead forms (Meta /
 *        TikTok via Zapier/Make, Google Ads lead-form webhook), website
 *        forms, or appointment tools
 */
const express = require('express');
const crypto = require('crypto');
const { db } = require('../db/database');
const inbox = require('../services/inboxService');
const leadsService = require('../services/leadsService');
const notifications = require('../services/notificationService');

const router = express.Router();
router.use(express.urlencoded({ extended: false, limit: '2mb' }));

function workspaceForToken(token) {
  if (!token || token.length < 16) return null;
  const rows = db.prepare('SELECT id, inbound_token FROM companies WHERE inbound_token IS NOT NULL').all();
  const given = Buffer.from(String(token));
  return rows.find(r => {
    const expected = Buffer.from(r.inbound_token);
    return expected.length === given.length && crypto.timingSafeEqual(expected, given);
  }) || null;
}

router.post('/email/:token', async (req, res) => {
  const ws = workspaceForToken(req.params.token);
  if (!ws) return res.status(404).json({ error: 'unknown inbound address' });
  try {
    const msg = inbox.normalizeWebhookPayload(req.body || {});
    if (!msg.from) return res.status(400).json({ error: 'from is required' });
    res.json(await inbox.processInbound(ws.id, msg));
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

/** Google Ads lead-form webhooks send user_column_data: [{ column_id, string_value }]. */
function fromGoogleLeadForm(body) {
  const cols = Object.fromEntries((body.user_column_data || []).map(c => [String(c.column_id || '').toUpperCase(), c.string_value]));
  return {
    contactName: cols.FULL_NAME || [cols.FIRST_NAME, cols.LAST_NAME].filter(Boolean).join(' ') || null,
    email: cols.EMAIL || null, phone: cols.PHONE_NUMBER || null, companyName: cols.COMPANY_NAME || null,
    city: cols.CITY || null, country: cols.COUNTRY || null, title: cols.JOB_TITLE || null, source: 'paid_ads:google_ads'
  };
}

router.post('/lead/:token', (req, res) => {
  const ws = workspaceForToken(req.params.token);
  if (!ws) return res.status(404).json({ error: 'unknown inbound address' });
  try {
    const b = req.body || {};
    const data = b.user_column_data ? fromGoogleLeadForm(b) : {
      companyName: b.companyName || b.company || null, contactName: b.contactName || b.name || b.full_name || null,
      title: b.title || null, email: b.email || null, phone: b.phone || b.phone_number || null, website: b.website || null,
      address: b.address || null, city: b.city || null, country: b.country || null, industry: b.industry || null, notes: b.notes || b.message || null,
      socials: b.socials || {}, source: b.source ? `inbound:${String(b.source).slice(0, 40)}` : 'inbound_webhook'
    };
    data.leadType = b.leadType === 'business' || data.companyName ? 'business' : 'person';
    const lead = leadsService.createLead(ws.id, data, { source: data.source, geoScope: 'inbound' });
    notifications.notify({ companyId: ws.id, type: 'inbound_lead', leadId: lead.id, title: `New lead: ${leadsService.displayName(lead)}`, body: `From ${data.source.replace('inbound:', '')}` });
    res.status(201).json({ ok: true, leadId: lead.id });
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

module.exports = router;
