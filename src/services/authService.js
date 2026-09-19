/**
 * Auth: bcrypt password hashing + JWT session tokens.
 *
 * Deliberately simple (one workspace = one company, users belong to
 * exactly one company, roles are owner/admin/member) because the product
 * requirement is "any company can sign up and get its own isolated
 * workspace", not a complex permissions system. Swap for a fuller
 * auth provider (Auth0/Clerk/Cognito) later without touching the rest of
 * the app - every route only depends on `req.auth = { userId, companyId, role }`
 * set by middleware/auth.js.
 */
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');

const JWT_SECRET = process.env.JWT_SECRET || 'dev-only-insecure-secret-change-me';
const JWT_EXPIRES_IN = process.env.JWT_EXPIRES_IN || '30d';

if (!process.env.JWT_SECRET && process.env.NODE_ENV === 'production') {
  console.warn('[auth] WARNING: JWT_SECRET is not set. Using an insecure default - set JWT_SECRET in production.');
}

async function hashPassword(plain) {
  return bcrypt.hash(plain, 10);
}

async function verifyPassword(plain, hash) {
  return bcrypt.compare(plain, hash);
}

function signToken(payload) {
  return jwt.sign(payload, JWT_SECRET, { expiresIn: JWT_EXPIRES_IN });
}

function verifyToken(token) {
  return jwt.verify(token, JWT_SECRET);
}

module.exports = { hashPassword, verifyPassword, signToken, verifyToken };
