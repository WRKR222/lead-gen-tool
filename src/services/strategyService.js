/**
 * Stage 3 "get results": the growth plan built for each client on the
 * 4-step AI lead-generation funnel - create interest (one ad platform),
 * generate leads (the free-value tier as the offer), book appointments,
 * and industry-bespoke AI systems.
 */
const llm = require('./llm');
const { FUNNEL_STEPS, AD_PLATFORMS, SERVICES } = require('../config/playbook');

const PLATFORM_DEFAULTS = {
  meta: { objective: 'Lead-form ads (instant forms) driving the free offer', formats: ['Short vertical video (Reels/Stories)', 'Before/after carousel', 'Owner-to-camera offer video'] },
  google_ads: { objective: 'Search ads on high-intent local keywords + a landing page for the free offer', formats: ['Responsive search ads', 'Call ads', 'Local service / Maps listing'] },
  youtube: { objective: 'In-stream video ads telling the story behind the free offer', formats: ['15-30s skippable in-stream', 'YouTube Shorts', 'Testimonial video'] },
  tiktok: { objective: 'Native-looking short videos with a lead-generation form', formats: ['Creator-style 15s video', 'Trend-based hook video', 'Behind-the-scenes clip'] }
};

const AI_SYSTEM_IDEAS = [
  [/dent|clinic|medical|physio|health|spa|salon|beauty/i, [
    ['AI booking assistant', 'Answers WhatsApp/website enquiries 24/7 and books appointments straight into the calendar', 'Fewer missed enquiries, more bookings'],
    ['Recall & reminder automation', 'Automatic reminders for check-ups and no-show follow-up', 'Higher repeat visits (lifetime value)'],
    ['Review & referral engine', 'Asks happy patients/clients for reviews and referrals after each visit', 'More trust and free leads']]],
  [/real estate|property|homes/i, [
    ['AI listing matcher', 'Matches new enquiries to listings and sends them instantly', 'Faster response, more viewings'],
    ['Viewing scheduler', 'Self-serve viewing booking with reminders', 'Less admin, fewer no-shows'],
    ['Lead nurture drips', 'Long-term nurture for buyers not ready yet', 'Deals from "later" leads']]],
  [/restaurant|cafe|hotel|bnb|hospitality|travel/i, [
    ['AI reservations assistant', 'Handles bookings and FAQs on WhatsApp and Instagram', 'More bookings, less phone time'],
    ['Guest win-back campaigns', 'Automated offers to past guests', 'More repeat stays/visits'],
    ['Review responder', 'Drafts replies to every review', 'Better ratings']]],
  [/.*/, [
    ['AI enquiry assistant', 'Qualifies and answers inbound enquiries on chat, email and WhatsApp', 'Faster response, more meetings'],
    ['Follow-up automation', 'Persistent, polite follow-ups until leads respond', 'Fewer lost leads'],
    ['Reporting dashboard', 'Weekly performance summary for the owner', 'Clear view of growth']]]
];

function fallbackPlan(company, pyramid) {
  const platform = company.adPlatform || 'meta';
  const pd = PLATFORM_DEFAULTS[platform] || PLATFORM_DEFAULTS.meta;
  const free = (pyramid?.tiers || []).find(t => t.key === 'free_value');
  const text = `${company.industry || ''} ${company.description || ''}`;
  const ideas = AI_SYSTEM_IDEAS.find(([re]) => re.test(text))[1];
  const services = company.services?.length ? company.services : SERVICES.map(s => s.key);
  return {
    platform,
    platformLabel: AD_PLATFORMS.find(p => p.key === platform)?.label,
    leadMagnet: free ? `${free.name}: ${free.description}` : 'A free consultation or audit',
    funnel: FUNNEL_STEPS.map(step => ({
      key: step.key, label: step.label,
      actions: {
        create_interest: [`Run ${AD_PLATFORMS.find(p => p.key === platform)?.label || platform} ads: ${pd.objective}`, 'Google sweeps / scraping for businesses or people in the target area', 'Organic social posts on the same offer'],
        generate_leads: [`Lead with the free offer: ${free ? free.name : 'free consultation'}`, 'Capture every enquiry into this tool (inbound lead webhook)', 'Score and prioritise the leads'],
        book_appointments: ['Contact every lead with door-to-door, calls, digital DMs and email in that order of strength', 'Cadenced follow-ups for non-responders (no spam)', 'Book into HighLevel / Appointwise calendars'],
        implement_ai: ideas.map(([name]) => name)
      }[step.key]
    })),
    adPlan: { objective: pd.objective, formats: pd.formats, audience: `People/businesses in ${company.homeCity || 'the home city'} matching the ideal customer profile`, budgetNote: 'Start small for 2 weeks, keep the best creative, then scale.' },
    aiSystems: ideas.map(([name, what, impact]) => ({ name, what, impact })),
    servicesEngaged: services,
    _generatedBy: 'local_template'
  };
}

async function generateGrowthPlan(company, pyramid) {
  if (!llm.enabled()) return fallbackPlan(company, pyramid);
  try {
    const system = 'You are the strategist at an AI lead-generation agency. Return ONLY valid JSON, no markdown.';
    const user = `Build the growth plan for this client on the agency's 4-step funnel.
CLIENT: ${JSON.stringify({ name: company.name, industry: company.industry, city: company.homeCity, country: company.homeCountry, targetMarket: company.targetMarket, description: company.description, services: company.services, adPlatform: company.adPlatform })}
VALUE PYRAMID (${pyramid?.currency}): ${JSON.stringify(pyramid?.tiers || [])}
${company.businessProfileText ? `BUSINESS PROFILE:\n${company.businessProfileText.slice(0, 20000)}\n` : ''}
FUNNEL STEPS: ${JSON.stringify(FUNNEL_STEPS.map(s => ({ key: s.key, label: s.label, summary: s.summary })))}
Rules: use ONLY the one ad platform "${company.adPlatform || 'meta'}". The lead magnet is the free-value tier. aiSystems must be bespoke to this industry (3-4 items). Budgets in ${pyramid?.currency || 'local currency'}.
SHAPE: {"platform":"","leadMagnet":"","funnel":[{"key":"create_interest","label":"","actions":["",""]}],"adPlan":{"objective":"","formats":[""],"audience":"","budgetNote":""},"aiSystems":[{"name":"","what":"","impact":""}]}`;
    const plan = await llm.completeJson({ system, user, effort: 'medium', maxTokens: 10000 });
    const safe = llm.withFallback(plan, fallbackPlan(company, pyramid));
    return { ...safe, platform: company.adPlatform || safe.platform || 'meta', servicesEngaged: company.services || [], _generatedBy: 'anthropic:' + llm.MODEL };
  } catch (err) {
    console.warn(`[strategyService] AI plan failed (${err.message}), using template.`);
    return fallbackPlan(company, pyramid);
  }
}

module.exports = { generateGrowthPlan, fallbackPlan };
