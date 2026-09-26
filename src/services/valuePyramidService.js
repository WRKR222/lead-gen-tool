/**
 * Value pyramid: the ladder of offers a business sells, from free value up
 * to lifetime value, priced in the business's own currency. It answers
 * "how much is one lead worth?", which drives lead estimated values,
 * pipeline value analytics and the price anchor in CPS meeting briefs.
 *
 *   value per customer = sum(tier price x share of customers who buy it)
 *   value per lead     = value per customer x lead-to-customer rate
 */
const llm = require('./llm');
const { approxPerUsd, currencyForCountry } = require('../config/currencies');

const TIER_KEYS = ['free_value', 'low_offer', 'core_offer', 'premium_offer', 'lifetime'];

// USD reference ladders for the offline path; scaled into local currency.
const TEMPLATES = {
  dental: {
    match: /dent|teeth|orthodont|smile/i,
    tiers: [
      ['Free value', 'Free smile check and oral-health tips', 0, 1],
      ['Teeth cleaning', 'Low-effort entry offer', 100, 0.8],
      ['Teeth whitening', 'Core cosmetic upgrade', 300, 0.3],
      ['Invisalign', 'High-ticket treatment', 5000, 0.05],
      ['Lifetime value', 'Twice-yearly cleanings for ~5 years plus family referrals', 1000, 0.6]
    ]
  },
  clinic: {
    match: /clinic|medical|hospital|physio|health|doctor|pharma/i,
    tiers: [
      ['Free value', 'Free health screening or consultation', 0, 1],
      ['Consultation', 'First paid visit', 30, 0.8],
      ['Treatment plan', 'Course of treatment', 250, 0.35],
      ['Specialist package', 'Premium / specialist procedure', 1500, 0.06],
      ['Lifetime value', 'Repeat visits and family referrals over ~5 years', 600, 0.5]
    ]
  },
  beauty: {
    match: /spa|salon|barber|beauty|aesthetic|nail|hair/i,
    tiers: [
      ['Free value', 'Free skin/hair consultation', 0, 1],
      ['Entry service', 'First treatment at an intro price', 25, 0.8],
      ['Signature package', 'Most popular bundle', 120, 0.35],
      ['Premium programme', 'Multi-session premium programme', 800, 0.08],
      ['Lifetime value', 'Monthly visits for ~3 years', 900, 0.4]
    ]
  },
  fitness: {
    match: /gym|fitness|yoga|pilates|studio|training/i,
    tiers: [
      ['Free value', 'Free trial class', 0, 1],
      ['Intro pass', 'Two-week intro pass', 20, 0.7],
      ['Monthly membership', 'Core membership', 60, 0.5],
      ['Personal training', 'Personal training package', 600, 0.1],
      ['Lifetime value', 'Membership renewals for ~2 years', 1200, 0.4]
    ]
  },
  real_estate: {
    match: /real estate|property|realtor|homes|apartment|housing/i,
    tiers: [
      ['Free value', 'Free valuation / market report', 0, 1],
      ['Viewing & advisory', 'Guided viewings and shortlist', 50, 0.6],
      ['Rental placement', 'Rental deal fee', 800, 0.3],
      ['Sale commission', 'Property sale commission', 6000, 0.08],
      ['Lifetime value', 'Repeat transactions and referrals', 3000, 0.3]
    ]
  },
  hospitality: {
    match: /hotel|bnb|lodge|resort|restaurant|cafe|hospitality|tourism|travel/i,
    tiers: [
      ['Free value', 'Free upgrade, welcome drink or tasting', 0, 1],
      ['First booking', 'Single night / first meal', 60, 0.8],
      ['Package', 'Weekend or group package', 350, 0.25],
      ['Corporate / events', 'Corporate contract or event', 4000, 0.04],
      ['Lifetime value', 'Repeat stays and referrals', 900, 0.4]
    ]
  },
  professional: {
    match: /law|legal|account|consult|audit|tax|insurance|finance/i,
    tiers: [
      ['Free value', 'Free first consultation', 0, 1],
      ['Starter engagement', 'Fixed-fee starter service', 150, 0.6],
      ['Core engagement', 'Main service engagement', 1200, 0.35],
      ['Retainer', 'Ongoing premium retainer', 6000, 0.08],
      ['Lifetime value', 'Repeat work and referrals', 4000, 0.4]
    ]
  },
  home_services: {
    match: /plumb|solar|roof|clean|repair|electric|construction|interior|pest/i,
    tiers: [
      ['Free value', 'Free inspection and quote', 0, 1],
      ['Small job', 'Entry repair / service call', 60, 0.7],
      ['Standard project', 'Typical project', 700, 0.3],
      ['Major project', 'Large installation / renovation', 6000, 0.05],
      ['Lifetime value', 'Maintenance and referrals over ~5 years', 1500, 0.4]
    ]
  },
  education: {
    match: /school|academy|tutor|college|training|course|education/i,
    tiers: [
      ['Free value', 'Free open day / trial lesson', 0, 1],
      ['Short course', 'Entry course or term trial', 80, 0.6],
      ['Full term', 'Full term / programme', 600, 0.45],
      ['Annual enrolment', 'Full-year enrolment', 2500, 0.2],
      ['Lifetime value', 'Multi-year enrolment and siblings', 6000, 0.3]
    ]
  },
  agency: {
    match: /lead gen|marketing agency|advertis|appointment setting|automation agency/i,
    tiers: [
      ['Free value', 'Free growth audit + 10 sample leads', 0, 1],
      ['Appointment setting pilot', 'One-month appointment setting pilot', 400, 0.7],
      ['Paid ads management', 'Monthly ad management on one platform', 900, 0.45],
      ['AI automation build', 'Bespoke AI systems build', 4000, 0.15],
      ['Lifetime value', 'Retainer renewals over ~18 months', 9000, 0.5]
    ]
  },
  generic: {
    match: /.*/,
    tiers: [
      ['Free value', 'Free consultation, sample or audit', 0, 1],
      ['Entry offer', 'Low-effort first purchase', 50, 0.7],
      ['Core offer', 'Main product or service', 400, 0.35],
      ['Premium offer', 'High-ticket version', 3000, 0.06],
      ['Lifetime value', 'Repeat purchases and referrals', 1200, 0.4]
    ]
  }
};

function roundNice(n) {
  if (n <= 0) return 0;
  const step = n < 100 ? 5 : n < 1000 ? 50 : n < 10000 ? 500 : n < 100000 ? 1000 : n < 1000000 ? 5000 : 50000;
  return Math.max(step, Math.round(n / step) * step);
}

/** Recompute derived numbers after generation or a manual edit. */
function compute(pyramid) {
  const tiers = (pyramid.tiers || []).map((t, i) => ({
    level: i + 1,
    key: t.key || TIER_KEYS[i] || `tier_${i + 1}`,
    name: String(t.name || `Tier ${i + 1}`).slice(0, 80),
    description: String(t.description || '').slice(0, 240),
    price: Math.max(0, Number(t.price) || 0),
    takeRate: Math.min(1, Math.max(0, Number(t.takeRate) || 0))
  }));
  const leadToCustomerRate = Math.min(1, Math.max(0, Number(pyramid.leadToCustomerRate ?? 0.1)));
  const valuePerCustomer = Math.round(tiers.reduce((s, t) => s + t.price * t.takeRate, 0));
  const lifetime = tiers.find(t => t.key === 'lifetime');
  return {
    currency: pyramid.currency || 'USD',
    tiers,
    leadToCustomerRate,
    valuePerCustomer,
    valuePerLead: Math.round(valuePerCustomer * leadToCustomerRate),
    lifetimeValue: lifetime ? Math.round(lifetime.price) : null,
    notes: pyramid.notes || '',
    _generatedBy: pyramid._generatedBy || 'manual',
    updatedAt: new Date().toISOString()
  };
}

function templateFor(company) {
  const text = `${company.industry || ''} ${company.description || ''} ${company.kind === 'agency' ? 'lead gen marketing agency' : ''}`;
  if (company.kind === 'agency') return TEMPLATES.agency;
  return Object.values(TEMPLATES).find(t => t.match.test(text)) || TEMPLATES.generic;
}

function fallbackPyramid(company) {
  const currency = company.currency || currencyForCountry(company.homeCountry);
  const fx = approxPerUsd(currency);
  const t = templateFor(company);
  return compute({
    currency,
    tiers: t.tiers.map(([name, description, usd, takeRate], i) => ({ key: TIER_KEYS[i], name, description, price: roundNice(usd * fx), takeRate })),
    leadToCustomerRate: 0.1,
    notes: `Starting template priced in ${currency} from typical market rates - replace with this business's real prices.`,
    _generatedBy: 'local_template'
  });
}

/**
 * @param {object} company - { name, kind, industry, description, homeCountry, homeCity, currency, businessProfileText }
 */
async function generate(company) {
  if (!llm.enabled()) return fallbackPyramid(company);
  const currency = company.currency || currencyForCountry(company.homeCountry);
  try {
    const system = 'You design value pyramids (offer ladders) for businesses. Return ONLY valid JSON, no markdown.';
    const user = `Build the value pyramid for this business, priced realistically for its local market in ${currency}.
BUSINESS: ${JSON.stringify({ name: company.name, role: company.kind === 'agency' ? 'an AI lead-generation agency (sells paid advertising, appointment setting, AI automation)' : 'a business', industry: company.industry, city: company.homeCity, country: company.homeCountry, description: company.description })}
${company.businessProfileText ? `BUSINESS PROFILE (use its real services and prices where given):\n${company.businessProfileText.slice(0, 30000)}\n` : ''}
Exactly five tiers, in order:
1. free_value - the free offer that turns interest into a lead (price 0)
2. low_offer - low-effort entry purchase
3. core_offer - the main product/service
4. premium_offer - the high-ticket offer
5. lifetime - the extra repeat/referral value of a customer over their lifetime (price = that total)
Example for a dental clinic in USD: free value, teeth cleaning $100, whitening $300, Invisalign $5000, then lifetime value.
takeRate = share (0-1) of converted customers who buy that tier. leadToCustomerRate = realistic share of leads that become customers.
SHAPE: {"currency":"${currency}","tiers":[{"key":"free_value","name":"","description":"","price":0,"takeRate":1}],"leadToCustomerRate":0.1,"notes":"one sentence on the assumptions"}`;
    const out = await llm.completeJson({ system, user, effort: 'medium', maxTokens: 8000 });
    if (!Array.isArray(out.tiers) || out.tiers.length < 3) throw new Error('model returned too few tiers');
    return compute({ ...out, currency, _generatedBy: 'anthropic:' + llm.MODEL });
  } catch (err) {
    console.warn(`[valuePyramidService] AI generation failed (${err.message}), using template.`);
    return fallbackPyramid(company);
  }
}

module.exports = { generate, compute, fallbackPyramid, roundNice };
