const express = require('express');
const outreach = require('../services/outreachService');
const bulkEmail = require('../services/bulkEmailService');
const meetingPrep = require('../services/meetingPrepService');
const insights = require('../services/insightsService');
const leadsService = require('../services/leadsService');
const { getDirections, safeParse } = require('../services/directionsService');
const { db } = require('../db/database');
const { requireAuth } = require('../middleware/auth');

const router = express.Router();
router.use(requireAuth);

/**
 * POST /api/outreach/prepare - AI guidance for each chosen method on one lead.
 * body: { leadId, methods: ['door_to_door','cold_call','digital','email_dm'] }
 */
router.post('/prepare', async (req, res) => {
  try {
    const { leadId, methods } = req.body || {};
    res.json(await outreach.prepare(req.auth.companyId, leadId, methods));
  } catch (err) {
    res.status(err.message === 'lead not found' ? 404 : 500).json({ error: err.message });
  }
});

/**
 * POST /api/outreach/attempts - record a contact attempt and its result.
 * body: { leadId, method, channel?, contactId?, result, notes?, message?, spokeToDecisionMaker?,
 *         standards?: { decision_maker, straight_to_point, scarcity, no_pitch, accept_no }, reasonCategory?, reason?, occurredAt? }
 */
router.post('/attempts', (req, res) => {
  try {
    res.status(201).json(outreach.recordAttempt(req.auth.companyId, req.auth.userId, req.body || {}));
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

/** GET /api/outreach/attempts?leadId=&limit= */
router.get('/attempts', (req, res) => {
  let q = `SELECT a.*, l.company_name, l.contact_name, u.name AS user_name FROM outreach_attempts a
    JOIN leads l ON l.id = a.lead_id LEFT JOIN users u ON u.id = a.user_id WHERE a.company_id = ?`;
  const params = [req.auth.companyId];
  if (req.query.leadId) { q += ' AND a.lead_id = ?'; params.push(req.query.leadId); }
  q += ' ORDER BY a.occurred_at DESC LIMIT ?';
  params.push(Math.min(Number(req.query.limit) || 100, 500));
  res.json(db.prepare(q).all(...params));
});

/**
 * POST /api/outreach/email/compose - drafts for many leads (not sent).
 * body: { leadIds, mode: 'template'|'bespoke', goal?, stepId? }
 */
router.post('/email/compose', async (req, res) => {
  try {
    res.json(await bulkEmail.compose(req.auth.companyId, req.body || {}));
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

/** POST /api/outreach/email/send  body: { drafts: [{ leadId, subject, body, mode?, angle? }] } */
router.post('/email/send', async (req, res) => {
  try {
    res.json(await bulkEmail.sendMany(req.auth.companyId, req.auth.userId, (req.body || {}).drafts));
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

/** POST /api/outreach/meeting-brief  body: { leadId } - CPS (Attention/Identify/Solve/Cost) brief */
router.post('/meeting-brief', async (req, res) => {
  try {
    const lead = leadsService.getLeadRow(req.auth.companyId, (req.body || {}).leadId);
    if (!lead) return res.status(404).json({ error: 'lead not found' });
    const pyramid = safeParse(db.prepare('SELECT value_pyramid_json FROM companies WHERE id = ?').get(req.auth.companyId).value_pyramid_json);
    res.json(await meetingPrep.generateCpsBrief(leadsService.toLeadShape(lead), getDirections(req.auth.companyId), pyramid, insights.topLossReasons(req.auth.companyId)));
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

module.exports = router;
