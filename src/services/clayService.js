/**
 * Clay client wrapper.
 *
 * Clay's public API surface changes fairly often, and workspaces can be
 * wired up either via Clay's HTTP API/webhooks or via Clay's MCP server
 * (used when this tool is orchestrated through Claude directly). This
 * wrapper gives the rest of the app a stable interface -
 * `searchCompanies`, `searchContacts`, `enrichCompany`, `enrichContact` -
 * so you can swap the transport without touching business logic.
 *
 * BEFORE GOING LIVE: confirm the exact endpoint paths, auth header, and
 * response shape against Clay's current developer docs for your workspace
 * plan, and adjust the `request()` calls below accordingly.
 */
const fetch = require('node-fetch');
const { generateMockEntities } = require('./mockDataService');

const CLAY_API_BASE = process.env.CLAY_API_BASE || 'https://api.clay.com/v3';
const CLAY_API_KEY = process.env.CLAY_API_KEY;
const CLAY_WORKSPACE_ID = process.env.CLAY_WORKSPACE_ID;
const MOCK_MODE = !CLAY_API_KEY || process.env.MOCK_MODE === 'true';

async function request(path, { method = 'POST', body } = {}) {
  if (!CLAY_API_KEY) throw new Error('CLAY_API_KEY is not configured');
  const res = await fetch(`${CLAY_API_BASE}${path}`, {
    method,
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${CLAY_API_KEY}`,
      'X-Workspace-Id': CLAY_WORKSPACE_ID || ''
    },
    body: body ? JSON.stringify(body) : undefined
  });
  if (!res.ok) {
    const text = await res.text().catch(() => '');
    throw new Error(`Clay API error ${res.status}: ${text}`);
  }
  return res.json();
}

/**
 * Search for companies matching filters. Maps to Clay's company search
 * (equivalent to the "search-companies" capability). Returns fake data
 * with zero API calls when CLAY_API_KEY isn't set (demo/testing mode).
 * @param {object} filters - { country, city, radiusKm, industries, companySizeMin, companySizeMax, keywords }
 * @param {number} limit
 */
async function searchCompanies(filters, limit = 25) {
  if (MOCK_MODE) return generateMockEntities(filters, Math.min(limit, 10), 'clay-mock').businesses;
  const data = await request('/companies/search', {
    body: { filters, limit }
  });
  return (data.results || []).map(normalizeCompany);
}

/**
 * Search for contacts (people) at companies matching filters. Maps to
 * Clay's "search-contacts" capability. Returns fake data with zero API
 * calls when CLAY_API_KEY isn't set (demo/testing mode).
 */
async function searchContacts(filters, limit = 25) {
  if (MOCK_MODE) return generateMockEntities(filters, Math.min(limit, 10), 'clay-mock').prospects;
  const data = await request('/contacts/search', {
    body: { filters, limit }
  });
  return (data.results || []).map(normalizeContact);
}

async function enrichCompany(domainOrName) {
  const data = await request('/companies/enrich', { body: { query: domainOrName } });
  return normalizeCompany(data.result || {});
}

async function enrichContact(nameOrEmail, companyDomain) {
  const data = await request('/contacts/enrich', { body: { query: nameOrEmail, companyDomain } });
  return normalizeContact(data.result || {});
}

function normalizeCompany(c) {
  return {
    companyName: c.name || c.company_name || null,
    domain: c.domain || null,
    industry: c.industry || null,
    companySize: c.employee_count || c.company_size || null,
    country: c.country || null,
    region: c.region || null,
    city: c.city || null,
    latitude: c.latitude ?? null,
    longitude: c.longitude ?? null,
    phone: c.phone || null,
    source: 'clay'
  };
}

function normalizeContact(p) {
  return {
    contactName: p.full_name || p.name || null,
    title: p.title || null,
    email: p.email || null,
    phone: p.phone || p.mobile_phone || null,
    companyName: p.company_name || null,
    companyDomain: p.company_domain || null,
    country: p.country || null,
    source: 'clay'
  };
}

module.exports = { searchCompanies, searchContacts, enrichCompany, enrichContact };
