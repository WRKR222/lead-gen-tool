const express = require('express');
const workspaces = require('../services/workspaceService');
const documents = require('../services/documentService');
const { requireAuth, requireRole, requireAgencyUser } = require('../middleware/auth');

const router = express.Router();
router.use(requireAuth);

/** GET /api/workspaces - workspaces this user can open (agency + its clients, or just their own) */
router.get('/', (req, res) => {
  res.json(workspaces.listForUser(req.auth.homeCompanyId));
});

/** GET /api/workspaces/current - the workspace this request is scoped to (X-Workspace-Id) */
router.get('/current', (req, res) => {
  res.json(workspaces.getWorkspace(req.auth.companyId));
});

/** GET /api/workspaces/clients - the agency's clients with health scores */
router.get('/clients', requireAgencyUser, (req, res) => {
  res.json(workspaces.listClients(req.auth.homeCompanyId));
});

/**
 * POST /api/workspaces/clients - add a client (company X) and run its AI setup.
 * body: { name, description, industry?, website?, homeCountry?, homeCity?, targetMarket?, services?, adPlatform?,
 *         monthlyRetainer?, baselineCustomerCount?, businessProfile?: { filename, base64 } }
 */
router.post('/clients', requireAgencyUser, requireRole('owner', 'admin'), async (req, res) => {
  try {
    const b = req.body || {};
    let profile = null;
    if (b.businessProfile && b.businessProfile.base64) {
      try { profile = await documents.extractText(b.businessProfile); }
      catch (err) { return res.status(400).json({ error: `Business profile: ${err.message}` }); }
    }
    const client = await workspaces.createClient(req.auth.homeCompanyId, {
      ...b, businessProfileText: profile ? profile.text : null, businessProfileFilename: profile ? b.businessProfile.filename : null
    });
    res.status(201).json(client);
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

/** PATCH /api/workspaces/clients/:id - status (incl. churned + reason), retainer, services, ad platform */
router.patch('/clients/:id', requireAgencyUser, requireRole('owner', 'admin'), (req, res) => {
  const client = workspaces.updateClient(req.auth.homeCompanyId, req.params.id, req.body || {}, req.auth.userId);
  if (!client) return res.status(404).json({ error: 'client not found' });
  res.json(client);
});

/** GET /api/workspaces/clients/:id/health */
router.get('/clients/:id/health', requireAgencyUser, (req, res) => {
  const list = workspaces.listForUser(req.auth.homeCompanyId);
  if (!list.some(w => w.id === req.params.id)) return res.status(404).json({ error: 'client not found' });
  res.json(workspaces.clientHealth(req.params.id));
});

/** POST /api/workspaces/clients/:id/invite - create a client-portal login for company X  body: { name, email, password } */
router.post('/clients/:id/invite', requireAgencyUser, requireRole('owner', 'admin'), async (req, res) => {
  try {
    res.status(201).json(await workspaces.inviteClientUser(req.auth.homeCompanyId, req.params.id, req.body || {}));
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

module.exports = router;
