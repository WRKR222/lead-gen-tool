const express = require('express');
const { v4: uuid } = require('uuid');
const { db } = require('../db/database');
const { hashPassword, verifyPassword, signToken } = require('../services/authService');
const { generateCompanyProfile } = require('../services/companyProfileService');
const { requireAuth } = require('../middleware/auth');

const router = express.Router();

function slugify(name) {
  return name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/(^-|-$)/g, '') + '-' + Math.random().toString(36).slice(2, 7);
}

/**
 * POST /api/auth/register
 * This IS the "company registers its name, explains in depth what it does
 * and what it wants from the tool" step. One call: creates the company,
 * runs AI profiling on the description to build its bespoke directions
 * (ICP, geo strategy, scoring, outreach tone, brand voice, sales
 * narrative), creates the owner user account, and returns a session token
 * - the frontend takes the user straight to the dashboard from here.
 *
 * body: { companyName, description, industry?, website?, homeCountry?,
 *         homeCity?, ownerName, email, password }
 */
router.post('/register', async (req, res) => {
  try {
    const { companyName, description, industry, website, homeCountry, homeCity, ownerName, email, password } = req.body;
    if (!companyName || !description || !ownerName || !email || !password) {
      return res.status(400).json({ error: 'companyName, description, ownerName, email and password are required' });
    }
    if (password.length < 8) return res.status(400).json({ error: 'password must be at least 8 characters' });

    const existing = db.prepare('SELECT id FROM users WHERE email = ?').get(email.toLowerCase());
    if (existing) return res.status(409).json({ error: 'An account with this email already exists' });

    const companyId = uuid();
    db.prepare(`
      INSERT INTO companies (id, name, slug, description, industry, website, home_country, home_city, onboarding_status)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'profiling')
    `).run(companyId, companyName, slugify(companyName), description, industry || null, website || null,
      homeCountry || 'KE', homeCity || 'Nairobi');

    // AI-personalize this company's entire directions profile right away -
    // this is what makes the dashboard/tool behave differently per company.
    const profile = await generateCompanyProfile({ name: companyName, description, industry, website, homeCountry, homeCity });
    db.prepare('UPDATE companies SET ai_profile_json = ?, onboarding_status = ? WHERE id = ?')
      .run(JSON.stringify(profile), 'ready', companyId);

    const userId = uuid();
    const passwordHash = await hashPassword(password);
    db.prepare('INSERT INTO users (id, company_id, name, email, password_hash, role) VALUES (?, ?, ?, ?, ?, ?)')
      .run(userId, companyId, ownerName, email.toLowerCase(), passwordHash, 'owner');

    // Per-company scorer/warm-up state starts fresh.
    db.prepare('INSERT OR IGNORE INTO model_weights (company_id, weights_json, samples_seen) VALUES (?, ?, 0)')
      .run(companyId, JSON.stringify({}));

    const token = signToken({ userId, companyId, role: 'owner' });
    const company = db.prepare('SELECT id, name, slug, description, industry, website, home_country, home_city, onboarding_status, ai_profile_json FROM companies WHERE id = ?').get(companyId);
    res.status(201).json({
      token,
      user: { id: userId, name: ownerName, email: email.toLowerCase(), role: 'owner' },
      company: { ...company, directions: JSON.parse(company.ai_profile_json) }
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

/** POST /api/auth/login  body: { email, password } */
router.post('/login', async (req, res) => {
  try {
    const { email, password } = req.body;
    if (!email || !password) return res.status(400).json({ error: 'email and password are required' });

    const user = db.prepare('SELECT * FROM users WHERE email = ?').get(email.toLowerCase());
    if (!user) return res.status(401).json({ error: 'Invalid email or password' });

    const ok = await verifyPassword(password, user.password_hash);
    if (!ok) return res.status(401).json({ error: 'Invalid email or password' });

    const token = signToken({ userId: user.id, companyId: user.company_id, role: user.role });
    res.json({ token, user: { id: user.id, name: user.name, email: user.email, role: user.role, companyId: user.company_id } });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

/** GET /api/auth/me - current user + company, for the frontend to restore a session */
router.get('/me', requireAuth, (req, res) => {
  const user = db.prepare('SELECT id, name, email, role FROM users WHERE id = ?').get(req.auth.userId);
  const company = db.prepare('SELECT id, name, slug, description, industry, website, home_country, home_city, onboarding_status, ai_profile_json FROM companies WHERE id = ?').get(req.auth.companyId);
  res.json({ user, company: { ...company, directions: JSON.parse(company.ai_profile_json || '{}') } });
});

module.exports = router;
