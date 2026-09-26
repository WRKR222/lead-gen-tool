const express = require('express');
const { db } = require('../db/database');
const geo = require('../services/geoExpansion');
const registry = require('../services/leadSourceRegistry');
const csvImport = require('../services/csvImportService');
const documents = require('../services/documentService');
const leadsService = require('../services/leadsService');
const outreach = require('../services/outreachService');
const cadence = require('../services/cadenceService');
const workspaces = require('../services/workspaceService');
const { getDirections } = require('../services/directionsService');
const { requireAuth, requireRole } = require('../middleware/auth');

const router = express.Router();
router.use(requireAuth);

// In-memory auto-expansion tier state, per workspace, for this process.
const tierStateByCompany = new Map();

/**
 * Merge per-source results into one record per company (or per person),
 * keeping every contact point found - e.g. a business's main line AND its
 * decision maker's own number/email.
 */
function mergeResults(...lists) {
  const byKey = new Map();
  for (const list of lists) {
    for (const item of list) {
      const isPerson = item.leadType === 'person';
      const key = (isPerson ? (item.email || item.phone || item.contactName) : (item.companyDomain || item.domain || item.companyName) || '').toLowerCase();
      if (!key) continue;
      const e = byKey.get(key) || { contacts: [], socials: {}, sources: new Set() };
      const merged = {
        ...e,
        leadType: isPerson ? 'person' : (e.leadType || 'business'),
        companyName: e.companyName || item.companyName || null,
        contactName: e.contactName || item.contactName || null,
        title: e.title || item.title || null,
        email: e.email || item.email || null,
        phone: item.contactName ? (item.phone || e.phone || null) : (e.phone || item.phone || null),
        linkedinUrl: e.linkedinUrl || item.linkedinUrl || null,
        website: e.website || item.website || null,
        address: e.address || item.address || null,
        country: e.country || item.country || null, region: e.region || item.region || null, city: e.city || item.city || null,
        latitude: e.latitude ?? item.latitude ?? null, longitude: e.longitude ?? item.longitude ?? null,
        industry: e.industry || item.industry || null, companySize: e.companySize || item.companySize || null,
        socials: { ...(item.socials || {}), ...e.socials }
      };
      // A business-level phone (no named person) is kept as the main line.
      if (!isPerson && item.phone && !item.contactName && !merged.contacts.some(c => c.personRole === 'Main line / reception')) {
        merged.contacts.push({ channel: 'phone', value: item.phone, personRole: 'Main line / reception' });
      }
      merged.sources.add(item.source);
      byKey.set(key, merged);
    }
  }
  return Array.from(byKey.values())
    .filter(l => l.companyName || l.contactName)
    .map(l => ({ ...l, source: [...l.sources].filter(Boolean).join('+') || 'discovery' }));
}

/**
 * POST /api/leads/discover
 * body: { geoScope?: 'nairobi'|'kenya'|'east_africa'|'africa'|'global', sources?: string[], niche?: string }
 * `niche` overrides the ICP industries for a one-off sweep (e.g. "dentists") -
 * how the agency runs Stage 1 scattergun prospecting across industries.
 */
router.post('/discover', async (req, res) => {
  try {
    const companyId = req.auth.companyId;
    const directions = getDirections(companyId);
    const ws = db.prepare('SELECT target_market, kind FROM companies WHERE id = ?').get(companyId);
    const { geoScope, sources, niche } = req.body || {};

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
      industries: niche ? [String(niche).slice(0, 80)] : directions.idealCustomerProfile.industries,
      companySizeMin: directions.idealCustomerProfile.companySizeMin,
      companySizeMax: directions.idealCustomerProfile.companySizeMax,
      titles: directions.idealCustomerProfile.targetTitles,
      targetMarket: ws.kind === 'client' ? ws.target_market : 'b2b'
    };

    const perSource = await registry.searchAll(filters, 25, sources || null);
    const merged = mergeResults(...perSource.flatMap(r => [r.businesses || [], r.prospects || []]));

    const stored = db.transaction(() => merged.map(lead =>
      leadsService.createLead(companyId, lead, { source: lead.source, geoScope: spec.scopeUsed, geoTier: spec.tier })))();

    const avgScore = stored.length ? stored.reduce((s, l) => s + l.score, 0) / stored.length : 0;
    if (!geoScope) {
      tierStateByCompany.set(companyId, { tier: spec.tier, currentRadiusKm: spec.radiusKm, lastTierResultCount: stored.length, lastTierAvgScore: avgScore });
    }
    res.json({ scopeUsed: spec.scopeUsed, tierUsed: spec.tier, radiusKm: spec.radiusKm, niche: niche || null, sourcesQueried: perSource.map(r => r.source), leadsFound: stored.length, avgScore, leads: stored });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

/** GET /api/leads - list this workspace's leads, best score first */
router.get('/', (req, res) => {
  const { status, minScore = 0, limit = 300, geoScope, q, followUpDue } = req.query;
  let query = 'SELECT * FROM leads WHERE company_id = ? AND score >= ?';
  const params = [req.auth.companyId, Number(minScore)];
  if (status) { query += ' AND status IN (' + String(status).split(',').map(() => '?').join(',') + ')'; params.push(...String(status).split(',')); }
  if (geoScope) { query += ' AND geo_scope = ?'; params.push(geoScope); }
  if (q) { query += ' AND (company_name LIKE ? OR contact_name LIKE ? OR email LIKE ? OR city LIKE ?)'; const like = `%${q}%`; params.push(like, like, like, like); }
  if (followUpDue === 'true') { query += ' AND next_follow_up_at IS NOT NULL AND next_follow_up_at <= ?'; params.push(new Date().toISOString()); }
  query += ' ORDER BY score DESC LIMIT ?';
  params.push(Math.min(Number(limit) || 300, 1000));
  res.json(db.prepare(query).all(...params));
});

/** GET /api/leads/sources - which lead sources are enabled on this deployment */
router.get('/sources', (req, res) => {
  res.json(registry.listSources());
});

/**
 * POST /api/leads - add one lead by hand (a business or a person).
 * body: { leadType?, companyName?, contactName?, title?, email?, phone?, website?, address?, city?, country?,
 *         industry?, notes?, socials?: {whatsapp, instagram, ...}, contacts?: [{channel, value, personName, personRole, isDecisionMaker}] }
 */
router.post('/', (req, res) => {
  try {
    res.status(201).json(leadsService.createLead(req.auth.companyId, req.body || {}, { source: 'manual' }));
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

/**
 * POST /api/leads/import - bring in a lead list: pasted CSV (csvText) or an
 * uploaded Excel/CSV file ({ filename, base64 }) from a scraping tool,
 * Google sweep, ad lead-form export or CRM.
 */
router.post('/import', (req, res) => {
  try {
    const { csvText, filename, base64 } = req.body || {};
    if (!csvText && !base64) return res.status(400).json({ error: 'csvText or a file (filename + base64) is required' });
    const { rows } = documents.parseSpreadsheet(csvText ? { text: csvText } : { filename, base64 });
    const errors = [];
    const stored = db.transaction(() => rows.map((row, i) => {
      const lead = csvImport.mapLeadRow(row);
      if (!lead.companyName && !lead.contactName) { errors.push(`Row ${i + 2}: needs a company or contact name, skipped`); return null; }
      return leadsService.createLead(req.auth.companyId, lead, { source: 'import', geoScope: 'import' });
    }).filter(Boolean))();
    res.json({ imported: stored.length, errors, leads: stored });
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

/** GET /api/leads/:id - everything about one lead: contacts, attempts, emails, meetings, tasks */
router.get('/:id', (req, res) => {
  const detail = leadsService.leadDetail(req.auth.companyId, req.params.id);
  if (!detail) return res.status(404).json({ error: 'lead not found' });
  res.json(detail);
});

/** POST /api/leads/:id/contacts  body: { channel, value, personName?, personRole?, isDecisionMaker? } */
router.post('/:id/contacts', (req, res) => {
  if (!leadsService.getLeadRow(req.auth.companyId, req.params.id)) return res.status(404).json({ error: 'lead not found' });
  try {
    res.status(201).json(leadsService.addContact(req.auth.companyId, req.params.id, req.body || {}));
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

/** DELETE /api/leads/:id/contacts/:contactId */
router.delete('/:id/contacts/:contactId', (req, res) => {
  const ok = leadsService.removeContact(req.auth.companyId, req.params.id, req.params.contactId);
  if (!ok) return res.status(404).json({ error: 'contact not found' });
  res.json({ ok: true });
});

/**
 * POST /api/leads/:id/outcome
 * body: { outcome: 'converted'|'on_fence'|'said_no'|'no_response', reasonCategory?, reason?, tier?, value? }
 */
router.post('/:id/outcome', (req, res) => {
  try {
    res.json(outreach.setOutcome(req.auth.companyId, req.params.id, { ...(req.body || {}), userId: req.auth.userId }));
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

/**
 * POST /api/leads/:id/convert-to-client - Stage 2 done: an agency prospect
 * signed. Creates their client workspace (with AI setup).
 * body: { services?, adPlatform?, monthlyRetainer?, targetMarket?, description? }
 */
router.post('/:id/convert-to-client', requireRole('owner', 'admin'), async (req, res) => {
  if (req.auth.workspaceKind !== 'agency') return res.status(400).json({ error: 'Only agency prospects can become clients' });
  try {
    res.status(201).json(await workspaces.convertLeadToClient(req.auth.companyId, req.params.id, req.body || {}));
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

/** POST /api/leads/:id/follow-up  body: { paused: boolean } - pause/resume the automatic cadence for this lead */
router.post('/:id/follow-up', (req, res) => {
  if (!leadsService.getLeadRow(req.auth.companyId, req.params.id)) return res.status(404).json({ error: 'lead not found' });
  cadence.setPaused(req.auth.companyId, req.params.id, !!(req.body || {}).paused);
  res.json(leadsService.getLeadRow(req.auth.companyId, req.params.id));
});

/**
 * POST /api/leads/:id/feedback - log a raw outcome event (kept for the v2
 * API). Every event retrains this workspace's scoring model.
 */
router.post('/:id/feedback', (req, res) => {
  const { eventType, notes } = req.body || {};
  const lead = leadsService.getLeadRow(req.auth.companyId, req.params.id);
  if (!lead) return res.status(404).json({ error: 'lead not found' });
  const newScore = leadsService.learnFromEvent(req.auth.companyId, lead, eventType, notes);
  db.prepare("UPDATE leads SET status = ?, updated_at = datetime('now') WHERE id = ?").run(eventType, lead.id);
  res.json({ ok: true, modelUpdated: newScore !== null, newScore });
});

/** PATCH /api/leads/:id - edit lead fields */
router.patch('/:id', (req, res) => {
  const lead = leadsService.getLeadRow(req.auth.companyId, req.params.id);
  if (!lead) return res.status(404).json({ error: 'lead not found' });
  const b = req.body || {};
  const fields = { notes: 'notes', status: 'status', companyName: 'company_name', contactName: 'contact_name', title: 'title', industry: 'industry', city: 'city', country: 'country', address: 'address', website: 'website', leadType: 'lead_type' };
  const sets = []; const params = [];
  for (const [k, col] of Object.entries(fields)) if (b[k] !== undefined) { sets.push(`${col} = ?`); params.push(b[k] === '' ? null : b[k]); }
  if (sets.length) db.prepare(`UPDATE leads SET ${sets.join(', ')}, updated_at = datetime('now') WHERE id = ?`).run(...params, lead.id);
  res.json(leadsService.getLeadRow(req.auth.companyId, lead.id));
});

module.exports = router;
module.exports.mergeResults = mergeResults;
