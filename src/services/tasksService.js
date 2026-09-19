/**
 * Tasks: simple to-do tracking, shared between humans and the AI
 * assistant. `createdBy: 'ai_assistant'` marks tasks the assistant created
 * on its own (e.g. "follow up with X in 3 days" after a call outcome) so
 * the UI can visually distinguish AI-initiated work from what a person
 * added themselves.
 */
const { v4: uuid } = require('uuid');
const { db } = require('../db/database');

function createTask(companyId, { leadId, assignedTo, title, description, priority, dueAt, createdBy }) {
  if (!title) throw new Error('title is required');
  const id = uuid();
  db.prepare(`
    INSERT INTO tasks (id, company_id, lead_id, assigned_to, title, description, priority, due_at, created_by)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(id, companyId, leadId || null, assignedTo || null, title, description || null, priority || 'normal', dueAt || null, createdBy || 'user');
  return db.prepare('SELECT * FROM tasks WHERE id = ?').get(id);
}

function listTasks(companyId, { status, leadId } = {}) {
  let q = 'SELECT * FROM tasks WHERE company_id = ?';
  const params = [companyId];
  if (status) { q += ' AND status = ?'; params.push(status); }
  if (leadId) { q += ' AND lead_id = ?'; params.push(leadId); }
  q += ' ORDER BY (due_at IS NULL), due_at ASC, created_at DESC';
  return db.prepare(q).all(...params);
}

function updateTask(companyId, id, { title, description, status, priority, dueAt, assignedTo }) {
  const existing = db.prepare('SELECT * FROM tasks WHERE id = ? AND company_id = ?').get(id, companyId);
  if (!existing) return null;
  db.prepare(`
    UPDATE tasks SET title = COALESCE(?, title), description = COALESCE(?, description), status = COALESCE(?, status),
      priority = COALESCE(?, priority), due_at = COALESCE(?, due_at), assigned_to = COALESCE(?, assigned_to),
      updated_at = datetime('now')
    WHERE id = ?
  `).run(title ?? null, description ?? null, status ?? null, priority ?? null, dueAt ?? null, assignedTo ?? null, id);
  return db.prepare('SELECT * FROM tasks WHERE id = ?').get(id);
}

module.exports = { createTask, listTasks, updateTask };
