/**
 * Web-research lead source: finds companies/contacts via a licensed web
 * search API (not scraping) and uses an LLM to extract structured facts
 * from the public snippets/pages that come back. This is what lets
 * discovery reach "anywhere" - public company sites, press coverage,
 * directories, and any publicly-indexed social/professional profile page
 * - without scraping a platform in violation of its Terms of Service.
 *
 * Configure ONE search provider:
 *   SEARCH_PROVIDER=serpapi   + SERPAPI_API_KEY
 *   SEARCH_PROVIDER=bing      + BING_SEARCH_API_KEY
 * With neither key set (or MOCK_MODE=true), falls back to realistic mock
 * results so discovery keeps working end-to-end for free in demo mode.
 *
 * BEFORE GOING LIVE: confirm current endpoint/response shape against your
 * chosen provider's docs - same caveat as clayService.js/vibeProspectingService.js.
 */
const fetch = require('node-fetch');
const { generateMockEntities } = require('./mockDataService');

const SEARCH_PROVIDER = process.env.SEARCH_PROVIDER || 'serpapi';
const SERPAPI_API_KEY = process.env.SERPAPI_API_KEY;
const BING_SEARCH_API_KEY = process.env.BING_SEARCH_API_KEY;
const ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY;
const ANTHROPIC_MODEL = process.env.ANTHROPIC_MODEL || 'claude-sonnet-5';

const HAS_SEARCH_KEY = (SEARCH_PROVIDER === 'serpapi' && SERPAPI_API_KEY) || (SEARCH_PROVIDER === 'bing' && BING_SEARCH_API_KEY);
const MOCK_MODE = !HAS_SEARCH_KEY || !ANTHROPIC_API_KEY || process.env.MOCK_MODE === 'true';

function buildQuery(filters) {
  const parts = [];
  if (filters.industries && filters.industries.length) parts.push(filters.industries[0]);
  parts.push('company');
  if (filters.city) parts.push(`in ${filters.city}`);
  else if (filters.country) parts.push(`in ${filters.country}`);
  else if (filters.continent) parts.push(`in ${filters.continent}`);
  if (filters.titles && filters.titles.length) parts.push(filters.titles[0]);
  return parts.join(' ');
}

async function runSearch(query, limit) {
  if (SEARCH_PROVIDER === 'bing') {
    const res = await fetch(`https://api.bing.microsoft.com/v7.0/search?q=${encodeURIComponent(query)}&count=${limit}`, {
      headers: { 'Ocp-Apim-Subscription-Key': BING_SEARCH_API_KEY }
    });
    if (!res.ok) throw new Error(`Bing search error ${res.status}`);
    const data = await res.json();
    return (data.webPages?.value || []).map(r => ({ title: r.name, snippet: r.snippet, url: r.url }));
  }
  // default: serpapi
  const url = `https://serpapi.com/search.json?engine=google&q=${encodeURIComponent(query)}&num=${limit}&api_key=${SERPAPI_API_KEY}`;
  const res = await fetch(url);
  if (!res.ok) throw new Error(`SerpApi error ${res.status}`);
  const data = await res.json();
  return (data.organic_results || []).map(r => ({ title: r.title, snippet: r.snippet, url: r.link }));
}

async function extractEntitiesWithAI(results, filters) {
  const prompt = `From these public search results, extract plausible companies and, where a named individual with a role/title is mentioned, a contact person. \
Only use facts actually present or strongly implied in the text below - never invent emails, phone numbers, or names not present. Leave a field null if unknown. \
Return ONLY JSON: {"businesses":[{"companyName":"","domain":null,"industry":null,"companySize":null,"country":null,"city":null,"phone":null}],"prospects":[{"contactName":"","title":null,"email":null,"phone":null,"companyName":"","companyDomain":null,"country":null,"linkedinUrl":null}]}. No markdown, no preamble.

FILTERS USED: ${JSON.stringify(filters)}

SEARCH RESULTS:
${results.map((r, i) => `${i + 1}. ${r.title}\n${r.snippet}\n${r.url}`).join('\n\n')}`;

  const res = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'x-api-key': ANTHROPIC_API_KEY, 'anthropic-version': '2023-06-01' },
    body: JSON.stringify({ model: ANTHROPIC_MODEL, max_tokens: 1500, temperature: 0.2, messages: [{ role: 'user', content: prompt }] })
  });
  if (!res.ok) throw new Error(`Anthropic extraction error ${res.status}`);
  const data = await res.json();
  const textBlock = (data.content || []).find(b => b.type === 'text');
  if (!textBlock) throw new Error('No extraction returned');
  const cleaned = textBlock.text.replace(/```json|```/g, '').trim();
  const parsed = JSON.parse(cleaned);
  return {
    businesses: (parsed.businesses || []).map(b => ({ ...b, source: 'web_research' })),
    prospects: (parsed.prospects || []).map(p => ({ ...p, source: 'web_research' }))
  };
}

/**
 * @param {object} filters - same shape as clay/explorium filters
 * @param {number} limit
 * @returns {Promise<{businesses: object[], prospects: object[]}>}
 */
async function searchViaWeb(filters, limit = 15) {
  if (MOCK_MODE) return generateMockEntities(filters, Math.min(limit, 8), 'web-research-mock');

  const query = buildQuery(filters);
  const results = await runSearch(query, Math.min(limit, 20));
  if (!results.length) return { businesses: [], prospects: [] };
  return extractEntitiesWithAI(results, filters);
}

module.exports = { searchViaWeb, buildQuery };
