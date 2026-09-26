/**
 * In-process background jobs (single instance; for several instances run
 * these from one worker or an external scheduler instead):
 *  - follow-up engine: every FOLLOWUP_ENGINE_INTERVAL_MINUTES (default 30),
 *    turns due follow-ups into tasks, and sends email follow-ups for
 *    workspaces that enabled "auto follow-up emails"
 *  - client health: once a day, flags agency clients at risk of churning
 *  - IMAP inbox polling: every IMAP_POLL_MINUTES (default 2), when configured
 * Set FOLLOWUP_ENGINE_ENABLED=false to turn the follow-up engine off.
 */
const { db } = require('../db/database');
const followUps = require('./followUpService');
const workspaces = require('./workspaceService');
const notifications = require('./notificationService');
const imapPoller = require('./imapPoller');
const { getSettings } = require('./directionsService');

let lastHealthDay = null;
const lastDigestDay = new Map();

async function followUpTick() {
  const today = new Date().toISOString().slice(0, 10);
  for (const c of db.prepare("SELECT id FROM companies WHERE onboarding_status = 'ready' AND (client_status IS NULL OR client_status != 'churned')").all()) {
    try {
      const summary = await followUps.runDue(c.id, null, { sendEmails: getSettings(c.id).autoFollowUpEmails });
      if ((summary.tasksCreated || summary.emailed) && lastDigestDay.get(c.id) !== today) {
        lastDigestDay.set(c.id, today);
        notifications.notify({ companyId: c.id, type: 'follow_up_due', title: `${summary.due} follow-up${summary.due === 1 ? '' : 's'} due`, body: `${summary.emailed} emailed automatically, ${summary.tasksCreated} added to tasks.` });
      }
    } catch (err) {
      console.warn(`[scheduler] follow-ups for ${c.id} failed: ${err.message}`);
    }
  }
}

function healthTick() {
  const today = new Date().toISOString().slice(0, 10);
  if (lastHealthDay === today) return;
  lastHealthDay = today;
  for (const a of db.prepare("SELECT id FROM companies WHERE kind = 'agency'").all()) {
    try { workspaces.checkClientHealth(a.id); } catch (err) { console.warn(`[scheduler] health check for ${a.id} failed: ${err.message}`); }
  }
}

function start() {
  const timers = [];
  if (process.env.FOLLOWUP_ENGINE_ENABLED !== 'false') {
    const minutes = Math.max(5, Number(process.env.FOLLOWUP_ENGINE_INTERVAL_MINUTES || 30));
    timers.push(setInterval(() => { followUpTick().catch(() => {}); healthTick(); }, minutes * 60000));
    console.log(`[scheduler] follow-up engine every ${minutes} min`);
  }
  if (imapPoller.configured()) {
    const minutes = Math.max(1, Number(process.env.IMAP_POLL_MINUTES || 2));
    timers.push(setInterval(() => imapPoller.pollOnce().catch(() => {}), minutes * 60000));
    console.log(`[scheduler] IMAP inbox polling every ${minutes} min`);
  }
  timers.forEach(t => t.unref());
  return timers;
}

module.exports = { start, followUpTick, healthTick };
