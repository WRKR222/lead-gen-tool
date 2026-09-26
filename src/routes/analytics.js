const express = require('express');
const analytics = require('../services/analyticsService');
const insights = require('../services/insightsService');
const { requireAuth, requireAgencyUser } = require('../middleware/auth');

const router = express.Router();
router.use(requireAuth);

const days = (req) => Math.min(Math.max(Number(req.query.days) || 30, 1), 365);

/** GET /api/analytics/overview?days=30 - funnel, methods, standards adherence, value, customers, follow-ups */
router.get('/overview', (req, res) => {
  res.json(analytics.workspaceOverview(req.auth.companyId, { days: days(req) }));
});

/** GET /api/analytics/timeseries?granularity=day|month&points= */
router.get('/timeseries', (req, res) => {
  res.json(analytics.timeseries(req.auth.companyId, { granularity: req.query.granularity, points: req.query.points }));
});

/** GET /api/analytics/summary?period=day|month&date=YYYY-MM-DD&refresh=true - performance summary with narrative */
router.get('/summary', async (req, res) => {
  try {
    res.json(await insights.periodSummary(req.auth.companyId, { period: req.query.period, date: req.query.date, refresh: req.query.refresh === 'true' }));
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

/** GET /api/analytics/agency?days=30 - clients, retainers, client churn, results delivered, 3 stages */
router.get('/agency', requireAgencyUser, (req, res) => {
  res.json(analytics.agencyOverview(req.auth.homeCompanyId, { days: days(req) }));
});

/** GET /api/analytics/learning - latest AI learning from losses (null if never run) */
router.get('/learning', (req, res) => {
  res.json(insights.latest(req.auth.companyId, 'churn_learning'));
});

/** POST /api/analytics/learning - analyse loss reasons now and recommend fixes */
router.post('/learning', async (req, res) => {
  try {
    res.json(await insights.churnLearning(req.auth.companyId));
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

module.exports = router;
