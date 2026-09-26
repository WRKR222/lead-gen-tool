const express = require('express');
const { db } = require('../db/database');
const meetingsService = require('../services/meetingsService');
const meetingPrep = require('../services/meetingPrepService');
const outreach = require('../services/outreachService');
const insights = require('../services/insightsService');
const leadsService = require('../services/leadsService');
const { getDirections, safeParse } = require('../services/directionsService');
const { requireAuth } = require('../middleware/auth');

const router = express.Router();
router.use(requireAuth);

async function briefFor(companyId, leadId) {
  const lead = leadsService.getLeadRow(companyId, leadId);
  if (!lead) return null;
  const pyramid = safeParse(db.prepare('SELECT value_pyramid_json FROM companies WHERE id = ?').get(companyId).value_pyramid_json);
  return meetingPrep.generateCpsBrief(leadsService.toLeadShape(lead), getDirections(companyId), pyramid, insights.topLossReasons(companyId));
}

function parseMeeting(m) {
  return { ...m, cps_brief: safeParse(m.cps_brief_json), cps_notes: safeParse(m.cps_notes_json) };
}

/** GET /api/meetings?leadId=&status= */
router.get('/', (req, res) => {
  const rows = meetingsService.listMeetings(req.auth.companyId, { leadId: req.query.leadId, status: req.query.status });
  const names = db.prepare('SELECT company_name, contact_name FROM leads WHERE id = ?');
  res.json(rows.map(m => ({ ...parseMeeting(m), lead: m.lead_id ? names.get(m.lead_id) : null })));
});

/**
 * POST /api/meetings - book a meeting; with a leadId, a CPS brief is prepared for it.
 * body: { leadId?, title, description?, startAt, endAt, locationOrLink?, meetingType?: in_person|call|video }
 */
router.post('/', async (req, res) => {
  try {
    const b = req.body || {};
    const cpsBrief = b.leadId ? await briefFor(req.auth.companyId, b.leadId) : null;
    const { meeting, ics } = await meetingsService.scheduleMeeting(req.auth.companyId, { ...b, cpsBrief, createdBy: 'user' });
    res.status(201).json({ meeting: parseMeeting(meeting), ics });
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

/** GET /api/meetings/:id/ics - download the calendar invite */
router.get('/:id/ics', (req, res) => {
  const meeting = db.prepare('SELECT * FROM meetings WHERE id = ? AND company_id = ?').get(req.params.id, req.auth.companyId);
  if (!meeting) return res.status(404).json({ error: 'meeting not found' });
  const ics = meetingsService.buildIcs({
    uid: meeting.ics_uid, title: meeting.title, description: meeting.description,
    startAt: meeting.start_at, endAt: meeting.end_at, location: meeting.location_or_link
  });
  res.setHeader('Content-Type', 'text/calendar; charset=utf-8');
  res.setHeader('Content-Disposition', `attachment; filename="meeting-${meeting.id}.ics"`);
  res.send(ics);
});

/** POST /api/meetings/:id/brief - (re)generate the CPS brief for this meeting's lead */
router.post('/:id/brief', async (req, res) => {
  try {
    const meeting = db.prepare('SELECT * FROM meetings WHERE id = ? AND company_id = ?').get(req.params.id, req.auth.companyId);
    if (!meeting) return res.status(404).json({ error: 'meeting not found' });
    if (!meeting.lead_id) return res.status(400).json({ error: 'meeting has no lead' });
    const cpsBrief = await briefFor(req.auth.companyId, meeting.lead_id);
    res.json(parseMeeting(meetingsService.recordMeeting(req.auth.companyId, meeting.id, { cpsBrief })));
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

/**
 * PATCH /api/meetings/:id - status, or how it went:
 * body: { status?, outcome?: yes|on_fence|no|no_show, cpsNotes?: {attention, identify, solve, cost}, quotedPrice?, reasonCategory?, reason? }
 * An outcome also sets the lead's outcome (yes -> converted, no -> said no).
 */
router.patch('/:id', (req, res) => {
  try {
    const b = req.body || {};
    if (!b.status && !b.outcome && !b.cpsNotes && b.quotedPrice === undefined) return res.status(400).json({ error: 'status, outcome, cpsNotes or quotedPrice is required' });
    const meeting = meetingsService.recordMeeting(req.auth.companyId, req.params.id, b);
    if (!meeting) return res.status(404).json({ error: 'meeting not found' });
    let lead = null;
    const map = { yes: 'converted', on_fence: 'on_fence', no: 'said_no' };
    if (meeting.lead_id && map[b.outcome]) {
      lead = outreach.setOutcome(req.auth.companyId, meeting.lead_id, { outcome: map[b.outcome], reasonCategory: b.reasonCategory, reason: b.reason, value: meeting.quoted_price, userId: req.auth.userId });
    }
    res.json({ meeting: parseMeeting(meeting), leadOutcome: lead });
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

module.exports = router;
