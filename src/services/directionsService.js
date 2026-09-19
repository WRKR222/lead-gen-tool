/**
 * Per-company "directions" (ICP / geo / scoring / outreach / brand)
 * read/write. Replaces v1's single global config/directions.(default|live).json
 * file - each company now has its own directions stored in
 * companies.ai_profile_json, generated at onboarding by
 * companyProfileService.js and editable afterward from Settings.
 */
const { db } = require('../db/database');
const { SEED } = require('./companyProfileService');

function getDirections(companyId) {
  const row = db.prepare('SELECT ai_profile_json FROM companies WHERE id = ?').get(companyId);
  if (!row || !row.ai_profile_json) return SEED; // should not happen post-onboarding, but never crash
  try {
    return JSON.parse(row.ai_profile_json);
  } catch {
    return SEED;
  }
}

function setDirections(companyId, directions) {
  db.prepare('UPDATE companies SET ai_profile_json = ?, updated_at = datetime(\'now\') WHERE id = ?')
    .run(JSON.stringify(directions), companyId);
  return directions;
}

module.exports = { getDirections, setDirections };
