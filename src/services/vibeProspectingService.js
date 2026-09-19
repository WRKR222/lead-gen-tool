/**
 * Vibe Prospecting (Explorium) client wrapper.
 *
 * Vibe Prospecting is Explorium's prospecting layer, exposed to Claude as
 * an MCP server (tools like fetch-entities, enrich-business,
 * enrich-prospects, match-business, match-prospects, export-to-csv).
 * For a standalone backend service (outside the Claude runtime), talk to
 * Explorium's REST API directly with your own API key.
 *
 * BEFORE GOING LIVE: confirm exact endpoint paths/params against
 * Explorium's current API docs for your plan.
 */
const fetch = require('node-fetch');
const { generateMockEntities } = require('./mockDataService');

const BASE = process.env.EXPLORIUM_API_BASE || 'https://api.explorium.ai/v1';
const API_KEY = process.env.EXPLORIUM_API_KEY;
const MOCK_MODE = !API_KEY || process.env.MOCK_MODE === 'true';

async function request(path, body) {
  if (!API_KEY) throw new Error('EXPLORIUM_API_KEY is not configured');
  const res = await fetch(`${BASE}${path}`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'API_KEY': API_KEY
    },
    body: JSON.stringify(body)
  });
  if (!res.ok) {
    const text = await res.text().catch(() => '');
    throw new Error(`Explorium API error ${res.status}: ${text}`);
  }
  return res.json();
}

/**
 * Fetch businesses and/or prospects matching filters - equivalent to
 * Vibe Prospecting's "fetch-entities". Returns fake data with zero API
 * calls when EXPLORIUM_API_KEY isn't set (demo/testing mode).
 * @param {object} filters - { country, region, city, radiusKm, industries, companySizeMin, companySizeMax, titles }
 * @param {'business'|'prospect'|'both'} mode
 */
async function fetchEntities(filters, mode = 'both', limit = 25) {
  if (MOCK_MODE) return generateMockEntities(filters, Math.min(limit, 10), 'explorium-mock');
  const data = await request('/entities/fetch', { filters, mode, limit });
  const businesses = (data.businesses || []).map(normalizeBusiness);
  const prospects = (data.prospects || []).map(normalizeProspect);
  return { businesses, prospects };
}

async function enrichBusiness(businessId) {
  const data = await request('/entities/enrich-business', { business_id: businessId });
  return normalizeBusiness(data.result || {});
}

async function enrichProspect(prospectId) {
  const data = await request('/entities/enrich-prospect', { prospect_id: prospectId });
  return normalizeProspect(data.result || {});
}

function normalizeBusiness(b) {
  return {
    companyName: b.name || b.business_name || null,
    domain: b.domain || null,
    industry: b.industry || null,
    companySize: b.employees_count || null,
    country: b.country || null,
    region: b.region || null,
    city: b.city || null,
    latitude: b.latitude ?? null,
    longitude: b.longitude ?? null,
    phone: b.phone_number || null,
    source: 'explorium'
  };
}

function normalizeProspect(p) {
  return {
    contactName: p.full_name || null,
    title: p.job_title || null,
    email: p.email || p.business_email || null,
    phone: p.phone_number || p.mobile_phone || null,
    companyName: p.company_name || null,
    companyDomain: p.company_domain || null,
    country: p.country || null,
    source: 'explorium'
  };
}

module.exports = { fetchEntities, enrichBusiness, enrichProspect };
