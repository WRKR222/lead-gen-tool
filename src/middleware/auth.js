const { verifyToken } = require('../services/authService');
const { db } = require('../db/database');

/**
 * Every tenant-scoped route uses this. Reads `Authorization: Bearer <jwt>`,
 * verifies it, and attaches `req.auth = { userId, companyId, role }`. All
 * downstream queries filter by `req.auth.companyId` - this is the single
 * choke point that keeps one company's data from ever being visible to
 * another's.
 */
function requireAuth(req, res, next) {
  const header = req.headers.authorization || '';
  const token = header.startsWith('Bearer ') ? header.slice(7) : null;
  if (!token) return res.status(401).json({ error: 'Missing Authorization: Bearer <token> header' });

  let payload;
  try {
    payload = verifyToken(token);
  } catch (err) {
    return res.status(401).json({ error: 'Invalid or expired token' });
  }

  const company = db.prepare('SELECT id, onboarding_status FROM companies WHERE id = ?').get(payload.companyId);
  if (!company) return res.status(401).json({ error: 'Company no longer exists' });

  req.auth = { userId: payload.userId, companyId: payload.companyId, role: payload.role };
  req.company = company;
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

module.exports = { requireAuth, requireRole };
