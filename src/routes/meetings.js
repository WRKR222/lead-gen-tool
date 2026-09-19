const express = require('express');
const meetingsService = require('../services/meetingsService');
const { requireAuth } = require('../middleware/auth');

const router = express.Router();
router.use(requireAuth);

/** GET /api/meetings?leadId=&status= */
router.get('/', (req, res) => {
  res.json(meetingsService.listMeetings(req.auth.companyId, { leadId: req.query.leadId, status: req.query.status }));
});

/** POST /api/meetings  body: { leadId?, title, description?, startAt, endAt, locationOrLink? } */
router.post('/', async (req, res) => {
  try {
    const { meeting, ics } = await meetingsService.scheduleMeeting(req.auth.companyId, { ...req.body, createdBy: 'user' });
    res.status(201).json({ meeting, ics });
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

/** GET /api/meetings/:id/ics - download the calendar invite */
router.get('/:id/ics', (req, res) => {
  const meeting = meetingsService.listMeetings(req.auth.companyId).find(m => m.id === req.params.id);
  if (!meeting) return res.status(404).json({ error: 'meeting not found' });
  const ics = meetingsService.buildIcs({
    uid: meeting.ics_uid, title: meeting.title, description: meeting.description,
    startAt: meeting.start_at, endAt: meeting.end_at, location: meeting.location_or_link
  });
  res.setHeader('Content-Type', 'text/calendar; charset=utf-8');
  res.setHeader('Content-Disposition', `attachment; filename="meeting-${meeting.id}.ics"`);
  res.send(ics);
});

/** PATCH /api/meetings/:id  body: { status } */
router.patch('/:id', (req, res) => {
  const { status } = req.body || {};
  if (!status) return res.status(400).json({ error: 'status is required' });
  const meeting = meetingsService.updateMeetingStatus(req.auth.companyId, req.params.id, status);
  if (!meeting) return res.status(404).json({ error: 'meeting not found' });
  res.json(meeting);
});

module.exports = router;
