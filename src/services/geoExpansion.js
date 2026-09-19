/**
 * Geographic targeting.
 *
 * Two modes, both supported side by side:
 *
 *  1. AUTO-EXPANSION (v1 behavior, still the default when no explicit scope
 *     is requested): Tier 1 = home country only, Tier 2 = same
 *     region/continent widening by radius, Tier 3 = global. The engine
 *     only advances once the current tier stops producing enough
 *     qualified leads (thresholds in that company's directions).
 *
 *  2. EXPLICIT SCOPE (new - what the dashboard's geo picker uses): a
 *     company can just pick "Nairobi", "Kenya", "East Africa", "Africa" or
 *     "Global" directly for a one-off search, without touching the
 *     auto-expansion state. This is what satisfies "search for possible
 *     prospects within Nairobi, Nationally, Across Eastern Africa, Africa
 *     or globally" on demand.
 */

// Minimal continent map for common countries; extend as needed, or swap
// for a proper ISO-3166 / continent lookup library in production.
const CONTINENT_BY_COUNTRY = {
  KE: 'Africa', NG: 'Africa', ZA: 'Africa', UG: 'Africa', TZ: 'Africa', GH: 'Africa', ET: 'Africa', RW: 'Africa', EG: 'Africa', MA: 'Africa',
  BI: 'Africa', SS: 'Africa', CD: 'Africa', SO: 'Africa', DJ: 'Africa', ZM: 'Africa', MW: 'Africa', MZ: 'Africa', SN: 'Africa', CI: 'Africa',
  US: 'North America', CA: 'North America', MX: 'North America',
  GB: 'Europe', DE: 'Europe', FR: 'Europe', ES: 'Europe', IT: 'Europe', NL: 'Europe', SE: 'Europe', PL: 'Europe',
  IN: 'Asia', CN: 'Asia', JP: 'Asia', SG: 'Asia', AE: 'Asia', SA: 'Asia', ID: 'Asia', PH: 'Asia',
  AU: 'Oceania', NZ: 'Oceania',
  BR: 'South America', AR: 'South America', CL: 'South America', CO: 'South America'
};

// East African Community (Kenya, Uganda, Tanzania, Rwanda, Burundi, South
// Sudan, DR Congo) plus the wider Horn/East Africa geographic neighborhood
// (Ethiopia, Somalia, Djibouti) commonly included in "East Africa" B2B
// prospecting scopes.
const EAST_AFRICA_COUNTRIES = ['KE', 'UG', 'TZ', 'RW', 'BI', 'SS', 'CD', 'ET', 'SO', 'DJ'];

const NAMED_SCOPES = ['nairobi', 'kenya', 'east_africa', 'africa', 'global'];

function continentOf(countryCode) {
  return CONTINENT_BY_COUNTRY[countryCode] || 'Unknown';
}

/**
 * Resolve one of the dashboard's named geo scopes into search filters.
 * @param {string} scope - 'nairobi' | 'kenya' | 'east_africa' | 'africa' | 'global'
 * @param {object} home - { homeCountry, homeCity } from the company's directions
 */
function resolveScope(scope, home = {}) {
  const homeCountry = home.homeCountry || 'KE';
  const homeCity = home.homeCity || 'Nairobi';

  switch (scope) {
    case 'nairobi':
      return { scope, tierLabel: 1, filters: { country: homeCountry, city: homeCity } };
    case 'kenya':
      return { scope, tierLabel: 1, filters: { country: homeCountry } };
    case 'east_africa':
      return { scope, tierLabel: 2, filters: { countries: EAST_AFRICA_COUNTRIES, excludeCountry: null } };
    case 'africa':
      return { scope, tierLabel: 2, filters: { continent: 'Africa' } };
    case 'global':
      return { scope, tierLabel: 3, filters: { global: true } };
    default:
      throw new Error(`Unknown geoScope "${scope}". Valid: ${NAMED_SCOPES.join(', ')}`);
  }
}

/**
 * @param {object} geoStrategy - directions.json geoStrategy block
 * @param {object} tierState - { tier: 1|2|3, currentRadiusKm, lastTierResultCount, lastTierAvgScore }
 * @returns {object} next search spec: { tier, filters, radiusKm }
 */
function nextSearchSpec(geoStrategy, tierState) {
  const { homeCountry, radiusKmStart, radiusKmStep, radiusKmMax, advanceToNextTierWhen } = geoStrategy;
  let { tier, currentRadiusKm } = tierState;

  tier = tier || 1;
  currentRadiusKm = currentRadiusKm || radiusKmStart;

  const exhausted =
    tierState.lastTierResultCount !== undefined &&
    (tierState.lastTierResultCount < advanceToNextTierWhen.minLeadsFoundBelowThreshold ||
      (tierState.lastTierAvgScore !== undefined &&
        tierState.lastTierAvgScore < advanceToNextTierWhen.orQualityScoreBelow));

  if (tier === 1) {
    if (exhausted) {
      tier = 2;
      currentRadiusKm = radiusKmStart;
    }
  } else if (tier === 2) {
    if (exhausted) {
      if (currentRadiusKm + radiusKmStep <= radiusKmMax) {
        currentRadiusKm += radiusKmStep; // widen radius within region first
      } else {
        tier = 3; // region exhausted at max radius -> go global
      }
    }
  }
  // tier 3 (global) has no further expansion - it's the ceiling.

  const filters = { };
  if (tier === 1) {
    filters.country = homeCountry;
  } else if (tier === 2) {
    filters.continent = continentOf(homeCountry);
    filters.excludeCountry = homeCountry;
    filters.radiusKm = currentRadiusKm;
  } else {
    filters.global = true;
  }

  return { tier, radiusKm: tier === 2 ? currentRadiusKm : null, filters };
}

module.exports = { nextSearchSpec, continentOf, resolveScope, NAMED_SCOPES, EAST_AFRICA_COUNTRIES };
