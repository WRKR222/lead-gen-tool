/**
 * Lead-source registry.
 *
 * v1 only pulled from Clay + Explorium (Vibe Prospecting). Real-world
 * prospecting shouldn't be locked to two vendors, so every source is
 * registered here behind one common interface -
 * `search(filters, limit) -> { businesses: [], prospects: [] }` - and
 * `/api/leads/discover` fans a request out to every ENABLED source in
 * parallel, merging and de-duplicating the results (see routes/leads.js).
 *
 * Adding a new provider (Apollo.io, Hunter.io, ZoomInfo, Lusha, a
 * licensed company-registry feed, LinkedIn's official Sales Navigator/
 * Talent/Marketing APIs, a CRM import, etc.) means writing one file with
 * this same interface and adding one line below - nothing else in the app
 * changes.
 *
 * A note on "information can be found anywhere, even LinkedIn/social
 * media": that's true, but scraping LinkedIn (or most social platforms)
 * directly breaks their Terms of Service and can carry real legal risk,
 * so this tool deliberately does NOT include a LinkedIn/social-media
 * scraper. Instead: `webResearchService` uses licensed web-search APIs
 * (SerpApi/Bing/Google Programmable Search) to find and read PUBLIC
 * pages/snippets (including public LinkedIn/company pages that already
 * appear in search results) and an LLM to extract structured company/
 * contact facts from them - and `csvImportService` lets a company bring
 * in leads it already sourced (a licensed export, a trade-show list, a
 * referral list, a CRM extract). For LinkedIn specifically, the
 * compliant path is LinkedIn's own official APIs/Sales Navigator, which a
 * company can wire in here as another provider once they have that access.
 */
const clay = require('./clayService');
const vibe = require('./vibeProspectingService');
const webResearch = require('./webResearchLeadService');

const SOURCES = {
  clay: {
    key: 'clay',
    label: 'Clay',
    enabled: () => process.env.DISABLE_CLAY !== 'true',
    async search(filters, limit) {
      const [companies, contacts] = await Promise.all([
        clay.searchCompanies(filters, limit).catch(() => []),
        clay.searchContacts(filters, limit).catch(() => [])
      ]);
      return { businesses: companies, prospects: contacts };
    }
  },
  explorium: {
    key: 'explorium',
    label: 'Explorium / Vibe Prospecting',
    enabled: () => process.env.DISABLE_EXPLORIUM !== 'true',
    async search(filters, limit) {
      return vibe.fetchEntities(filters, 'both', limit).catch(() => ({ businesses: [], prospects: [] }));
    }
  },
  web_research: {
    key: 'web_research',
    label: 'Web research (search + AI extraction)',
    enabled: () => process.env.DISABLE_WEB_RESEARCH !== 'true',
    async search(filters, limit) {
      return webResearch.searchViaWeb(filters, limit).catch(() => ({ businesses: [], prospects: [] }));
    }
  }
};

function listSources() {
  return Object.values(SOURCES).map(s => ({ key: s.key, label: s.label, enabled: s.enabled() }));
}

/**
 * Run every enabled source (or a specific subset via `only`) in parallel
 * and return the raw, un-merged results per source - callers merge/
 * de-duplicate (routes/leads.js already has mergeResults for this).
 */
async function searchAll(filters, limit = 25, only = null) {
  const active = Object.values(SOURCES).filter(s => s.enabled() && (!only || only.includes(s.key)));
  const results = await Promise.all(active.map(s => s.search(filters, limit)));
  return active.map((s, i) => ({ source: s.key, ...results[i] }));
}

module.exports = { SOURCES, listSources, searchAll };
