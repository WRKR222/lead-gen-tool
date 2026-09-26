/**
 * Workspaces: the agency (e.g. Chunguza) and the clients it serves
 * (company X). Creating a workspace runs the whole AI setup - profile
 * (ICP / outreach / brand), value pyramid in local currency, and growth
 * plan - from the description and any uploaded business profile.
 */
const crypto = require('crypto');
const { v4: uuid } = require('uuid');
const { db } = require('../db/database');
const { generateCompanyProfile } = require('./companyProfileService');
const valuePyramid = require('./valuePyramidService');
const strategy = require('./strategyService');
const notifications = require('./notificationService');
const customers = require('./customersService');
const { hashPassword } = require('./authService');
const { currencyForCountry } = require('../config/currencies');
const { getSettings, safeParse } = require('./directionsService');
const { SERVICES, AD_PLATFORMS } = require('../config/playbook');

function slugify(name) {
  return String(name).toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/(^-|-$)/g, '') + '-' + crypto.randomBytes(3).toString('hex');
}

function cleanServices(list) {
  const valid = SERVICES.map(s => s.key);
  return (Array.isArray(list) ? list : []).filter(s => valid.includes(s));
}

function cleanPlatform(p) {
  return AD_PLATFORMS.some(x => x.key === p) ? p : null;
}

function companyInput(row) {
  return {
    name: row.name, kind: row.kind, description: row.description, industry: row.industry, website: row.website,
    homeCountry: row.home_country, homeCity: row.home_city, currency: row.currency, targetMarket: row.target_market,
    businessProfileText: row.business_profile_text, services: parseList(row.services_json), adPlatform: row.ad_platform
  };
}

function parseList(json) {
  try { const v = JSON.parse(json || '[]'); return Array.isArray(v) ? v : []; } catch { return []; }
}

/** (Re)build the AI-generated parts of a workspace. `parts` defaults to all three. */
async function buildAi(companyId, parts = ['profile', 'pyramid', 'plan']) {
  const row = db.prepare('SELECT * FROM companies WHERE id = ?').get(companyId);
  const input = companyInput(row);
  const out = {};
  if (parts.includes('profile')) {
    out.directions = await generateCompanyProfile(input);
    db.prepare("UPDATE companies SET ai_profile_json = ?, onboarding_status = 'ready', updated_at = datetime('now') WHERE id = ?").run(JSON.stringify(out.directions), companyId);
  }
  if (parts.includes('pyramid')) {
    out.valuePyramid = await valuePyramid.generate(input);
    db.prepare("UPDATE companies SET value_pyramid_json = ?, updated_at = datetime('now') WHERE id = ?").run(JSON.stringify(out.valuePyramid), companyId);
    db.prepare("UPDATE leads SET estimated_value = ? WHERE company_id = ? AND status NOT IN ('closed_won','closed_lost')").run(out.valuePyramid.valuePerLead, companyId);
  }
  if (parts.includes('plan')) {
    const pyramid = out.valuePyramid || safeParse(row.value_pyramid_json);
    out.growthPlan = await strategy.generateGrowthPlan(input, pyramid);
    db.prepare("UPDATE companies SET funnel_json = ?, updated_at = datetime('now') WHERE id = ?").run(JSON.stringify(out.growthPlan), companyId);
  }
  return out;
}

/**
 * Insert a workspace row. Used by registration (agency or client) and by
 * an agency adding a client.
 */
function insertCompany(data) {
  const id = uuid();
  const country = (data.homeCountry || 'KE').toUpperCase();
  db.prepare(`INSERT INTO companies (id, name, slug, description, industry, website, home_country, home_city, onboarding_status,
      kind, agency_id, currency, target_market, client_status, client_since, monthly_retainer, services_json, ad_platform,
      business_profile_text, business_profile_filename, business_profile_uploaded_at, baseline_customer_count, baseline_customer_date, inbound_token)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'profiling', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
    .run(id, data.name, slugify(data.name), data.description || null, data.industry || null, data.website || null, country, data.homeCity || null,
      data.kind === 'client' ? 'client' : 'agency', data.agencyId || null, data.currency || currencyForCountry(country),
      data.targetMarket === 'b2c' ? 'b2c' : 'b2b', data.kind === 'client' ? (data.clientStatus || 'onboarding') : null,
      data.kind === 'client' ? new Date().toISOString().slice(0, 10) : null, data.monthlyRetainer != null && data.monthlyRetainer !== '' ? Number(data.monthlyRetainer) : null,
      JSON.stringify(cleanServices(data.services)), cleanPlatform(data.adPlatform),
      data.businessProfileText || null, data.businessProfileFilename || null, data.businessProfileText ? new Date().toISOString() : null,
      data.baselineCustomerCount != null && data.baselineCustomerCount !== '' ? Math.max(0, Number(data.baselineCustomerCount) || 0) : null,
      data.baselineCustomerCount ? new Date().toISOString().slice(0, 10) : null, crypto.randomBytes(18).toString('hex'));
  db.prepare('INSERT OR IGNORE INTO model_weights (company_id, weights_json, samples_seen) VALUES (?, ?, 0)').run(id, JSON.stringify({}));
  return id;
}

async function createClient(agencyId, data) {
  if (!data.name) throw new Error('name is required');
  const id = insertCompany({ ...data, kind: 'client', agencyId });
  await buildAi(id);
  return getWorkspace(id);
}

function getWorkspace(id) {
  const row = db.prepare('SELECT * FROM companies WHERE id = ?').get(id);
  return row ? serialize(row) : null;
}

/** Public shape of a workspace (heavy text columns trimmed). */
function serialize(row) {
  const { ai_profile_json, value_pyramid_json, funnel_json, services_json, settings_json, business_profile_text, inbound_token, ...rest } = row;
  return {
    ...rest,
    directions: safeParse(ai_profile_json),
    value_pyramid: safeParse(value_pyramid_json),
    growth_plan: safeParse(funnel_json),
    services: parseList(services_json),
    settings: getSettings(row.id),
    has_business_profile: !!business_profile_text,
    business_profile_chars: business_profile_text ? business_profile_text.length : 0
  };
}

/** Workspaces a user may open: an agency user gets the agency + its clients. */
function listForUser(homeCompanyId) {
  const home = db.prepare('SELECT id, name, kind, client_status, currency FROM companies WHERE id = ?').get(homeCompanyId);
  if (!home) return [];
  if (home.kind !== 'agency') return [home];
  const clients = db.prepare("SELECT id, name, kind, client_status, currency FROM companies WHERE agency_id = ? AND kind = 'client' ORDER BY name").all(homeCompanyId);
  return [home, ...clients];
}

const DAY = 86400000;

/**
 * 0-100 health score for a client, from the last 30 days of results
 * against its monthly targets. Below 40 = at risk of churning.
 */
function clientHealth(clientId) {
  const since = new Date(Date.now() - 30 * DAY).toISOString();
  const s = getSettings(clientId);
  const leadsNew = db.prepare('SELECT COUNT(*) AS n FROM leads WHERE company_id = ? AND datetime(created_at) >= datetime(?)').get(clientId, since).n;
  const attempts = db.prepare("SELECT COUNT(*) AS n FROM outreach_attempts WHERE company_id = ? AND direction = 'outbound' AND datetime(occurred_at) >= datetime(?)").get(clientId, since).n;
  const replies = db.prepare("SELECT COUNT(*) AS n FROM outreach_attempts WHERE company_id = ? AND result IN ('replied','interested','meeting_booked','converted') AND datetime(occurred_at) >= datetime(?)").get(clientId, since).n;
  const meetings = db.prepare('SELECT COUNT(*) AS n FROM meetings WHERE company_id = ? AND datetime(created_at) >= datetime(?)').get(clientId, since).n
    + db.prepare("SELECT COUNT(*) AS n FROM outreach_attempts WHERE company_id = ? AND result = 'meeting_booked' AND datetime(occurred_at) >= datetime(?)").get(clientId, since).n;
  const conversions = db.prepare("SELECT COUNT(*) AS n FROM leads WHERE company_id = ? AND status = 'closed_won' AND datetime(COALESCE(converted_at, updated_at)) >= datetime(?)").get(clientId, since).n;
  const last = db.prepare('SELECT MAX(occurred_at) AS t FROM outreach_attempts WHERE company_id = ?').get(clientId).t;
  const daysIdle = last ? Math.floor((Date.now() - new Date(last).getTime()) / DAY) : null;

  const leadScore = Math.min(1, leadsNew / Math.max(1, s.monthlyLeadTarget));
  const meetingScore = Math.min(1, meetings / Math.max(1, s.monthlyMeetingTarget));
  const activityScore = daysIdle == null ? 0 : daysIdle <= 3 ? 1 : daysIdle <= 7 ? 0.6 : daysIdle <= 14 ? 0.3 : 0;
  const engagement = attempts ? Math.min(1, (replies / attempts) * 5) : 0;
  const score = Math.round(100 * (0.3 * leadScore + 0.35 * meetingScore + 0.2 * activityScore + 0.15 * engagement) + (conversions ? 5 : 0));
  const clamped = Math.max(0, Math.min(100, score));
  // New clients get two weeks to ramp up before a low score counts as "at risk".
  const clientSince = db.prepare('SELECT client_since FROM companies WHERE id = ?').get(clientId).client_since;
  const ramping = clientSince && Date.now() - new Date(clientSince).getTime() < 14 * DAY;
  const band = clamped >= 70 ? 'healthy' : clamped >= 40 ? 'watch' : ramping ? 'ramping_up' : 'at_risk';
  return {
    score: clamped, band,
    last30: { leadsNew, attempts, replies, meetings, conversions }, targets: { leads: s.monthlyLeadTarget, meetings: s.monthlyMeetingTarget }, daysIdle
  };
}

function listClients(agencyId) {
  return db.prepare("SELECT * FROM companies WHERE agency_id = ? AND kind = 'client' ORDER BY created_at DESC").all(agencyId).map(row => {
    const pyramid = safeParse(row.value_pyramid_json);
    return {
      id: row.id, name: row.name, industry: row.industry, home_city: row.home_city, home_country: row.home_country, currency: row.currency,
      target_market: row.target_market, client_status: row.client_status, client_since: row.client_since, churned_at: row.churned_at,
      churn_reason: row.churn_reason, monthly_retainer: row.monthly_retainer, services: parseList(row.services_json), ad_platform: row.ad_platform,
      value_per_lead: pyramid.valuePerLead ?? null,
      leads_total: db.prepare('SELECT COUNT(*) AS n FROM leads WHERE company_id = ?').get(row.id).n,
      health: row.client_status === 'churned' ? null : clientHealth(row.id)
    };
  });
}

/** Status changes, retainer, services, ad platform; churn is recorded with its reason. */
function updateClient(agencyId, clientId, patch, userId) {
  const row = db.prepare("SELECT * FROM companies WHERE id = ? AND agency_id = ? AND kind = 'client'").get(clientId, agencyId);
  if (!row) return null;
  const status = patch.clientStatus || row.client_status;
  const churning = status === 'churned' && row.client_status !== 'churned';
  db.prepare(`UPDATE companies SET client_status = ?, monthly_retainer = ?, services_json = ?, ad_platform = ?, target_market = ?,
      churned_at = ?, churn_reason = ?, updated_at = datetime('now') WHERE id = ?`)
    .run(status, patch.monthlyRetainer !== undefined ? (patch.monthlyRetainer === '' || patch.monthlyRetainer == null ? null : Number(patch.monthlyRetainer)) : row.monthly_retainer,
      patch.services ? JSON.stringify(cleanServices(patch.services)) : row.services_json,
      patch.adPlatform !== undefined ? cleanPlatform(patch.adPlatform) : row.ad_platform,
      patch.targetMarket ? (patch.targetMarket === 'b2c' ? 'b2c' : 'b2b') : row.target_market,
      churning ? new Date().toISOString() : status === 'churned' ? row.churned_at : null,
      churning ? (patch.churnReason || null) : status === 'churned' ? row.churn_reason : null, clientId);
  if (churning) {
    customers.recordChurn(agencyId, { subjectKind: 'client', clientCompanyId: clientId, reasonCategory: patch.churnReasonCategory || 'other', reasonText: patch.churnReason, recordedBy: userId });
  } else if (row.client_status === 'churned' && status !== 'churned') {
    db.prepare("DELETE FROM churn_events WHERE company_id = ? AND client_company_id = ? AND subject_kind = 'client'").run(agencyId, clientId);
  }
  return getWorkspace(clientId);
}

/** Give company X its own login to its client portal. */
async function inviteClientUser(agencyId, clientId, { name, email, password }) {
  const client = db.prepare("SELECT id FROM companies WHERE id = ? AND agency_id = ? AND kind = 'client'").get(clientId, agencyId);
  if (!client) throw new Error('client not found');
  if (!name || !email || !password) throw new Error('name, email and password are required');
  if (password.length < 8) throw new Error('password must be at least 8 characters');
  const addr = email.toLowerCase();
  if (db.prepare('SELECT 1 FROM users WHERE email = ?').get(addr)) throw new Error('An account with this email already exists');
  const id = uuid();
  db.prepare('INSERT INTO users (id, company_id, name, email, password_hash, role) VALUES (?, ?, ?, ?, ?, ?)')
    .run(id, clientId, name, addr, await hashPassword(password), 'owner');
  return { id, name, email: addr, role: 'owner' };
}

/** Stage 2 done: an agency prospect said yes - create their client workspace. */
async function convertLeadToClient(agencyId, leadId, extra = {}) {
  const lead = db.prepare('SELECT * FROM leads WHERE id = ? AND company_id = ?').get(leadId, agencyId);
  if (!lead) throw new Error('lead not found');
  if (lead.converted_client_id) return getWorkspace(lead.converted_client_id);
  const client = await createClient(agencyId, {
    name: extra.name || lead.company_name || lead.contact_name,
    description: extra.description || [lead.notes, lead.industry && `Industry: ${lead.industry}`].filter(Boolean).join('\n') || null,
    industry: extra.industry || lead.industry, website: extra.website || lead.website,
    homeCountry: extra.homeCountry || lead.country || undefined, homeCity: extra.homeCity || lead.city,
    targetMarket: extra.targetMarket, services: extra.services, adPlatform: extra.adPlatform, monthlyRetainer: extra.monthlyRetainer,
    clientStatus: 'active'
  });
  db.prepare("UPDATE leads SET status = 'closed_won', converted_at = COALESCE(converted_at, ?), converted_client_id = ?, next_follow_up_at = NULL, updated_at = datetime('now') WHERE id = ?")
    .run(new Date().toISOString(), client.id, leadId);
  notifications.notify({ companyId: agencyId, type: 'lead_converted', title: `${client.name} signed as a client`, body: 'Their workspace is ready.', leadId });
  return client;
}

/** Daily sweep: flag clients whose health has dropped. */
function checkClientHealth(agencyId) {
  const flagged = [];
  for (const c of db.prepare("SELECT id, name, client_status FROM companies WHERE agency_id = ? AND kind = 'client' AND client_status IN ('active','onboarding','at_risk')").all(agencyId)) {
    const h = clientHealth(c.id);
    if (h.band === 'at_risk' && c.client_status === 'active') {
      db.prepare("UPDATE companies SET client_status = 'at_risk' WHERE id = ?").run(c.id);
      notifications.notify({ companyId: agencyId, type: 'client_at_risk', title: `${c.name} is at risk`, body: `Health ${h.score}/100 - ${h.last30.meetings} meetings and ${h.last30.leadsNew} new leads in 30 days.` });
      flagged.push(c.id);
    } else if (h.band !== 'at_risk' && c.client_status === 'at_risk') {
      db.prepare("UPDATE companies SET client_status = 'active' WHERE id = ?").run(c.id);
    }
  }
  return flagged;
}

module.exports = {
  insertCompany, buildAi, createClient, getWorkspace, serialize, listForUser, listClients, clientHealth, updateClient,
  inviteClientUser, convertLeadToClient, checkClientHealth, cleanServices, cleanPlatform
};
