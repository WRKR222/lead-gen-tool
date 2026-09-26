/**
 * Notifications + real-time push. Rows are stored per workspace (and
 * tagged with the agency they roll up to); open browser tabs receive them
 * instantly over Server-Sent Events. An agency user's stream carries the
 * agency's own notifications and every client's, so "a lead just replied"
 * reaches the agency team whichever client workspace it happened in.
 *
 * Subscribers live in this process's memory - fine for one instance; move
 * the fan-out to Redis pub/sub when running several (Architecture Plan §9).
 */
const { v4: uuid } = require('uuid');
const { db } = require('../db/database');

const subscribers = new Map(); // channel id -> Set<res>

function agencyIdFor(companyId) {
  const c = db.prepare('SELECT id, kind, agency_id FROM companies WHERE id = ?').get(companyId);
  if (!c) return null;
  return c.kind === 'client' ? c.agency_id : c.id;
}

function publish(channelId, event, payload) {
  const set = subscribers.get(channelId);
  if (!set) return;
  const frame = `event: ${event}\ndata: ${JSON.stringify(payload)}\n\n`;
  for (const res of set) res.write(frame);
}

/**
 * @param {object} n - { companyId, type, title, body?, leadId? }
 */
function notify({ companyId, type, title, body, leadId }) {
  const id = uuid();
  const agencyId = agencyIdFor(companyId);
  db.prepare('INSERT INTO notifications (id, company_id, agency_id, type, title, body, lead_id) VALUES (?, ?, ?, ?, ?, ?, ?)')
    .run(id, companyId, agencyId, type, title, body || null, leadId || null);
  const row = withWorkspaceName(db.prepare('SELECT * FROM notifications WHERE id = ?').get(id));
  publish(companyId, 'notification', row);
  if (agencyId && agencyId !== companyId) publish(agencyId, 'notification', row);
  return row;
}

function withWorkspaceName(row) {
  const ws = db.prepare('SELECT name FROM companies WHERE id = ?').get(row.company_id);
  return { ...row, workspace_name: ws ? ws.name : null };
}

/** An agency user sees the agency's and all clients' notifications; a client user only their own. */
function list({ companyId, agencyScope, unreadOnly, limit = 50 }) {
  const where = agencyScope ? '(n.agency_id = ? OR n.company_id = ?)' : 'n.company_id = ?';
  const params = agencyScope ? [companyId, companyId] : [companyId];
  const rows = db.prepare(`
    SELECT n.*, c.name AS workspace_name FROM notifications n JOIN companies c ON c.id = n.company_id
    WHERE ${where} ${unreadOnly ? 'AND n.read_at IS NULL' : ''}
    ORDER BY n.created_at DESC LIMIT ?
  `).all(...params, Number(limit));
  const unread = db.prepare(`SELECT COUNT(*) AS n FROM notifications n WHERE ${where} AND n.read_at IS NULL`).get(...params).n;
  return { unread, items: rows };
}

function markRead({ companyId, agencyScope, ids }) {
  const where = agencyScope ? '(agency_id = ? OR company_id = ?)' : 'company_id = ?';
  const params = agencyScope ? [companyId, companyId] : [companyId];
  if (Array.isArray(ids) && ids.length) {
    const stmt = db.prepare(`UPDATE notifications SET read_at = datetime('now') WHERE id = ? AND ${where}`);
    db.transaction(() => ids.forEach(id => stmt.run(id, ...params)))();
  } else {
    db.prepare(`UPDATE notifications SET read_at = datetime('now') WHERE read_at IS NULL AND ${where}`).run(...params);
  }
}

/** Attach an SSE response to a channel; returns an unsubscribe function. */
function subscribe(channelId, res) {
  if (!subscribers.has(channelId)) subscribers.set(channelId, new Set());
  subscribers.get(channelId).add(res);
  const ping = setInterval(() => res.write(': ping\n\n'), 25000);
  return () => {
    clearInterval(ping);
    const set = subscribers.get(channelId);
    if (set) { set.delete(res); if (!set.size) subscribers.delete(channelId); }
  };
}

module.exports = { notify, list, markRead, subscribe, publish, agencyIdFor };
