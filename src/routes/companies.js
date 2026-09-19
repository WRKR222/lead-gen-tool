const express = require('express');
const { db } = require('../db/database');
const { requireAuth, requireRole } = require('../middleware/auth');
const { generateCompanyProfile } = require('../services/companyProfileService');
const { getDirections, setDirections } = require('../services/directionsService');

const router = express.Router();
router.use(requireAuth);

/** GET /api/companies/me - full company record incl. directions */
router.get('/me', (req, res) => {
  const company = db.prepare('SELECT * FROM companies WHERE id = ?').get(req.auth.companyId);
  res.json({ ...company, directions: getDirections(req.auth.companyId) });
});

/**
 * PUT /api/companies/me - update core identity fields. Pass
 * regenerateProfile: true to also re-run AI profiling against the
 * (possibly updated) description - use this whenever the company's
 * positioning changes materially.
 */
router.put('/me', requireRole('owner', 'admin'), async (req, res) => {
  try {
    const { name, description, industry, website, homeCountry, homeCity, regenerateProfile } = req.body;
    const current = db.prepare('SELECT * FROM companies WHERE id = ?').get(req.auth.companyId);
    if (!current) return res.status(404).json({ error: 'company not found' });

    db.prepare(`
      UPDATE companies SET name = ?, description = ?, industry = ?, website = ?, home_country = ?, home_city = ?, updated_at = datetime('now')
      WHERE id = ?
    `).run(
      name ?? current.name, description ?? current.description, industry ?? current.industry,
      website ?? current.website, homeCountry ?? current.home_country, homeCity ?? current.home_city,
      req.auth.companyId
    );

    let directions = getDirections(req.auth.companyId);
    if (regenerateProfile) {
      directions = await generateCompanyProfile({
        name: name ?? current.name, description: description ?? current.description,
        industry: industry ?? current.industry, website: website ?? current.website,
        homeCountry: homeCountry ?? current.home_country, homeCity: homeCity ?? current.home_city
      });
      setDirections(req.auth.companyId, directions);
    }

    const updated = db.prepare('SELECT * FROM companies WHERE id = ?').get(req.auth.companyId);
    res.json({ ...updated, directions });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

/** POST /api/companies/me/regenerate-profile - re-run AI profiling as-is (no field changes) */
router.post('/me/regenerate-profile', requireRole('owner', 'admin'), async (req, res) => {
  try {
    const c = db.prepare('SELECT * FROM companies WHERE id = ?').get(req.auth.companyId);
    const directions = await generateCompanyProfile({
      name: c.name, description: c.description, industry: c.industry,
      website: c.website, homeCountry: c.home_country, homeCity: c.home_city
    });
    setDirections(req.auth.companyId, directions);
    res.json({ ok: true, directions });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
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
