const express = require('express');
const notifications = require('../services/notificationService');
const { requireAuth, requireAuthFromQuery } = require('../middleware/auth');

const router = express.Router();

// Agency users watch the whole agency (their own + every client's notifications);
// client users only their own workspace.
function scope(req) {
  return req.auth.isAgencyUser
    ? { companyId: req.auth.homeCompanyId, agencyScope: true }
    : { companyId: req.auth.companyId, agencyScope: false };
}

/**
 * GET /api/notifications/stream?token=... - Server-Sent Events. EventSource
 * cannot send an Authorization header, so this one route takes the token
 * from the query string.
 */
router.get('/stream', requireAuthFromQuery, (req, res) => {
  res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache, no-transform', Connection: 'keep-alive', 'X-Accel-Buffering': 'no' });
  res.write(`event: ready\ndata: ${JSON.stringify({ unread: notifications.list({ ...scope(req), unreadOnly: true, limit: 1 }).unread })}\n\n`);
  const unsubscribe = notifications.subscribe(scope(req).companyId, res);
  req.on('close', unsubscribe);
});

router.use(requireAuth);

/** GET /api/notifications?unread=true&limit= */
router.get('/', (req, res) => {
  res.json(notifications.list({ ...scope(req), unreadOnly: req.query.unread === 'true', limit: Math.min(Number(req.query.limit) || 50, 200) }));
});

/** POST /api/notifications/read  body: { ids?: string[] } - omit ids to mark everything read */
router.post('/read', (req, res) => {
  notifications.markRead({ ...scope(req), ids: (req.body || {}).ids });
  res.json(notifications.list({ ...scope(req), unreadOnly: true, limit: 1 }));
});

module.exports = router;
