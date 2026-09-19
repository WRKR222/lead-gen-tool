const path = require('path');
const fs = require('fs');
const Database = require('better-sqlite3');

const DB_PATH = process.env.SQLITE_PATH || path.join(__dirname, '..', '..', 'data', 'leadgen.db');
fs.mkdirSync(path.dirname(DB_PATH), { recursive: true });

const db = new Database(DB_PATH);
db.pragma('journal_mode = WAL');
db.pragma('foreign_keys = ON');

/**
 * v1 -> v2 (multi-tenant) upgrade guard.
 *
 * v1 of this tool was single-tenant: `leads`, `campaigns`, `model_weights`,
 * `warmup_state` and `suppression_list` had no `company_id`. v2 makes every
 * business table tenant-scoped. If we detect an old-shape `leads` table
 * (exists, but missing `company_id`), we rename the old tables out of the
 * way instead of silently corrupting them - schema.sql then creates the
 * new v2 tables fresh. Your old rows are preserved under `<table>_v1_backup`
 * for manual export; nothing is deleted.
 */
function upgradeGuard() {
  const hasLeadsTable = db.prepare(`SELECT name FROM sqlite_master WHERE type='table' AND name='leads'`).get();
  if (!hasLeadsTable) return; // fresh install, nothing to guard

  const columns = db.prepare(`PRAGMA table_info(leads)`).all().map(c => c.name);
  if (columns.includes('company_id')) return; // already v2

  console.warn('[migrate] Detected pre-multi-tenant (v1) database. Renaming old tables to *_v1_backup and creating fresh v2 (multi-tenant) tables. Your old data is preserved, not deleted - export it manually from the *_v1_backup tables if you need it.');
  const legacyTables = ['leads', 'campaigns', 'campaign_sends', 'feedback_events', 'model_weights', 'warmup_state', 'suppression_list'];
  const existing = new Set(db.prepare(`SELECT name FROM sqlite_master WHERE type='table'`).all().map(r => r.name));
  const rename = db.transaction(() => {
    for (const t of legacyTables) {
      if (existing.has(t)) db.exec(`ALTER TABLE ${t} RENAME TO ${t}_v1_backup`);
    }
  });
  rename();
}

function migrate() {
  upgradeGuard();
  const schema = fs.readFileSync(path.join(__dirname, 'schema.sql'), 'utf8');
  db.exec(schema);
}

module.exports = { db, migrate, DB_PATH };
