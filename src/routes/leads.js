const express = require('express');
const { v4: uuid } = require('uuid');
const { db } = require('../db/database');
const geo = require('../services/geoExpansion');
const scoring = require('../services/leadScoring');
const registry = require('../services/leadSourceRegistry');
const csvImport = require('../services/csvImportService');
const { getDirections } = require('../services/directionsService');
const { requireAuth } = require('../middleware/auth');

const router = express.Router();
router.use(requireAuth);

// In-memory auto-expansion tier state, per company, for this process. Move
// to a DB table if you need it to survive restarts or run across multiple
// instances.
const tierStateByCompany = new Map();

/**
 * POST /api/leads/discover
 * body: { geoScope?: 'nairobi'|'kenya'|'east_africa'|'africa'|'global', sources?: string[] }
 *
 * With `geoScope` given: searches exactly that scope, once, across every
 * enabled lead source (Clay, Explorium, web research, ...) in parallel -
 * this is what the dashboard's "Search: Nairobi / Kenya / East Africa /
 * Africa / Global" picker calls.
 *
 * Without `geoScope`: falls back to v1's auto-expansion behavior (home
 * country first, widening once a tier stops producing).
 */
router.post('/discover', async (req, res) => {
  try {
    const companyId = req.auth.companyId;
    const directions = getDirections(companyId);
    const { geoScope, sources } = req.body || {};

    let spec;
    if (geoScope) {
      const resolved = geo.resolveScope(geoScope, { homeCountry: directions.geoStrategy.homeCountry, homeCity: directions.geoStrategy.homeCity });
      spec = { tier: resolved.tierLabel, radiusKm: null, filters: resolved.filters, scopeUsed: geoScope };
    } else {
      const tierState = tierStateByCompany.get(companyId) || { tier: 1, currentRadiusKm: null };
      spec = geo.nextSearchSpec(directions.geoStrategy, tierState);
      spec.scopeUsed = 'auto';
    }

    const filters = {
      ...spec.filters,
      industries: directions.idealCustomerProfile.industries,
      companySizeMin: directions.idealCustomerProfile.companySizeMin,
      companySizeMax: directions.idealCustomerProfile.companySizeMax,
      titles: directions.idealCustomerProfile.targetTitles
    };

    const perSource = await registry.searchAll(filters, 25, sources || null);
    const merged = mergeResults(...perSource.flatMap(r => [r.businesses || [], r.prospects || []]));

    const insertStmt = db.prepare(`
      INSERT INTO leads (id, company_id, company_name, contact_name, title, email, phone, linkedin_url, country, region, city,
        latitude, longitude, industry, company_size, source, geo_tier, geo_scope, score, status)
      VALUES (@id, @companyId, @companyName, @contactName, @title, @email, @phone, @linkedinUrl, @country, @region, @city,
        @latitude, @longitude, @industry, @companySize, @source, @geoTier, @geoScope, @score, 'new')
    `);

    const stored = [];
    for (const lead of merged) {
      lead.geoTier = spec.tier;
      lead.score = scoring.scoreLead(lead, directions, companyId);
      const row = {
        id: uuid(), companyId, geoScope: spec.scopeUsed, linkedinUrl: lead.linkedinUrl || null,
        ...lead
      };
      insertStmt.run(row);
      stored.push(row);
    }

    if (!geoScope) {
      const avgScore = stored.length ? stored.reduce((s, l) => s + l.score, 0) / stored.length : 0;
      tierStateByCompany.set(companyId, {
        tier: spec.tier, currentRadiusKm: spec.radiusKm,
        lastTierResultCount: stored.length, lastTierAvgScore: avgScore
      });
    }

    const avgScore = stored.length ? stored.reduce((s, l) => s + l.score, 0) / stored.length : 0;
    res.json({
      scopeUsed: spec.scopeUsed, tierUsed: spec.tier, radiusKm: spec.radiusKm,
      sourcesQueried: perSource.map(r => r.source), leadsFound: stored.length, avgScore, leads: stored
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

/** GET /api/leads - list stored leads for this company, best score first */
router.get('/', (req, res) => {
  const { status, minScore = 0, limit = 100, geoScope } = req.query;
  let query = 'SELECT * FROM leads WHERE company_id = ? AND score >= ?';
  const params = [req.auth.companyId, Number(minScore)];
  if (status) { query += ' AND status = ?'; params.push(status); }
  if (geoScope) { query += ' AND geo_scope = ?'; params.push(geoScope); }
  query += ' ORDER BY score DESC LIMIT ?';
  params.push(Number(limit));
  res.json(db.prepare(query).all(...params));
});

/** GET /api/leads/sources - which lead sources are enabled on this deployment */
router.get('/sources', (req, res) => {
  res.json(registry.listSources());
});

/**
 * POST /api/leads/import - manual/CSV import.
 * body: { csvText: "company_name,contact_name,title,email,phone,..." }
 */
router.post('/import', (req, res) => {
  const { csvText } = req.body || {};
  if (!csvText) return res.status(400).json({ error: 'csvText is required' });

  const { leads, errors } = csvImport.parseLeadsCsv(csvText);
  const companyId = req.auth.companyId;
  const directions = getDirections(companyId);
  const insertStmt = db.prepare(`
    INSERT INTO leads (id, company_id, company_name, contact_name, title, email, phone, linkedin_url, country, region, city,
      industry, company_size, source, geo_tier, geo_scope, score, status)
    VALUES (@id, @companyId, @companyName, @contactName, @title, @email, @phone, @linkedinUrl, @country, @region, @city,
      @industry, @companySize, 'csv_import', NULL, 'csv_import', @score, 'new')
  `);

  const stored = [];
  for (const lead of leads) {
    const score = scoring.scoreLead(lead, directions, companyId);
    const row = { id: uuid(), companyId, score, ...lead };
    insertStmt.run(row);
    stored.push(row);
  }
  res.json({ imported: stored.length, errors, leads: stored });
});

/**
 * POST /api/leads/:id/feedback
 * body: { eventType: 'replied' | 'meeting_booked' | 'closed_won' | 'bounced' | ... }
 * This is the core of "improves over time" - every outcome retrains the
 * scoring model for THIS company.
 */
router.post('/:id/feedback', (req, res) => {
  const { eventType, notes } = req.body;
  const companyId = req.auth.companyId;
  const lead = db.prepare('SELECT * FROM leads WHERE id = ? AND company_id = ?').get(req.params.id, companyId);
  if (!lead) return res.status(404).json({ error: 'lead not found' });

  const directions = getDirections(companyId);
  const label = scoring.labelForEvent(eventType, directions);

  db.prepare('INSERT INTO feedback_events (id, company_id, lead_id, event_type, notes) VALUES (?, ?, ?, ?, ?)')
    .run(uuid(), companyId, lead.id, eventType, notes || null);

  let updateResult = null;
  if (label !== null) {
    updateResult = scoring.updateFromFeedback(
      { ...lead, geoTier: lead.geo_tier, companySize: lead.company_size },
      directions,
      label,
      companyId
    );
    db.prepare('UPDATE leads SET score = ?, status = ?, updated_at = datetime(\'now\') WHERE id = ?')
      .run(updateResult.newScore, eventType, lead.id);
  } else {
    db.prepare('UPDATE leads SET status = ?, updated_at = datetime(\'now\') WHERE id = ?').run(eventType, lead.id);
  }

  res.json({ ok: true, modelUpdated: label !== null, updateResult });
});

/** PATCH /api/leads/:id - free-form edits (notes, manual status change) */
router.patch('/:id', (req, res) => {
  const companyId = req.auth.companyId;
  const lead = db.prepare('SELECT * FROM leads WHERE id = ? AND company_id = ?').get(req.params.id, companyId);
  if (!lead) return res.status(404).json({ error: 'lead not found' });
  const { notes, status } = req.body || {};
  db.prepare('UPDATE leads SET notes = COALESCE(?, notes), status = COALESCE(?, status), updated_at = datetime(\'now\') WHERE id = ?')
    .run(notes ?? null, status ?? null, lead.id);
  res.json(db.prepare('SELECT * FROM leads WHERE id = ?').get(lead.id));
});

function mergeResults(...lists) {
  const byKey = new Map();
  for (const list of lists) {
    for (const item of list) {
      const key = (item.email || item.companyDomain || item.companyName || '').toLowerCase();
      if (!key) continue;
      const existing = byKey.get(key) || {};
      byKey.set(key, {
        companyName: item.companyName || existing.companyName || null,
        contactName: item.contactName || existing.contactName || null,
        title: item.title || existing.title || null,
        email: item.email || existing.email || null,
        phone: item.phone || existing.phone || null,
        linkedinUrl: item.linkedinUrl || existing.linkedinUrl || null,
        country: item.country || existing.country || null,
        region: item.region || existing.region || null,
        city: item.city || existing.city || null,
        latitude: item.latitude ?? existing.latitude ?? null,
        longitude: item.longitude ?? existing.longitude ?? null,
        industry: item.industry || existing.industry || null,
        companySize: item.companySize || existing.companySize || null,
        source: existing.source ? `${existing.source}+${item.source}` : item.source
      });
    }
  }
  return Array.from(byKey.values()).filter(l => l.companyName);
}

module.exports = router;
