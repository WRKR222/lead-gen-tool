const express = require('express');
const { db } = require('../db/database');
const { requireAuth, requireRole } = require('../middleware/auth');
const { getDirections, setDirections, getSettings, setSettings } = require('../services/directionsService');
const workspaces = require('../services/workspaceService');
const documents = require('../services/documentService');
const valuePyramid = require('../services/valuePyramidService');
const { isPublicHttpsUrl } = require('../services/integrationsService');
const { currencyForCountry } = require('../config/currencies');

const router = express.Router();
router.use(requireAuth);

// Every route here acts on the resolved workspace (req.auth.companyId) - the
// user's own company, or a client workspace an agency user switched into.

/** GET /api/companies/me - full workspace record incl. directions, value pyramid, growth plan, settings */
router.get('/me', (req, res) => {
  res.json(workspaces.getWorkspace(req.auth.companyId));
});

/**
 * PUT /api/companies/me - update identity fields. Pass regenerate: true (or
 * regenerateProfile: true) to re-run the AI setup against the new details.
 */
router.put('/me', requireRole('owner', 'admin'), async (req, res) => {
  try {
    const b = req.body || {};
    const current = db.prepare('SELECT * FROM companies WHERE id = ?').get(req.auth.companyId);
    const country = (b.homeCountry ?? current.home_country ?? 'KE').toUpperCase();
    db.prepare(`
      UPDATE companies SET name = ?, description = ?, industry = ?, website = ?, home_country = ?, home_city = ?, currency = ?,
        target_market = ?, services_json = ?, ad_platform = ?, updated_at = datetime('now')
      WHERE id = ?
    `).run(
      b.name ?? current.name, b.description ?? current.description, b.industry ?? current.industry, b.website ?? current.website,
      country, b.homeCity ?? current.home_city, b.currency || (b.homeCountry ? currencyForCountry(country) : current.currency),
      b.targetMarket ? (b.targetMarket === 'b2c' ? 'b2c' : 'b2b') : current.target_market,
      b.services ? JSON.stringify(workspaces.cleanServices(b.services)) : current.services_json,
      b.adPlatform !== undefined ? workspaces.cleanPlatform(b.adPlatform) : current.ad_platform,
      req.auth.companyId
    );
    if (b.regenerate || b.regenerateProfile) await workspaces.buildAi(req.auth.companyId);
    res.json(workspaces.getWorkspace(req.auth.companyId));
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

/** POST /api/companies/me/regenerate  body: { parts?: ['profile','pyramid','plan'] } */
router.post('/me/regenerate', requireRole('owner', 'admin'), async (req, res) => {
  try {
    const parts = Array.isArray(req.body?.parts) && req.body.parts.length ? req.body.parts : ['profile', 'pyramid', 'plan'];
    await workspaces.buildAi(req.auth.companyId, parts);
    res.json(workspaces.getWorkspace(req.auth.companyId));
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

/** Kept for older clients: POST /api/companies/me/regenerate-profile */
router.post('/me/regenerate-profile', requireRole('owner', 'admin'), async (req, res) => {
  try {
    const { directions } = await workspaces.buildAi(req.auth.companyId, ['profile']);
    res.json({ ok: true, directions });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

/**
 * POST /api/companies/me/business-profile - upload a Word (.docx) or PDF
 * business profile; its text feeds every AI generation. Re-runs the AI
 * setup unless reanalyze: false.  body: { filename, base64, reanalyze? }
 */
router.post('/me/business-profile', requireRole('owner', 'admin'), async (req, res) => {
  try {
    const { filename, base64, reanalyze = true } = req.body || {};
    const extracted = await documents.extractText({ filename, base64 });
    db.prepare(`UPDATE companies SET business_profile_text = ?, business_profile_filename = ?, business_profile_uploaded_at = ?, updated_at = datetime('now') WHERE id = ?`)
      .run(extracted.text, filename, new Date().toISOString(), req.auth.companyId);
    if (reanalyze) await workspaces.buildAi(req.auth.companyId);
    res.json({ ok: true, filename, chars: extracted.chars, pages: extracted.pages, method: extracted.method, preview: extracted.text.slice(0, 600), workspace: workspaces.getWorkspace(req.auth.companyId) });
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

/** GET /api/companies/me/value-pyramid */
router.get('/me/value-pyramid', (req, res) => {
  res.json(workspaces.getWorkspace(req.auth.companyId).value_pyramid);
});

/** PUT /api/companies/me/value-pyramid - save edited tiers/prices; derived values are recomputed */
router.put('/me/value-pyramid', requireRole('owner', 'admin'), (req, res) => {
  const b = req.body || {};
  if (!Array.isArray(b.tiers) || !b.tiers.length) return res.status(400).json({ error: 'tiers[] is required' });
  const current = db.prepare('SELECT currency FROM companies WHERE id = ?').get(req.auth.companyId);
  const pyramid = valuePyramid.compute({ ...b, currency: b.currency || current.currency, _generatedBy: 'edited' });
  db.prepare("UPDATE companies SET value_pyramid_json = ?, currency = ?, updated_at = datetime('now') WHERE id = ?").run(JSON.stringify(pyramid), pyramid.currency, req.auth.companyId);
  db.prepare("UPDATE leads SET estimated_value = ? WHERE company_id = ? AND status NOT IN ('closed_won','closed_lost')").run(pyramid.valuePerLead, req.auth.companyId);
  res.json(pyramid);
});

/** GET /api/companies/me/settings */
router.get('/me/settings', (req, res) => {
  const c = db.prepare('SELECT inbound_token, slug, kind FROM companies WHERE id = ?').get(req.auth.companyId);
  res.json({ ...getSettings(req.auth.companyId), inboundToken: c.inbound_token, slug: c.slug, kind: c.kind });
});

/** PUT /api/companies/me/settings - auto-reply mode, auto follow-ups, booking link, targets, cadence, integrations */
router.put('/me/settings', requireRole('owner', 'admin'), (req, res) => {
  const b = req.body || {};
  const patch = {};
  if (b.autoReplyMode !== undefined) {
    if (!['off', 'draft', 'send'].includes(b.autoReplyMode)) return res.status(400).json({ error: 'autoReplyMode must be off, draft or send' });
    patch.autoReplyMode = b.autoReplyMode;
  }
  if (b.autoFollowUpEmails !== undefined) patch.autoFollowUpEmails = !!b.autoFollowUpEmails;
  if (b.bookingLink !== undefined) {
    if (b.bookingLink && !/^https?:\/\//i.test(b.bookingLink)) return res.status(400).json({ error: 'bookingLink must start with http(s)://' });
    patch.bookingLink = b.bookingLink || '';
  }
  for (const k of ['monthlyLeadTarget', 'monthlyMeetingTarget']) if (b[k] !== undefined) patch[k] = Math.max(0, Number(b[k]) || 0);
  if (b.cadence) {
    const c = b.cadence;
    patch.cadence = {};
    if (Array.isArray(c.intervalsDays)) patch.cadence.intervalsDays = c.intervalsDays.map(Number).filter(n => n >= 1 && n <= 365).slice(0, 10);
    for (const k of ['maxAttempts', 'minHoursBetweenTouches', 'maxTouchesPer30Days', 'nurtureIntervalDays']) if (c[k] !== undefined) patch.cadence[k] = Math.max(1, Number(c[k]) || 1);
    if (patch.cadence.intervalsDays && !patch.cadence.intervalsDays.length) delete patch.cadence.intervalsDays;
  }
  if (b.highlevel) patch.highlevel = { enabled: !!b.highlevel.enabled, locationId: String(b.highlevel.locationId || '').trim() };
  if (b.appointwise) {
    const url = String(b.appointwise.webhookUrl || '').trim();
    if (url && !isPublicHttpsUrl(url)) return res.status(400).json({ error: 'Appointwise webhook URL must be a public https:// URL' });
    patch.appointwise = { enabled: !!b.appointwise.enabled, webhookUrl: url };
  }
  res.json(setSettings(req.auth.companyId, patch));
});

/** GET /api/companies/me/directions - the ICP/geo/scoring/outreach/brand config driving every module */
router.get('/me/directions', (req, res) => {
  res.json(getDirections(req.auth.companyId));
});

/** PUT /api/companies/me/directions - hand-edit the directions JSON directly (power users) */
router.put('/me/directions', requireRole('owner', 'admin'), (req, res) => {
  const body = req.body;
  const required = ['idealCustomerProfile', 'geoStrategy', 'scoring', 'outreach'];
  for (const key of required) {
    if (!body[key]) return res.status(400).json({ error: `missing "${key}" section` });
  }
  const directions = setDirections(req.auth.companyId, body);
  res.json({ ok: true, directions });
});

module.exports = router;
