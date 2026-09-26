const { verifyToken } = require('../services/authService');
const { db } = require('../db/database');

/**
 * Every tenant-scoped route uses this. Reads `Authorization: Bearer <jwt>`,
 * verifies it, and resolves the WORKSPACE the request acts on:
 *  - by default, the user's own company;
 *  - with an `X-Workspace-Id` header, an agency user may act inside one of
 *    that agency's client workspaces (never anyone else's).
 * It then sets `req.auth = { userId, companyId, homeCompanyId, role,
 * isAgencyUser, workspaceKind }`. Downstream queries filter by
 * `req.auth.companyId` (the resolved workspace) - this stays the single
 * choke point that keeps tenants apart.
 */
function requireAuth(req, res, next) {
  const header = req.headers.authorization || '';
  const token = header.startsWith('Bearer ') ? header.slice(7) : null;
  if (!token) return res.status(401).json({ error: 'Missing Authorization: Bearer <token> header' });
  return authenticate(token, req.headers['x-workspace-id'], req, res, next);
}

/**
 * For EventSource streams, which cannot send headers: token and workspace
 * come from the query string. Only mounted on the SSE route.
 */
function requireAuthFromQuery(req, res, next) {
  const token = req.query.token;
  if (!token) return res.status(401).json({ error: 'Missing token' });
  return authenticate(String(token), req.query.workspace, req, res, next);
}

function authenticate(token, requestedWorkspace, req, res, next) {
  let payload;
  try {
    payload = verifyToken(token);
  } catch (err) {
    return res.status(401).json({ error: 'Invalid or expired token' });
  }

  const home = db.prepare('SELECT id, kind, onboarding_status FROM companies WHERE id = ?').get(payload.companyId);
  if (!home) return res.status(401).json({ error: 'Company no longer exists' });

  let workspace = home;
  if (requestedWorkspace && requestedWorkspace !== home.id) {
    const ws = db.prepare('SELECT id, kind, agency_id, onboarding_status FROM companies WHERE id = ?').get(String(requestedWorkspace));
    if (!ws || home.kind !== 'agency' || ws.agency_id !== home.id) {
      return res.status(403).json({ error: 'You do not have access to that workspace' });
    }
    workspace = ws;
  }

  req.auth = {
    userId: payload.userId,
    companyId: workspace.id,
    homeCompanyId: home.id,
    role: payload.role,
    isAgencyUser: home.kind === 'agency',
    workspaceKind: workspace.kind
  };
  req.company = workspace;
  next();
}

/** Gate an action to owner/admin roles only. */
function requireRole(...roles) {
  return (req, res, next) => {
    if (!req.auth || !roles.includes(req.auth.role)) {
      return res.status(403).json({ error: `Requires role: ${roles.join(' or ')}` });
    }
    next();
  };
}

/** Agency-only actions (managing clients, agency analytics). */
function requireAgencyUser(req, res, next) {
  if (!req.auth || !req.auth.isAgencyUser) return res.status(403).json({ error: 'Agency accounts only' });
  next();
}

module.exports = { requireAuth, requireAuthFromQuery, requireRole, requireAgencyUser };
