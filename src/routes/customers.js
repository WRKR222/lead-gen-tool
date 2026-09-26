const express = require('express');
const customers = require('../services/customersService');
const documents = require('../services/documentService');
const { requireAuth } = require('../middleware/auth');

const router = express.Router();
router.use(requireAuth);

/** GET /api/customers?status=active|lost */
router.get('/', (req, res) => {
  res.json(customers.list(req.auth.companyId, { status: req.query.status }));
});

/** GET /api/customers/stats - active count, monthly churn series, loss reasons */
router.get('/stats', (req, res) => {
  res.json(customers.stats(req.auth.companyId, { months: Math.min(Number(req.query.months) || 6, 24) }));
});

/** POST /api/customers  body: { name, contactName?, email?, phone?, customerType?, tier?, totalValue?, monthlyValue?, acquiredAt? } */
router.post('/', (req, res) => {
  try {
    res.status(201).json(customers.create(req.auth.companyId, { ...(req.body || {}), source: 'manual' }));
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

/** POST /api/customers/import  body: { filename, base64 } (Excel .xlsx or .csv) or { csvText } */
router.post('/import', (req, res) => {
  try {
    const { csvText, filename, base64 } = req.body || {};
    if (!csvText && !base64) return res.status(400).json({ error: 'Upload an .xlsx or .csv file, or paste CSV' });
    const { rows } = documents.parseSpreadsheet(csvText ? { text: csvText } : { filename, base64 });
    res.json(customers.importRows(req.auth.companyId, rows));
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

/** PUT /api/customers/baseline  body: { count, date? } - customers not listed individually */
router.put('/baseline', (req, res) => {
  customers.setBaseline(req.auth.companyId, req.body || {});
  res.json(customers.stats(req.auth.companyId));
});

/** POST /api/customers/lost-count  body: { count, reasonCategory, reason?, occurredAt? } - losses from the baseline count */
router.post('/lost-count', (req, res) => {
  try {
    customers.recordCountLoss(req.auth.companyId, { ...(req.body || {}), userId: req.auth.userId });
    res.status(201).json(customers.stats(req.auth.companyId));
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

/** POST /api/customers/:id/lost  body: { reasonCategory, reason?, lostAt? } */
router.post('/:id/lost', (req, res) => {
  const c = customers.markLost(req.auth.companyId, req.params.id, { ...(req.body || {}), userId: req.auth.userId });
  if (!c) return res.status(404).json({ error: 'customer not found' });
  res.json(c);
});

/** POST /api/customers/:id/reactivate - undo a loss recorded by mistake / customer came back */
router.post('/:id/reactivate', (req, res) => {
  const c = customers.reactivate(req.auth.companyId, req.params.id);
  if (!c) return res.status(404).json({ error: 'customer not found' });
  res.json(c);
});

module.exports = router;
