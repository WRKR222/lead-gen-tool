const express = require('express');
const { db } = require('../db/database');
const tasksService = require('../services/tasksService');
const { requireAuth } = require('../middleware/auth');

const router = express.Router();
router.use(requireAuth);

/** GET /api/tasks?status=open&leadId=... */
router.get('/', (req, res) => {
  res.json(tasksService.listTasks(req.auth.companyId, { status: req.query.status, leadId: req.query.leadId }));
});

/** POST /api/tasks  body: { leadId?, title, description?, priority?, dueAt? } */
router.post('/', (req, res) => {
  try {
    const task = tasksService.createTask(req.auth.companyId, { ...req.body, createdBy: 'user' });
    res.status(201).json(task);
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

/** PATCH /api/tasks/:id */
router.patch('/:id', (req, res) => {
  const task = tasksService.updateTask(req.auth.companyId, req.params.id, req.body || {});
  if (!task) return res.status(404).json({ error: 'task not found' });
  res.json(task);
});

/** DELETE /api/tasks/:id (soft: marks cancelled, keeps history) */
router.delete('/:id', (req, res) => {
  const task = tasksService.updateTask(req.auth.companyId, req.params.id, { status: 'cancelled' });
  if (!task) return res.status(404).json({ error: 'task not found' });
  res.json(task);
});

module.exports = router;
