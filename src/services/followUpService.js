/**
 * Works through the follow-up queue. Email follow-ups can be sent
 * automatically (when the workspace enables it, or when a person clicks
 * "run now"); door-to-door, calls and DMs need a person, so they become
 * tasks - one open task per lead at a time, never duplicates.
 */
const { db } = require('../db/database');
const cadence = require('./cadenceService');
const bulkEmail = require('./bulkEmailService');
const emailGeneration = require('./emailGenerationService');
const leads = require('./leadsService');
const tasksService = require('./tasksService');
const { getDirections } = require('./directionsService');
const { methodByKey } = require('../config/playbook');

const TASK_PREFIX = 'Follow up:';

async function runDue(companyId, userId, { sendEmails = false, limit = 50 } = {}) {
  const queue = cadence.dueQueue(companyId, { limit });
  const directions = getDirections(companyId);
  const openTask = db.prepare("SELECT 1 FROM tasks WHERE company_id = ? AND lead_id = ? AND status IN ('open','in_progress') AND title LIKE ? LIMIT 1");
  const summary = { due: queue.length, emailed: 0, tasksCreated: 0, skipped: 0, results: [] };

  for (const item of queue) {
    const lead = leads.getLeadRow(companyId, item.lead.id);
    const name = leads.displayName(lead);
    if (!item.suggestedMethod) { summary.skipped++; continue; }

    if (item.suggestedMethod === 'email_dm' && sendEmails) {
      try {
        const g = await emailGeneration.generateEmailForLead(leads.toLeadShape(lead), directions, `followup_${item.attemptsSoFar}`);
        const r = await bulkEmail.sendOne(companyId, userId, { leadId: lead.id, subject: g.subject, body: g.body, angle: g.angle, mode: 'follow_up', automated: true });
        summary.results.push({ leadId: lead.id, name, action: 'email', status: r.status });
        if (r.status === 'sent') summary.emailed++; else summary.skipped++;
        if (r.status === 'skipped_rate_limited') break;
      } catch (err) {
        summary.results.push({ leadId: lead.id, name, action: 'email', status: 'failed', error: err.message });
        summary.skipped++;
      }
      continue;
    }

    if (openTask.get(companyId, lead.id, `${TASK_PREFIX}%`)) { summary.skipped++; continue; }
    const method = methodByKey(item.suggestedMethod);
    tasksService.createTask(companyId, {
      leadId: lead.id, title: `${TASK_PREFIX} ${name} - ${method.label.toLowerCase()}`,
      description: `${item.reason}. Last attempt: ${item.lastAttempt ? item.lastAttempt.method.replace(/_/g, ' ') + ' (' + item.lastAttempt.result.replace(/_/g, ' ') + ')' : 'none'}.`,
      priority: item.attemptsSoFar >= 3 ? 'normal' : 'high', dueAt: new Date().toISOString(), createdBy: 'ai_assistant'
    });
    summary.tasksCreated++;
    summary.results.push({ leadId: lead.id, name, action: 'task', method: item.suggestedMethod });
  }
  return summary;
}

module.exports = { runDue, TASK_PREFIX };
