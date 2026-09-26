const express = require('express');
const cadence = require('../services/cadenceService');
const followUps = require('../services/followUpService');
const { requireAuth } = require('../middleware/auth');

const router = express.Router();
router.use(requireAuth);

/** GET /api/followups/due - leads whose next follow-up is due, with the suggested method */
router.get('/due', (req, res) => {
  res.json(cadence.dueQueue(req.auth.companyId, { limit: Math.min(Number(req.query.limit) || 100, 500) }));
});

/**
 * POST /api/followups/run - work the queue now: send email follow-ups
 * (when sendEmails is true) and create tasks for door-to-door/call/DM follow-ups.
 * body: { sendEmails?: boolean }
 */
router.post('/run', async (req, res) => {
  try {
    res.json(await followUps.runDue(req.auth.companyId, req.auth.userId, { sendEmails: !!(req.body || {}).sendEmails }));
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

module.exports = router;
