const express = require('express');
const { v4: uuid } = require('uuid');
const { db } = require('../db/database');
const callsService = require('../services/callsService');
const tasksService = require('../services/tasksService');
const { getDirections } = require('../services/directionsService');
const { requireAuth } = require('../middleware/auth');

const router = express.Router();
router.use(requireAuth);

// Outcomes that should automatically create a follow-up task, and how far
// out to schedule it - this is the "monitoring progress and following up
// like a sales person" behavior for the calling workflow.
const FOLLOW_UP_DAYS = {
  no_answer: 1, voicemail: 2, callback_requested: 1, interested: 3, wrong_number: null,
  not_interested: null, meeting_booked: null // a meeting was already booked - no separate follow-up needed
};

function loadLead(id, companyId) {
  return db.prepare('SELECT * FROM leads WHERE id = ? AND company_id = ?').get(id, companyId);
}

/** POST /api/calls/script  body: { leadId } - generate (not log) a call script for prep */
router.post('/script', async (req, res) => {
  try {
    const lead = loadLead(req.body.leadId, req.auth.companyId);
    if (!lead) return res.status(404).json({ error: 'lead not found' });
    const directions = getDirections(req.auth.companyId);
    const script = await callsService.generateCallScript(toLeadShape(lead), directions);
    res.json(script);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

/**
 * POST /api/calls - log a call. If `generateScriptFirst` is true and no
 * script is given, generates one and stores it alongside the log (useful
 * for a single "log this call, with the script I actually used" call).
 * body: { leadId, direction?, status, outcome?, notes?, durationSeconds?,
 *         scheduledAt?, completedAt?, script? }
 */
router.post('/', async (req, res) => {
  try {
    const companyId = req.auth.companyId;
    const { leadId, direction, status, outcome, notes, durationSeconds, scheduledAt, completedAt, script } = req.body;
    const lead = loadLead(leadId, companyId);
    if (!lead) return res.status(404).json({ error: 'lead not found' });

    const id = uuid();
    db.prepare(`
      INSERT INTO calls (id, company_id, lead_id, user_id, direction, status, outcome, script_json, notes, duration_seconds, scheduled_at, completed_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(id, companyId, leadId, req.auth.userId, direction || 'outbound', status || 'completed', outcome || null,
      script ? JSON.stringify(script) : null, notes || null, durationSeconds || null, scheduledAt || null, completedAt || new Date().toISOString());

    let followUpTask = null;
    if (outcome && FOLLOW_UP_DAYS[outcome]) {
      const dueAt = new Date(Date.now() + FOLLOW_UP_DAYS[outcome] * 86400000).toISOString();
      followUpTask = tasksService.createTask(companyId, {
        leadId, title: `Follow up with ${lead.company_name}${lead.contact_name ? ' (' + lead.contact_name + ')' : ''}`,
        description: `Auto-created from call outcome "${outcome}".`, priority: outcome === 'interested' ? 'high' : 'normal',
        dueAt, createdBy: 'ai_assistant'
      });
      db.prepare('UPDATE calls SET follow_up_task_id = ? WHERE id = ?').run(followUpTask.id, id);
    }
    if (outcome === 'meeting_booked') {
      db.prepare("UPDATE leads SET status = 'meeting_booked', updated_at = datetime('now') WHERE id = ?").run(leadId);
    } else if (outcome === 'interested' || outcome === 'callback_requested') {
      db.prepare("UPDATE leads SET status = 'contacted', updated_at = datetime('now') WHERE id = ?").run(leadId);
    } else if (outcome === 'not_interested') {
      db.prepare("UPDATE leads SET status = 'closed_lost', updated_at = datetime('now') WHERE id = ?").run(leadId);
    }

    const call = db.prepare('SELECT * FROM calls WHERE id = ?').get(id);
    res.status(201).json({ call: { ...call, script_json: call.script_json ? JSON.parse(call.script_json) : null }, followUpTask });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

/** GET /api/calls?leadId= */
router.get('/', (req, res) => {
  let q = 'SELECT * FROM calls WHERE company_id = ?';
  const params = [req.auth.companyId];
  if (req.query.leadId) { q += ' AND lead_id = ?'; params.push(req.query.leadId); }
  q += ' ORDER BY created_at DESC';
  const rows = db.prepare(q).all(...params);
  res.json(rows.map(c => ({ ...c, script_json: c.script_json ? JSON.parse(c.script_json) : null })));
});

function toLeadShape(l) {
  return {
    id: l.id, contactName: l.contact_name, title: l.title, companyName: l.company_name,
    industry: l.industry, city: l.city, country: l.country, companySize: l.company_size
  };
}

module.exports = router;
