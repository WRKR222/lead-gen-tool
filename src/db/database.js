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

/**
 * v2 -> v3 (agency model). Columns added to tables that already exist on
 * deployed databases; fresh installs get them from schema.sql directly.
 * Every step is idempotent so `npm run migrate` stays safe on every deploy.
 */
const V3_COLUMNS = {
  companies: {
    kind: "TEXT DEFAULT 'agency'", agency_id: 'TEXT', currency: 'TEXT', target_market: "TEXT DEFAULT 'b2b'",
    client_status: 'TEXT', client_since: 'TEXT', churned_at: 'TEXT', churn_reason: 'TEXT', monthly_retainer: 'REAL',
    services_json: 'TEXT', ad_platform: 'TEXT', value_pyramid_json: 'TEXT', funnel_json: 'TEXT',
    business_profile_text: 'TEXT', business_profile_filename: 'TEXT', business_profile_uploaded_at: 'TEXT',
    baseline_customer_count: 'INTEGER', baseline_customer_date: 'TEXT', settings_json: 'TEXT', inbound_token: 'TEXT'
  },
  leads: {
    lead_type: "TEXT DEFAULT 'business'", website: 'TEXT', address: 'TEXT', preferred_methods_json: 'TEXT',
    last_contacted_at: 'TEXT', next_follow_up_at: 'TEXT', follow_up_count: 'INTEGER DEFAULT 0',
    follow_up_paused: 'INTEGER DEFAULT 0', lost_reason_category: 'TEXT', lost_reason: 'TEXT', estimated_value: 'REAL',
    converted_at: 'TEXT', converted_client_id: 'TEXT', converted_customer_id: 'TEXT', assigned_to: 'TEXT'
  },
  meetings: {
    meeting_type: "TEXT DEFAULT 'call'", cps_brief_json: 'TEXT', cps_notes_json: 'TEXT', outcome: 'TEXT', quoted_price: 'REAL'
  }
};

function addMissingColumns() {
  for (const [table, cols] of Object.entries(V3_COLUMNS)) {
    const existing = new Set(db.prepare(`PRAGMA table_info(${table})`).all().map(c => c.name));
    for (const [name, type] of Object.entries(cols)) {
      if (!existing.has(name)) db.exec(`ALTER TABLE ${table} ADD COLUMN ${name} ${type}`);
    }
  }
}

// v2 declared leads.company_name NOT NULL, but a B2C client's leads are
// people (e.g. a dental practice's prospective patients). SQLite can't
// drop a NOT NULL in place, so rebuild the table once, following SQLite's
// documented create-copy-drop-rename procedure. Rows are copied verbatim.
function relaxLeadCompanyName() {
  const col = db.prepare('PRAGMA table_info(leads)').all().find(c => c.name === 'company_name');
  if (!col || col.notnull === 0) return;
  const { sql } = db.prepare("SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'leads'").get();
  const newSql = sql
    .replace(/CREATE TABLE\s+(IF NOT EXISTS\s+)?["`]?leads["`]?/i, 'CREATE TABLE leads_v3_rebuild')
    .replace(/company_name\s+TEXT\s+NOT\s+NULL/i, 'company_name TEXT');
  const indexes = db.prepare("SELECT sql FROM sqlite_master WHERE type = 'index' AND tbl_name = 'leads' AND sql IS NOT NULL").all();

  db.pragma('foreign_keys = OFF');
  try {
    db.transaction(() => {
      db.exec(newSql);
      db.exec('INSERT INTO leads_v3_rebuild SELECT * FROM leads');
      db.exec('DROP TABLE leads');
      db.exec('ALTER TABLE leads_v3_rebuild RENAME TO leads');
      for (const idx of indexes) db.exec(idx.sql);
    })();
  } finally {
    db.pragma('foreign_keys = ON');
  }
  console.log('[migrate] leads.company_name is now nullable (person leads supported).');
}

function backfillV3() {
  const { currencyForCountry } = require('../config/currencies');
  const crypto = require('crypto');
  for (const c of db.prepare('SELECT id, home_country FROM companies WHERE currency IS NULL').all()) {
    db.prepare('UPDATE companies SET currency = ? WHERE id = ?').run(currencyForCountry(c.home_country), c.id);
  }
  for (const c of db.prepare('SELECT id FROM companies WHERE inbound_token IS NULL').all()) {
    db.prepare('UPDATE companies SET inbound_token = ? WHERE id = ?').run(crypto.randomBytes(18).toString('hex'), c.id);
  }
  // Seed lead_contacts from the single email/phone/LinkedIn columns v2 had.
  const orphans = db.prepare(`
    SELECT l.* FROM leads l WHERE NOT EXISTS (SELECT 1 FROM lead_contacts lc WHERE lc.lead_id = l.id)
      AND (l.email IS NOT NULL OR l.phone IS NOT NULL OR l.linkedin_url IS NOT NULL)
  `).all();
  const insert = db.prepare(`INSERT INTO lead_contacts (id, company_id, lead_id, channel, value, person_name, person_role, is_primary, source)
    VALUES (?, ?, ?, ?, ?, ?, ?, 1, 'migrated')`);
  db.transaction(() => {
    for (const l of orphans) {
      for (const [channel, value] of [['email', l.email], ['phone', l.phone], ['linkedin', l.linkedin_url]]) {
        if (value) insert.run(crypto.randomUUID(), l.company_id, l.id, channel, value, l.contact_name, l.title);
      }
    }
  })();
}

function migrate() {
  upgradeGuard();
  const schema = fs.readFileSync(path.join(__dirname, 'schema.sql'), 'utf8');
  db.exec(schema);
  addMissingColumns();
  relaxLeadCompanyName();
  backfillV3();
}

module.exports = { db, migrate, DB_PATH };
