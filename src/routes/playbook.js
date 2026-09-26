const express = require('express');
const playbook = require('../config/playbook');
const { requireAuth } = require('../middleware/auth');

const router = express.Router();
router.use(requireAuth);

/** GET /api/playbook - stages, outreach methods, meeting standards, CPS, funnel, services, ad platforms, loss reasons */
router.get('/', (req, res) => {
  const { methodByKey, resultByKey, methodForChannel, playbookPromptBlock, DEFAULT_SETTINGS, ...data } = playbook;
  res.json(data);
});

module.exports = router;
