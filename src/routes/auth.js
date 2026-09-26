const express = require('express');
const { v4: uuid } = require('uuid');
const { db } = require('../db/database');
const { hashPassword, verifyPassword, signToken } = require('../services/authService');
const workspaces = require('../services/workspaceService');
const documents = require('../services/documentService');
const notifications = require('../services/notificationService');
const { requireAuth } = require('../middleware/auth');

const router = express.Router();

/** Resolve which agency a self-registering client belongs to. */
function resolveAgency(agencyCode) {
  if (agencyCode) {
    return db.prepare("SELECT id, name FROM companies WHERE kind = 'agency' AND (slug = ? OR id = ?)").get(agencyCode, agencyCode) || undefined;
  }
  const agencies = db.prepare("SELECT id, name FROM companies WHERE kind = 'agency' ORDER BY created_at ASC LIMIT 2").all();
  return agencies.length === 1 ? agencies[0] : null;
}

/**
 * POST /api/auth/register
 * One call: creates the workspace (an agency such as Chunguza, or a client
 * company X that hired the agency), reads the uploaded business profile,
 * runs the AI setup (profile, value pyramid in local currency, growth
 * plan), creates the owner account and returns a session token.
 *
 * body: { accountType: 'agency'|'client', companyName, description, industry?, website?,
 *         homeCountry?, homeCity?, targetMarket?: 'b2b'|'b2c', services?: string[], adPlatform?,
 *         agencyCode?, baselineCustomerCount?, businessProfile?: { filename, base64 },
 *         ownerName, email, password }
 */
router.post('/register', async (req, res) => {
  try {
    const b = req.body || {};
    const { companyName, description, ownerName, email, password } = b;
    if (!companyName || !description || !ownerName || !email || !password) {
      return res.status(400).json({ error: 'companyName, description, ownerName, email and password are required' });
    }
    if (password.length < 8) return res.status(400).json({ error: 'password must be at least 8 characters' });
    const addr = String(email).toLowerCase().trim();
    if (db.prepare('SELECT id FROM users WHERE email = ?').get(addr)) return res.status(409).json({ error: 'An account with this email already exists' });

    const kind = b.accountType === 'client' ? 'client' : 'agency';
    if (kind === 'agency' && process.env.ALLOW_AGENCY_SIGNUP === 'false' && db.prepare("SELECT 1 FROM companies WHERE kind = 'agency'").get()) {
      return res.status(403).json({ error: 'Agency sign-up is closed on this platform. Register as a client company instead.' });
    }
    let agency = null;
    if (kind === 'client') {
      agency = resolveAgency(b.agencyCode);
      if (agency === undefined) return res.status(400).json({ error: 'Agency code not recognised - ask your agency for its signup link.' });
    }

    let profile = null;
    if (b.businessProfile && b.businessProfile.base64) {
      try { profile = await documents.extractText(b.businessProfile); }
      catch (err) { return res.status(400).json({ error: `Business profile: ${err.message}` }); }
    }

    const companyId = workspaces.insertCompany({
      name: companyName, description, industry: b.industry, website: b.website, homeCountry: b.homeCountry, homeCity: b.homeCity,
      kind, agencyId: agency ? agency.id : null, targetMarket: b.targetMarket, services: b.services, adPlatform: b.adPlatform,
      baselineCustomerCount: b.baselineCustomerCount, clientStatus: 'onboarding',
      businessProfileText: profile ? profile.text : null, businessProfileFilename: profile ? b.businessProfile.filename : null
    });
    await workspaces.buildAi(companyId);

    const userId = uuid();
    db.prepare('INSERT INTO users (id, company_id, name, email, password_hash, role) VALUES (?, ?, ?, ?, ?, ?)')
      .run(userId, companyId, ownerName, addr, await hashPassword(password), 'owner');

    if (agency) {
      notifications.notify({ companyId: agency.id, type: 'inbound_lead', title: `${companyName} registered as a client`, body: 'Their workspace is set up - review their value pyramid and growth plan.' });
    }

    const token = signToken({ userId, companyId, role: 'owner' });
    res.status(201).json({
      token,
      user: { id: userId, name: ownerName, email: addr, role: 'owner' },
      company: workspaces.getWorkspace(companyId),
      agency: agency ? { id: agency.id, name: agency.name } : null,
      businessProfile: profile ? { filename: b.businessProfile.filename, chars: profile.chars, pages: profile.pages } : null
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

/** POST /api/auth/login  body: { email, password } */
router.post('/login', async (req, res) => {
  try {
    const { email, password } = req.body || {};
    if (!email || !password) return res.status(400).json({ error: 'email and password are required' });

    const user = db.prepare('SELECT * FROM users WHERE email = ?').get(String(email).toLowerCase().trim());
    if (!user) return res.status(401).json({ error: 'Invalid email or password' });

    const ok = await verifyPassword(password, user.password_hash);
    if (!ok) return res.status(401).json({ error: 'Invalid email or password' });

    const token = signToken({ userId: user.id, companyId: user.company_id, role: user.role });
    res.json({ token, user: { id: user.id, name: user.name, email: user.email, role: user.role, companyId: user.company_id } });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

/** GET /api/auth/me - current user, home company and the workspaces they can open */
router.get('/me', requireAuth, (req, res) => {
  const user = db.prepare('SELECT id, name, email, role FROM users WHERE id = ?').get(req.auth.userId);
  const company = workspaces.getWorkspace(req.auth.homeCompanyId);
  res.json({ user, company, isAgencyUser: req.auth.isAgencyUser, workspaces: workspaces.listForUser(req.auth.homeCompanyId) });
});

/** GET /api/auth/agency/:code - public: confirm a client signup link's agency before registering */
router.get('/agency/:code', (req, res) => {
  const agency = db.prepare("SELECT name FROM companies WHERE kind = 'agency' AND slug = ?").get(req.params.code);
  if (!agency) return res.status(404).json({ error: 'Agency not found' });
  res.json({ name: agency.name });
});

module.exports = router;
