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

migrate();

const app = express();
app.use(cors());
app.use(express.json({ limit: '2mb' }));
app.use(express.static(path.join(__dirname, '..', 'public')));

app.use('/api/auth', authRouter);
app.use('/api/companies', companiesRouter);
app.use('/api/leads', leadsRouter);
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

const PORT = process.env.PORT || 4000;
app.listen(PORT, () => console.log(`Lead-gen & growth platform running on :${PORT}`));
