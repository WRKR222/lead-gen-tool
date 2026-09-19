const express = require('express');
const assistantService = require('../services/assistantService');
const { requireAuth } = require('../middleware/auth');

const router = express.Router();
router.use(requireAuth);

/** GET /api/assistant/history - recent conversation + tool-call log */
router.get('/history', (req, res) => {
  res.json(assistantService.history(req.auth.companyId, Number(req.query.limit) || 40));
});

/** POST /api/assistant/chat  body: { message } */
router.post('/chat', async (req, res) => {
  try {
    const { message } = req.body;
    if (!message) return res.status(400).json({ error: 'message is required' });
    const result = await assistantService.converse(req.auth.companyId, req.auth.userId, message, 'chat');
    res.json(result);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

/**
 * POST /api/assistant/run-autonomous - trigger the assistant to review
 * leads/tasks/meetings on its own and take whatever actions it judges
 * useful, with no human prompt. Call this from a scheduler (cron, a
 * platform's scheduled-jobs feature, or the "Run assistant now" button in
 * Settings) to get the "carries out tasks automatically" behavior.
 */
router.post('/run-autonomous', async (req, res) => {
  try {
    const result = await assistantService.converse(req.auth.companyId, req.auth.userId, null, 'autonomous');
    res.json(result);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

module.exports = router;
