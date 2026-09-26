const express = require('express');
const integrations = require('../services/integrationsService');
const { requireAuth } = require('../middleware/auth');

const router = express.Router();
router.use(requireAuth);

/** GET /api/integrations - HighLevel / Appointwise configuration state and recent pushes */
router.get('/', (req, res) => {
  res.json(integrations.status(req.auth.companyId));
});

/** POST /api/integrations/:provider/push  body: { leadIds } - provider: highlevel | appointwise */
router.post('/:provider/push', async (req, res) => {
  try {
    res.json(await integrations.push(req.auth.companyId, req.params.provider, (req.body || {}).leadIds));
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

module.exports = router;
