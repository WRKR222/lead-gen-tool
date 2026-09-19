const express = require('express');
const { v4: uuid } = require('uuid');
const { db } = require('../db/database');
const email = require('../services/emailService');
const generator = require('../services/emailGenerationService');
const { getDirections } = require('../services/directionsService');
const { requireAuth } = require('../middleware/auth');

const router = express.Router();
router.use(requireAuth);

/**
 * POST /api/campaigns
 * body: { name, steps: [{ stepId, dayOffset }] }
 * Note: no subject/body here - content is generated fresh per lead at
 * send time, never authored once and reused.
 */
router.post('/', (req, res) => {
  const { name, steps } = req.body;
  if (!name || !Array.isArray(steps) || steps.length === 0) {
    return res.status(400).json({ error: 'name and steps[] ({stepId, dayOffset}) are required' });
  }
  const id = uuid();
  db.prepare('INSERT INTO campaigns (id, company_id, name, template_sequence_json, status) VALUES (?, ?, ?, ?, ?)')
    .run(id, req.auth.companyId, name, JSON.stringify(steps), 'draft');
  res.json({ id, name, steps, status: 'draft' });
});

/** GET /api/campaigns - list this company's campaigns */
router.get('/', (req, res) => {
  const rows = db.prepare('SELECT * FROM campaigns WHERE company_id = ? ORDER BY created_at DESC').all(req.auth.companyId);
  res.json(rows.map(c => ({ ...c, steps: JSON.parse(c.template_sequence_json) })));
});

/**
 * POST /api/campaigns/preview
 * body: { leadId, stepId }
 * Generates (but does not send) a preview email for a lead, so a human
 * can sanity-check tone before a campaign goes live. Doesn't touch send
 * history, so it doesn't count as a real send and won't be treated as
 * "already said" by future generations.
 */
router.post('/preview', async (req, res) => {
  try {
    const { leadId, stepId } = req.body;
    const lead = loadLead(leadId, req.auth.companyId);
    if (!lead) return res.status(404).json({ error: 'lead not found' });
    const directions = getDirections(req.auth.companyId);
    const generated = await generator.generateEmailForLead(lead, directions, stepId || 'intro');
    res.json(generated);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

/**
 * POST /api/campaigns/:id/send
 * body: { leadIds: string[], stepId: string }
 *
 * For each lead: generates a brand-new email (aware of every prior email
 * sent to that lead, so it can't repeat one), then sends it. Honors the
 * suppression list and rate limits. For real volumes, call this from a
 * scheduler per dayOffset rather than blasting a whole sequence at once.
 */
router.post('/:id/send', async (req, res) => {
  const companyId = req.auth.companyId;
  const campaign = db.prepare('SELECT * FROM campaigns WHERE id = ? AND company_id = ?').get(req.params.id, companyId);
  if (!campaign) return res.status(404).json({ error: 'campaign not found' });

  const { leadIds, stepId } = req.body;
  const steps = JSON.parse(campaign.template_sequence_json);
  if (!steps.find(s => s.stepId === stepId)) {
    return res.status(400).json({ error: 'stepId not found in this campaign' });
  }

  const directions = getDirections(companyId);
  const fromName = directions.sender?.senderName || directions.sender?.companyName;
  const insertSend = db.prepare(`
    INSERT INTO campaign_sends (id, campaign_id, lead_id, step_id, subject, body, angle, sent_at, status)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);

  const results = [];
  for (const leadId of leadIds) {
    const lead = loadLead(leadId, companyId);
    if (!lead) { results.push({ leadId, status: 'skipped_not_found' }); continue; }

    if (!lead.email) {
      results.push({ leadId, status: 'skipped_no_email' });
      continue;
    }
    if (email.isSuppressed(companyId, lead.email)) {
      insertSend.run(uuid(), campaign.id, leadId, stepId, null, null, null, null, 'skipped_suppressed');
      results.push({ leadId, status: 'skipped_suppressed' });
      continue;
    }
    if (!email.withinRateLimit(companyId)) {
      results.push({ leadId, status: 'skipped_rate_limited' });
      break; // stop the batch here; resume later via scheduler
    }

    let generated;
    try {
      generated = await generator.generateEmailForLead(lead, directions, stepId);
    } catch (err) {
      results.push({ leadId, status: 'failed_generation', error: err.message });
      continue;
    }

    const result = await email.sendGeneratedToLead(companyId, lead, generated, fromName, directions.sender?.website);
    insertSend.run(
      uuid(), campaign.id, leadId, stepId,
      generated.subject, generated.body, generated.angle,
      result.status === 'sent' ? new Date().toISOString() : null,
      result.status
    );
    if (result.status === 'sent') {
      db.prepare("UPDATE leads SET status = 'contacted', updated_at = datetime('now') WHERE id = ?").run(leadId);
    }
    results.push({ leadId, status: result.status, subject: generated.subject, angle: generated.angle, previewUrl: result.previewUrl || undefined });
  }

  db.prepare('UPDATE campaigns SET status = ? WHERE id = ?').run('active', campaign.id);
  res.json({ campaignId: campaign.id, results });
});

// GET /api/campaigns/warmup-status - shows today's effective sending cap
// under the warm-up ramp, so you can see progress toward full volume.
router.get('/warmup-status', (req, res) => {
  res.json({
    warmupEnabled: process.env.WARMUP_ENABLED !== 'false',
    effectiveDailyCapToday: email.getEffectiveDailyCap(req.auth.companyId),
    configuredMaxPerDay: Number(process.env.MAX_EMAILS_PER_DAY || 500)
  });
});

// GET /api/campaigns/:id - includes every generated email actually sent, for audit
router.get('/:id', (req, res) => {
  const campaign = db.prepare('SELECT * FROM campaigns WHERE id = ? AND company_id = ?').get(req.params.id, req.auth.companyId);
  if (!campaign) return res.status(404).json({ error: 'not found' });
  const sends = db.prepare('SELECT * FROM campaign_sends WHERE campaign_id = ? ORDER BY sent_at ASC').all(campaign.id);
  res.json({ ...campaign, steps: JSON.parse(campaign.template_sequence_json), sends });
});

function loadLead(id, companyId) {
  const l = db.prepare('SELECT * FROM leads WHERE id = ? AND company_id = ?').get(id, companyId);
  if (!l) return null;
  return {
    id: l.id, email: l.email, contactName: l.contact_name, title: l.title,
    companyName: l.company_name, industry: l.industry, city: l.city,
    country: l.country, companySize: l.company_size
  };
}

module.exports = router;
