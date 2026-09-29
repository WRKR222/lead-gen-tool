require('dotenv').config();
const path = require('path');
const express = require('express');
const cors = require('cors');
const { migrate } = require('./db/database');
const email = require('./services/emailService');
const assistantService = require('./services/assistantService');
const { db } = require('./db/database');

const authRouter = require('./routes/auth');
const companiesRouter = require('./routes/companies');
const leadsRouter = require('./routes/leads');
const campaignsRouter = require('./routes/campaigns');
const callsRouter = require('./routes/calls');
const tasksRouter = require('./routes/tasks');
const meetingsRouter = require('./routes/meetings');
const assistantRouter = require('./routes/assistant');
const contentRouter = require('./routes/content');
const workspacesRouter = require('./routes/workspaces');
const outreachRouter = require('./routes/outreach');
const followupsRouter = require('./routes/followups');
const inboxRouter = require('./routes/inbox');
const inboundRouter = require('./routes/inbound');
const notificationsRouter = require('./routes/notifications');
const customersRouter = require('./routes/customers');
const analyticsRouter = require('./routes/analytics');
const integrationsRouter = require('./routes/integrations');
const playbookRouter = require('./routes/playbook');
const scheduler = require('./services/scheduler');

migrate();

const app = express();
app.use(cors());
// Business profiles and customer spreadsheets arrive base64-encoded in JSON (12 MB file cap).
app.use(express.json({ limit: '18mb' }));
app.use(express.static(path.join(__dirname, '..', 'public')));

app.use('/api/auth', authRouter);
app.use('/api/companies', companiesRouter);
app.use('/api/workspaces', workspacesRouter);
app.use('/api/leads', leadsRouter);
app.use('/api/outreach', outreachRouter);
app.use('/api/followups', followupsRouter);
app.use('/api/inbox', inboxRouter);
app.use('/api/inbound', inboundRouter);
app.use('/api/notifications', notificationsRouter);
app.use('/api/customers', customersRouter);
app.use('/api/analytics', analyticsRouter);
app.use('/api/integrations', integrationsRouter);
app.use('/api/playbook', playbookRouter);
app.use('/api/campaigns', campaignsRouter);
app.use('/api/calls', callsRouter);
app.use('/api/tasks', tasksRouter);
app.use('/api/meetings', meetingsRouter);
app.use('/api/assistant', assistantRouter);
app.use('/api/content', contentRouter);

// One-click unsubscribe (required in every outbound email) - no auth,
// must work from a plain link click in an email client. Scoped by company
// so an unsubscribe only suppresses future sends from that one tenant.
app.get('/api/unsubscribe', (req, res) => {
  const { company, email: addr, token } = req.query;
  if (!company || !addr || !token) return res.status(400).send('Missing company, email or token.');
  if (token !== email.unsubscribeToken(company, addr)) return res.status(403).send('Invalid unsubscribe link.');
  email.suppress(company, addr, 'user_unsubscribed');
  res.send('You have been unsubscribed and will not receive further emails from us.');
});

app.get('/api/health', (req, res) => res.json({ ok: true }));

// Optional: run the AI assistant autonomously for every company on an
// interval, so it can proactively create follow-up tasks etc. without
// anyone clicking a button. Off by default - most deployments should
// prefer triggering this from an external scheduler (cron / the
// platform's scheduled-jobs feature) per company instead, for better
// control and observability; this in-process loop is a convenience for
// small single-instance deployments.
if (process.env.AUTONOMOUS_ASSISTANT_ENABLED === 'true') {
  const intervalMinutes = Number(process.env.AUTONOMOUS_ASSISTANT_INTERVAL_MINUTES || 60);
  setInterval(async () => {
    const companies = db.prepare("SELECT id FROM companies WHERE onboarding_status = 'ready'").all();
    for (const c of companies) {
      try { await assistantService.converse(c.id, null, null, 'autonomous'); }
      catch (err) { console.warn(`[autonomous assistant] company ${c.id} run failed: ${err.message}`); }
    }
  }, intervalMinutes * 60 * 1000);
  console.log(`[autonomous assistant] enabled, running every ${intervalMinutes} minute(s)`);
}

scheduler.start();

// JSON errors (e.g. an oversized upload) instead of Express's HTML page.
app.use((err, req, res, next) => {
  if (res.headersSent) return next(err);
  const status = err.type === 'entity.too.large' ? 413 : err.status || 500;
  res.status(status).json({ error: status === 413 ? 'Upload too large - keep files under 12 MB.' : err.message });
});

const PORT = process.env.PORT || 4000;
app.listen(PORT, () => {
  console.log(`Lead-gen & growth platform running on :${PORT}`);
  require('./db/database').describeStorage();
});
