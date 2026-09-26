const express = require('express');
const inbox = require('../services/inboxService');
const leadsService = require('../services/leadsService');
const imapPoller = require('../services/imapPoller');
const { requireAuth } = require('../middleware/auth');

const router = express.Router();
router.use(requireAuth);

/** GET /api/inbox - inbound replies and AI reply drafts for this workspace */
router.get('/', (req, res) => {
  res.json(inbox.listInbox(req.auth.companyId, { limit: Math.min(Number(req.query.limit) || 100, 500) }));
});

/** POST /api/inbox/:emailId/send  body: { subject?, body? } - send an (edited) AI draft reply */
router.post('/:emailId/send', async (req, res) => {
  try {
    const r = await inbox.sendDraft(req.auth.companyId, req.auth.userId, req.params.emailId, req.body || {});
    if (!r) return res.status(404).json({ error: 'draft not found' });
    res.json(r);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

/** DELETE /api/inbox/:emailId - discard an AI draft */
router.delete('/:emailId', (req, res) => {
  if (!inbox.discardDraft(req.auth.companyId, req.params.emailId)) return res.status(404).json({ error: 'draft not found' });
  res.json({ ok: true });
});

/**
 * POST /api/inbox/simulate-reply  body: { leadId, text, subject? }
 * Feeds a fake reply from a lead through the real inbound pipeline, so the
 * notification + auto-reply flow can be tried without a live mailbox.
 */
router.post('/simulate-reply', async (req, res) => {
  try {
    const { leadId, text, subject } = req.body || {};
    const lead = leadsService.getLeadRow(req.auth.companyId, leadId);
    if (!lead) return res.status(404).json({ error: 'lead not found' });
    if (!lead.email) return res.status(400).json({ error: 'lead has no email address' });
    if (!text) return res.status(400).json({ error: 'text is required' });
    res.json(await inbox.processInbound(req.auth.companyId, { from: lead.email, subject: subject || 'Re: our conversation', text }));
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

/** POST /api/inbox/poll - check the IMAP mailbox now (when IMAP is configured) */
router.post('/poll', async (req, res) => {
  if (!imapPoller.configured()) return res.status(400).json({ error: 'IMAP is not configured on this server (IMAP_HOST / IMAP_USER / IMAP_PASS).' });
  res.json(await imapPoller.pollOnce());
});

module.exports = router;
