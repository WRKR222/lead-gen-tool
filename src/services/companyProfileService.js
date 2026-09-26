/**
 * AI company-profiling: the engine that makes this tool "unique for each
 * registering company" instead of a one-size-fits-all form.
 *
 * At registration, a company gives us a name + a free-text description of
 * what it does and what it wants from the tool. This service turns that
 * description into a full "directions" profile - ideal customer profile,
 * geo strategy, scoring weights, outreach tone/sequence, brand voice and
 * sales narrative - that every other module (lead scoring, email
 * generation, call scripts, content studio, AI assistant) reads from
 * `companies.ai_profile_json`. It replaces the single global
 * `config/directions.default.json` used in v1, which is now only a
 * fallback seed shape.
 *
 * Same pattern as emailGenerationService.js: calls the configured LLM
 * (ANTHROPIC_API_KEY) for a real, bespoke profile; falls back to a
 * deterministic heuristic builder (keyword-matching against the
 * description) when no key is set or MOCK_MODE=true, so onboarding always
 * works, for free, in demo mode.
 */
const fs = require('fs');
const path = require('path');
const llm = require('./llm');

const SEED_PATH = path.join(__dirname, '..', 'config', 'directions.default.json');
const SEED = JSON.parse(fs.readFileSync(SEED_PATH, 'utf8'));

const SYSTEM_PROMPT = `You are a go-to-market strategist at an AI lead-generation agency, configuring the agency's platform for one business. \
The business is either the AGENCY itself (its leads are businesses that could hire the agency) or one of the agency's CLIENTS (its leads are that client's prospective customers - companies for a B2B client, individual people for a B2C client such as a dental practice). \
Given the business's name, industry, website, home market, its own description and (if provided) its uploaded business profile document, produce a complete JSON "directions" profile that will drive: which leads to search for, how to score them, what tone/sequence to use in outreach, and what brand voice/sales narrative to use when generating pitches, ads, and social content for THIS business specifically.

Rules:
- Write ONLY valid JSON matching the exact shape given in the user message's "SHAPE" block. No markdown, no preamble, no comments.
- Every string field must be specific to this company - never generic filler like "we help businesses grow".
- idealCustomerProfile.industries/targetTitles/keywords must be plausible for who would actually BUY from this company.
- geoStrategy.homeCountry must be the ISO-3166 alpha-2 code for their stated home market (default "KE" for Kenya if unclear).
- brand.voice should be 1-2 adjectives + a short description (e.g. "confident, data-driven - speaks in outcomes, not features").
- salesNarrative.painPointsSolved: 3-5 concrete pains this company's customers have.
- salesNarrative.objectionHandling: 3-4 common objections mapped to a short, honest rebuttal.
- Keep every string concise (under ~40 words) - this feeds automated systems, not a human reading a brochure.`;

function shapeTemplate() {
  return {
    companyProfileVersion: 2,
    sender: {
      senderName: 'string - a plausible outbound sender name/title if none given, else leave as "Sales Team"',
      senderTitle: 'string',
      companyName: 'string - the company name as given',
      companyOneLiner: 'string - what they do, one sentence',
      valueProposition: 'string - the core value prop for their buyers',
      proofPoint: 'string - a plausible proof point/credibility signal (mark speculative ones clearly, e.g. "(placeholder - replace with a real case study)")',
      callToAction: 'string - desired CTA for outreach',
      website: 'string'
    },
    idealCustomerProfile: {
      industries: ['string', '...'],
      excludeIndustries: [],
      companySizeMin: 1,
      companySizeMax: 500,
      revenueMinUSD: null,
      revenueMaxUSD: null,
      targetTitles: ['string', '...'],
      titleSeniorityWeight: { c_level: 1.0, vp: 0.8, director: 0.6, manager: 0.4, other: 0.2 },
      keywords: ['string', '...'],
      excludeKeywords: []
    },
    geoStrategy: {
      homeCountry: 'KE',
      homeCity: 'Nairobi',
      expansionOrder: ['home_country', 'region', 'global'],
      regionDefinition: 'continent',
      radiusKmStart: 150,
      radiusKmStep: 300,
      radiusKmMax: 3000,
      advanceToNextTierWhen: { minLeadsFoundBelowThreshold: 25, orQualityScoreBelow: 0.35 },
      defaultScope: 'kenya'
    },
    scoring: {
      conversionEvents: ['replied', 'meeting_booked', 'opportunity_created', 'closed_won'],
      negativeEvents: ['bounced', 'unsubscribed', 'marked_spam', 'closed_lost'],
      learningRate: 0.05,
      minSamplesBeforeReweighting: 20
    },
    outreach: {
      tonePreset: 'string - e.g. professional_direct | warm_consultative | bold_challenger',
      sendingWindowLocalHours: { start: 8, end: 17 },
      daysOfWeek: ['mon', 'tue', 'wed', 'thu', 'fri'],
      followUpSequence: [
        { dayOffset: 0, templateId: 'intro' },
        { dayOffset: 3, templateId: 'followup_1' },
        { dayOffset: 8, templateId: 'followup_2_breakup' }
      ]
    },
    brand: {
      voice: 'string',
      themes: ['string', '...up to 5 content themes for social/ad generation'],
      differentiators: ['string', '...up to 4']
    },
    salesNarrative: {
      elevatorPitch: 'string - 2-3 sentences',
      painPointsSolved: ['string', '...'],
      objectionHandling: { objection_text: 'rebuttal_text' }
    }
  };
}

/** Very small keyword heuristics used only when there's no LLM available. */
const INDUSTRY_KEYWORDS = {
  software: ['software', 'saas', 'app', 'platform', 'tech'],
  fintech: ['fintech', 'payments', 'lending', 'bank', 'finance'],
  dental: ['dental', 'dentist', 'orthodont', 'teeth'],
  healthtech: ['health', 'clinic', 'hospital', 'medical', 'pharma'],
  agritech: ['farm', 'agri', 'poultry', 'crop', 'livestock'],
  ecommerce: ['ecommerce', 'e-commerce', 'retail', 'shop', 'store'],
  logistics: ['logistics', 'delivery', 'shipping', 'freight', 'supply chain'],
  hospitality: ['hotel', 'bnb', 'rental', 'hospitality', 'travel', 'tourism'],
  professional_services: ['consulting', 'agency', 'law', 'accounting', 'services']
};

function guessIndustries(text) {
  const t = text.toLowerCase();
  const hits = Object.entries(INDUSTRY_KEYWORDS).filter(([, kws]) => kws.some(k => t.includes(k))).map(([k]) => k);
  return hits.length ? hits : ['professional_services'];
}

function localFallbackProfile({ name, description = '', industry, website, homeCountry, homeCity, kind, targetMarket, businessProfileText }) {
  const blob = `${description} ${industry || ''} ${(businessProfileText || '').slice(0, 4000)}`;
  const industries = kind === 'agency'
    ? ['dentists', 'medical clinics', 'real estate', 'hospitality', 'professional_services']
    : industry ? [industry.toLowerCase()] : guessIndustries(blob);
  const shape = shapeTemplate();
  const targetTitles = kind === 'agency' || targetMarket !== 'b2c'
    ? ['owner', 'founder', 'managing director', 'practice manager', 'marketing manager']
    : ['individual'];
  return {
    ...shape,
    sender: {
      senderName: 'Sales Team',
      senderTitle: 'Business Development',
      companyName: name,
      companyOneLiner: description ? description.split(/[.!\n]/)[0].trim().slice(0, 140) : `${name} helps businesses in ${industries[0]}.`,
      valueProposition: description ? description.slice(0, 220) : `${name} solves operational problems for ${industries[0]} companies.`,
      proofPoint: '(placeholder - add a real customer result once you have one)',
      callToAction: 'Ask for a 15-minute call this week.',
      website: website || ''
    },
    idealCustomerProfile: {
      ...shape.idealCustomerProfile,
      industries,
      targetTitles
    },
    geoStrategy: {
      ...shape.geoStrategy,
      homeCountry: homeCountry || 'KE',
      homeCity: homeCity || 'Nairobi',
      defaultScope: 'kenya'
    },
    outreach: { ...shape.outreach, tonePreset: 'professional_direct' },
    brand: {
      voice: 'clear, practical - speaks in outcomes',
      themes: industries.slice(0, 3).concat(['customer success', 'behind the scenes']).slice(0, 5),
      differentiators: ['Local Kenyan market expertise', 'Fast, responsive support']
    },
    salesNarrative: {
      elevatorPitch: description ? description.slice(0, 260) : `${name} helps ${industries[0]} companies get more done with less effort.`,
      painPointsSolved: ['Manual, time-consuming processes', 'Difficulty finding qualified customers', 'Inconsistent follow-up'],
      objectionHandling: {
        'We already have a solution for this': 'Totally fair - most teams do. The question is whether it is still saving time as you scale. Worth a 15-minute comparison?',
        'We do not have budget right now': 'Understood - would it be useful to stay in touch and revisit this next quarter?',
        'Send me some information': 'Happy to. I will follow up with something short and specific to your situation rather than a generic deck.'
      }
    },
    _generatedBy: 'local_heuristic_fallback'
  };
}

/**
 * @param {object} company - { name, description, industry, website, homeCountry, homeCity,
 *   kind: 'agency'|'client', targetMarket: 'b2b'|'b2c', businessProfileText? }
 * @returns {Promise<object>} full directions/profile JSON, ready to store in companies.ai_profile_json
 */
async function generateCompanyProfile(company) {
  if (!llm.enabled()) return localFallbackProfile(company);

  const role = company.kind === 'client'
    ? `a CLIENT of the agency. Its leads are its prospective ${company.targetMarket === 'b2c' ? 'customers as individual PEOPLE (B2C) - targetTitles should describe the people (e.g. "parents in Westlands"), industries their context' : 'customers as COMPANIES (B2B)'}.`
    : 'the AGENCY itself. Its leads are businesses that could hire it for paid advertising, appointment setting and AI automation - favour high-demand, repeat-purchase local markets (e.g. dentists, clinics, salons).';
  const user = `BUSINESS (${role})
Name: ${company.name}
Industry (as given, may be blank): ${company.industry || '(not specified - infer from description)'}
Website: ${company.website || '(none given)'}
Home market: ${company.homeCity || ''}, ${company.homeCountry || 'Kenya'}

DESCRIPTION (what they do and what they want, in their own words):
${company.description || '(no description given - make reasonable, clearly-generic-labeled assumptions)'}
${company.businessProfileText ? `\nUPLOADED BUSINESS PROFILE DOCUMENT (extracted text):\n${company.businessProfileText.slice(0, 60000)}\n` : ''}
SHAPE (fill every field with content specific to this business, keep the exact keys/structure):
${JSON.stringify(shapeTemplate(), null, 2)}

Return the filled JSON now.`;

  try {
    const profile = await llm.completeJson({ system: SYSTEM_PROMPT, user, effort: 'medium' });
    return { ...llm.withFallback(profile, localFallbackProfile(company)), _generatedBy: 'anthropic:' + llm.MODEL };
  } catch (err) {
    console.warn(`[companyProfileService] AI profiling failed (${err.message}), falling back to heuristic profile.`);
    return localFallbackProfile(company);
  }
}

module.exports = { generateCompanyProfile, shapeTemplate, SEED };
