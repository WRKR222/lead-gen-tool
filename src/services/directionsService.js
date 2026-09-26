/**
 * Per-company "directions" (ICP / geo / scoring / outreach / brand)
 * read/write. Replaces v1's single global config/directions.(default|live).json
 * file - each company now has its own directions stored in
 * companies.ai_profile_json, generated at onboarding by
 * companyProfileService.js and editable afterward from Settings.
 */
const { db } = require('../db/database');
const { SEED } = require('./companyProfileService');

const { DEFAULT_SETTINGS } = require('../config/playbook');

function getDirections(companyId) {
  const row = db.prepare('SELECT ai_profile_json, settings_json FROM companies WHERE id = ?').get(companyId);
  if (!row || !row.ai_profile_json) return SEED; // should not happen post-onboarding, but never crash
  let directions;
  try { directions = JSON.parse(row.ai_profile_json); } catch { return SEED; }
  const bookingLink = safeParse(row.settings_json).bookingLink;
  return bookingLink ? { ...directions, bookingLink } : directions;
}

function setDirections(companyId, directions) {
  const { bookingLink, ...rest } = directions;
  db.prepare('UPDATE companies SET ai_profile_json = ?, updated_at = datetime(\'now\') WHERE id = ?')
    .run(JSON.stringify(rest), companyId);
  return directions;
}

function safeParse(json) {
  try { return JSON.parse(json || '{}') || {}; } catch { return {}; }
}

/** Per-workspace operational settings (auto-reply, cadence, targets, integrations), defaults filled in. */
function getSettings(companyId) {
  const row = db.prepare('SELECT settings_json FROM companies WHERE id = ?').get(companyId);
  const saved = safeParse(row && row.settings_json);
  return {
    ...DEFAULT_SETTINGS, ...saved,
    highlevel: { ...DEFAULT_SETTINGS.highlevel, ...(saved.highlevel || {}) },
    appointwise: { ...DEFAULT_SETTINGS.appointwise, ...(saved.appointwise || {}) },
    cadence: { ...DEFAULT_SETTINGS.cadence, ...(saved.cadence || {}) }
  };
}

function setSettings(companyId, patch) {
  const current = getSettings(companyId);
  const next = {
    ...current, ...patch,
    highlevel: { ...current.highlevel, ...(patch.highlevel || {}) },
    appointwise: { ...current.appointwise, ...(patch.appointwise || {}) },
    cadence: { ...current.cadence, ...(patch.cadence || {}) }
  };
  db.prepare("UPDATE companies SET settings_json = ?, updated_at = datetime('now') WHERE id = ?").run(JSON.stringify(next), companyId);
  return next;
}

module.exports = { getDirections, setDirections, getSettings, setSettings, safeParse };
