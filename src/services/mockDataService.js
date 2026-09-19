/**
 * Generates realistic-looking fake companies/contacts so the whole app
 * (discovery -> scoring -> geo expansion -> email generation -> feedback
 * loop) can be exercised with zero external API calls and zero cost.
 * Used by clayService.js and vibeProspectingService.js when their
 * respective API keys aren't configured (MOCK_MODE).
 *
 * This is for local testing/demos only - swap in real credentials for
 * production data.
 */
const FIRST_NAMES = ['Amara', 'Kevin', 'Priya', 'James', 'Wanjiru', 'Liam', 'Fatima', 'Noah', 'Chidi', 'Elena', 'David', 'Aisha'];
const LAST_NAMES = ['Otieno', 'Smith', 'Patel', 'Mwangi', 'Chen', 'Kariuki', 'Johnson', 'Diallo', 'Rossi', 'Nakamura', 'Garcia', 'Owusu'];
const COMPANY_WORDS = ['Bright', 'Summit', 'Nova', 'Vertex', 'Prime', 'Clear', 'North', 'Blue', 'Rapid', 'Core', 'Bright', 'Zenith'];
const COMPANY_SUFFIX = ['Labs', 'Solutions', 'Technologies', 'Systems', 'Group', 'Works', 'Digital', 'Partners'];
const TITLES = ['CEO', 'Founder', 'VP Sales', 'Head of Growth', 'CTO', 'Director of Operations', 'VP Marketing', 'COO'];
const INDUSTRIES = ['software', 'saas', 'fintech', 'e-commerce', 'healthtech', 'logistics'];

const COUNTRY_CITY = {
  KE: [['Nairobi', -1.2921, 36.8219], ['Mombasa', -4.0435, 39.6682]],
  UG: [['Kampala', 0.3476, 32.5825]],
  TZ: [['Dar es Salaam', -6.7924, 39.2083]],
  NG: [['Lagos', 6.5244, 3.3792]],
  ZA: [['Johannesburg', -26.2041, 28.0473]],
  US: [['Austin', 30.2672, -97.7431], ['New York', 40.7128, -74.0060]],
  GB: [['London', 51.5072, -0.1276]],
  IN: [['Bangalore', 12.9716, 77.5946]],
  DE: [['Berlin', 52.5200, 13.4050]]
};

function pick(arr) { return arr[Math.floor(Math.random() * arr.length)]; }

function fakeCompanyName() {
  return `${pick(COMPANY_WORDS)}${pick(COMPANY_SUFFIX)}`;
}

function countryForTier(filters) {
  if (filters.country) return filters.country;
  if (Array.isArray(filters.countries) && filters.countries.length) {
    const inCatalog = filters.countries.filter(c => COUNTRY_CITY[c]);
    return pick(inCatalog.length ? inCatalog : filters.countries);
  }
  if (filters.continent === 'Africa') return pick(['KE', 'UG', 'TZ', 'NG', 'ZA']);
  if (filters.global) return pick(Object.keys(COUNTRY_CITY));
  return pick(Object.keys(COUNTRY_CITY));
}

/**
 * Produces { businesses, prospects } shaped like real provider output,
 * respecting the same filters the real discovery flow would pass in
 * (country/continent/global tier, industries, company size, titles).
 */
function generateMockEntities(filters, count = 8, sourceTag = 'mock') {
  const businesses = [];
  const prospects = [];

  for (let i = 0; i < count; i++) {
    const country = countryForTier(filters);
    const cityOptions = COUNTRY_CITY[country] || COUNTRY_CITY.US;
    const forcedCity = filters.city ? cityOptions.find(c => c[0].toLowerCase() === filters.city.toLowerCase()) : null;
    const [city, lat, lng] = forcedCity || pick(cityOptions);
    const companyName = fakeCompanyName();
    const industry = filters.industries && filters.industries.length ? pick(filters.industries) : pick(INDUSTRIES);
    const companySize = Math.floor(
      (filters.companySizeMin || 10) + Math.random() * ((filters.companySizeMax || 500) - (filters.companySizeMin || 10))
    );
    const domain = companyName.toLowerCase().replace(/\s+/g, '') + '.example.com';

    businesses.push({
      companyName, domain, industry, companySize,
      country, region: null, city,
      latitude: lat + (Math.random() - 0.5) * 0.2,
      longitude: lng + (Math.random() - 0.5) * 0.2,
      phone: fakePhone(country),
      source: sourceTag
    });

    const first = pick(FIRST_NAMES);
    const last = pick(LAST_NAMES);
    const title = filters.titles && filters.titles.length ? pick(filters.titles) : pick(TITLES);
    prospects.push({
      contactName: `${first} ${last}`,
      title,
      email: `${first.toLowerCase()}.${last.toLowerCase()}@${domain}`,
      phone: fakePhone(country),
      companyName,
      companyDomain: domain,
      country,
      source: sourceTag
    });
  }

  return { businesses, prospects };
}

function fakePhone(country) {
  const codes = { KE: '+254', UG: '+256', TZ: '+255', NG: '+234', ZA: '+27', US: '+1', GB: '+44', IN: '+91', DE: '+49' };
  const code = codes[country] || '+1';
  const number = Math.floor(100000000 + Math.random() * 900000000);
  return `${code}${number}`;
}

module.exports = { generateMockEntities };
