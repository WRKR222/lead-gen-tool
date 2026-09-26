/**
 * The agency playbook: the one source of truth for how Chunguza finds,
 * signs and delivers for clients. The UI renders it, reps are checked
 * against it when they log an attempt, and every AI prompt (door-to-door
 * briefs, call scripts, DMs, emails, meeting briefs, auto-replies) embeds
 * it, so people and automation follow the same standards.
 */

const AGENCY_STAGES = [
  {
    key: 'find_clients', step: 1, label: 'Find clients',
    summary: 'Who, what, where. Prospect businesses in high-demand, repeat-purchase markets (dentists, clinics, local businesses). Go scattergun across industries at first, then specialise once one converts best.',
    tactics: ['Google sweeps and map listings for a niche + city', 'Scraping tools and bought lists (import CSV/Excel)', 'Local businesses that customers come back to', 'Try several industries, double down on the best converter']
  },
  {
    key: 'sign_clients', step: 2, label: 'Sign clients',
    summary: 'Book the meeting, run the CPS meeting, get a yes.',
    tactics: ['Book meetings with decision makers only', 'Run Conversational Problem Solving in the meeting', 'Let them ask the price, then stay silent', 'Capture contact details even on a no']
  },
  {
    key: 'get_results', step: 3, label: 'Get results',
    summary: "Build the client's strategy: value pyramid, one ad platform, lead generation, appointment setting and AI automation, then keep monitoring so the client is never lost.",
    tactics: ['Build the value pyramid in the client\'s currency', 'Launch on one ad platform', 'Generate and contact leads with every method', 'Watch client health and churn every week']
  }
];

// Ranked by effectiveness, best first (the order reps should try them in).
const OUTREACH_METHODS = [
  {
    key: 'door_to_door', rank: 1, label: 'Door to door', badge: 'Best',
    channels: ['in_person'], automatable: false,
    description: 'Walk in, ask for the owner or decision maker by name, hook them in one sentence, book the meeting on the spot.'
  },
  {
    key: 'cold_call', rank: 2, label: 'Cold calling',
    channels: ['phone'], automatable: false,
    description: 'Call the decision maker directly. Get past the gatekeeper, hook, create scarcity, ask for the meeting.'
  },
  {
    key: 'digital', rank: 3, label: 'Multi-platform digital',
    channels: ['whatsapp', 'instagram', 'facebook', 'linkedin', 'tiktok', 'x'], automatable: false,
    description: 'Short, personal DMs on the platforms they actually use. Drafted by AI, sent by a person (platform rules forbid bulk automated DMs).'
  },
  {
    key: 'email_dm', rank: 4, label: 'Email & DMs (auto)',
    channels: ['email', 'sms'], automatable: true,
    description: 'Automated, personalised email sequences and follow-ups, with unsubscribe and anti-spam guardrails.'
  }
];

const CHANNEL_LABELS = {
  in_person: 'In person', phone: 'Phone call', whatsapp: 'WhatsApp', sms: 'SMS', email: 'Email',
  linkedin: 'LinkedIn', instagram: 'Instagram', facebook: 'Facebook', tiktok: 'TikTok', x: 'X (Twitter)',
  youtube: 'YouTube', website: 'Website', address: 'Address', other: 'Other'
};

// Contact channels a lead can have; digital ones map to the "digital" method.
const CONTACT_CHANNELS = ['phone', 'whatsapp', 'sms', 'email', 'linkedin', 'instagram', 'facebook', 'tiktok', 'x', 'youtube', 'website', 'address', 'other'];

// What happened on an attempt, and what it does to the lead.
//   leadStatus: new pipeline status (null = unchanged)
//   followUp:   schedule the next touch in the cadence
const ATTEMPT_RESULTS = [
  { key: 'sent', label: 'Message sent / left', leadStatus: 'contacted', followUp: true },
  { key: 'no_answer', label: 'No answer / not in', leadStatus: 'contacted', followUp: true },
  { key: 'gatekeeper', label: 'Spoke to gatekeeper, not the decision maker', leadStatus: 'contacted', followUp: true },
  { key: 'callback_requested', label: 'Asked us to come back / call back', leadStatus: 'contacted', followUp: true },
  { key: 'replied', label: 'Replied', leadStatus: 'replied', followUp: true },
  { key: 'interested', label: 'Interested', leadStatus: 'replied', followUp: true },
  { key: 'meeting_booked', label: 'Meeting booked', leadStatus: 'meeting_booked', followUp: false },
  { key: 'on_fence', label: 'On the fence', leadStatus: 'on_fence', followUp: true },
  { key: 'said_no', label: 'Said no', leadStatus: 'closed_lost', followUp: false },
  { key: 'converted', label: 'Converted (said yes)', leadStatus: 'closed_won', followUp: false },
  { key: 'wrong_contact', label: 'Wrong or dead contact', leadStatus: null, followUp: false }
];

// The four outcomes every contacted lead ends up in.
const LEAD_OUTCOMES = [
  { key: 'converted', label: 'Converted', status: 'closed_won' },
  { key: 'on_fence', label: 'On the fence', status: 'on_fence' },
  { key: 'said_no', label: 'Said no', status: 'closed_lost' },
  { key: 'no_response', label: 'Not responded', status: 'no_response' }
];

const LEAD_STATUSES = [
  { key: 'new', label: 'New', group: 'pipeline' },
  { key: 'contacted', label: 'Contacted', group: 'pipeline' },
  { key: 'replied', label: 'Replied', group: 'pipeline' },
  { key: 'meeting_booked', label: 'Meeting booked', group: 'pipeline' },
  { key: 'opportunity', label: 'Opportunity', group: 'pipeline' },
  { key: 'on_fence', label: 'On the fence', group: 'outcome' },
  { key: 'no_response', label: 'Not responded', group: 'outcome' },
  { key: 'closed_won', label: 'Converted', group: 'outcome' },
  { key: 'closed_lost', label: 'Said no', group: 'outcome' },
  { key: 'bounced', label: 'Bounced', group: 'compliance' },
  { key: 'unsubscribed', label: 'Unsubscribed', group: 'compliance' },
  { key: 'spam', label: 'Marked spam', group: 'compliance' }
];

// Standards for setting the meeting - for employees and AI alike.
const MEETING_STANDARDS = [
  { key: 'decision_maker', label: 'Always speak to the decision maker', guidance: 'Ask for the owner/manager by name. If a gatekeeper answers, get the decision maker\'s name and best time, do not pitch the gatekeeper.' },
  { key: 'straight_to_point', label: 'Get straight to the point', guidance: 'No niceties, no "how are you". Open with a hook specific to their business in the first sentence.' },
  { key: 'scarcity', label: 'Create scarcity', guidance: 'Make it exclusive to this owner (e.g. one business per niche per area) and make them feel cared about, not sold to.' },
  { key: 'no_pitch', label: 'Never pitch before the meeting', guidance: 'Questions get the same answer: "Great question - that is exactly what we cover in the meeting." The only goal is the meeting.' },
  { key: 'accept_no', label: 'It is fine to hear no before yes', guidance: 'A no is information, not the end. Stay calm, keep the door open, log the reason.' }
];

// Conversational Problem Solving - the in-person / call meeting strategy.
const CPS_STAGES = [
  {
    key: 'attention', step: 1, label: 'Attention',
    goal: 'Set the tone. Say something that shows you paid attention to THEM (personal, specific, a little surprising).',
    moves: ['Open with a specific observation about their business', 'Say you want to learn about their business; if there is potential to grow together you may make an offer', 'Ask why they accepted this meeting']
  },
  {
    key: 'identify', step: 2, label: 'Identify',
    goal: 'Listen to their problems, what those problems cost the business, and acknowledge them.',
    moves: ['Do you have revenue goals? How close are you today?', 'Why that goal - growth, stability, something else?', 'What is stopping you from solving this yourself?', 'What does this problem cost you each month?']
  },
  {
    key: 'solve', step: 3, label: 'Solve',
    goal: 'An elevator pitch that creates intrigue without giving everything away. No deck, no tool names.',
    moves: ['Tie the pitch to the exact problems they named', 'Answer questions honestly but do not list every service', 'Leave them wanting the details']
  },
  {
    key: 'cost', step: 4, label: 'Cost',
    goal: 'Get them to ask how much it costs. State the price, then stop talking.',
    moves: ['Let them ask the price first', 'State it once, then silence', 'If they reject: affirm them, no pressure', 'Always leave with their contact details']
  }
];

// The AI lead-generation funnel every client strategy is built on.
const FUNNEL_STEPS = [
  { key: 'create_interest', step: 1, label: 'Create interest', summary: 'Paid ads on one platform, scraping tools, Google sweeps, social media and LinkedIn, all around the service the client sells.' },
  { key: 'generate_leads', step: 2, label: 'Generate leads', summary: 'Turn interest into leads with a targeted offer (the free-value tier of the value pyramid), or pull leads directly with this tool.' },
  { key: 'book_appointments', step: 3, label: 'Book appointments', summary: 'Automate booking: cadenced follow-ups, AI replies, calls and appointment tools (HighLevel, Appointwise).' },
  { key: 'implement_ai', step: 4, label: 'Implement AI systems', summary: 'Further AI systems that raise sales and streamline the day to day, bespoke to each industry.' }
];

const SERVICES = [
  { key: 'paid_advertising', label: 'Paid advertising' },
  { key: 'appointment_setting', label: 'Appointment setting' },
  { key: 'ai_automation', label: 'AI automation' }
];

// One ad platform per client, to avoid overwhelming them.
const AD_PLATFORMS = [
  { key: 'meta', label: 'Meta (Facebook & Instagram)' },
  { key: 'google_ads', label: 'Google Ads' },
  { key: 'youtube', label: 'YouTube' },
  { key: 'tiktok', label: 'TikTok' }
];

const AI_TOOLS = [
  { key: 'highlevel', label: 'HighLevel', purpose: 'CRM, pipelines and calendar booking' },
  { key: 'appointwise', label: 'Appointwise', purpose: 'AI appointment setting' }
];

// Why a lead said no, a customer left, or a client churned.
const LOSS_REASONS = [
  { key: 'price', label: 'Price / budget' },
  { key: 'timing', label: 'Bad timing' },
  { key: 'no_need', label: 'No need right now' },
  { key: 'competitor', label: 'Went with a competitor' },
  { key: 'trust', label: 'Did not trust us yet' },
  { key: 'results', label: 'Results not good enough' },
  { key: 'service_quality', label: 'Service quality' },
  { key: 'communication', label: 'Poor communication / slow follow-up' },
  { key: 'moved_or_closed', label: 'Moved or closed' },
  { key: 'other', label: 'Other' }
];

// Stage 1 prospecting ideas: high-demand, repeat-purchase local markets.
const HIGH_DEMAND_NICHES = [
  'dentists', 'dental clinics', 'medical clinics', 'physiotherapy', 'med spas & aesthetics', 'gyms & fitness studios',
  'salons & barbers', 'real estate agencies', 'law firms', 'auto repair & car dealers', 'restaurants & cafes',
  'private schools', 'home services (plumbing, solar, roofing)', 'hotels & BnBs', 'veterinary clinics'
];

// Follow-up cadence for leads that have not responded: persistent, never
// spammy. Spacing grows, channels rotate, and hard caps protect the lead.
const DEFAULT_CADENCE = {
  intervalsDays: [2, 4, 7, 14, 21],
  maxAttempts: 6,
  minHoursBetweenTouches: 48,
  maxTouchesPer30Days: 4,
  nurtureIntervalDays: 60,
  rotateMethods: true
};

const DEFAULT_SETTINGS = {
  autoReplyMode: 'draft',        // off | draft | send
  autoFollowUpEmails: false,     // let the cadence engine send email follow-ups by itself
  bookingLink: '',
  monthlyLeadTarget: 50,
  monthlyMeetingTarget: 10,
  highlevel: { enabled: false, locationId: '' },
  appointwise: { enabled: false, webhookUrl: '' },
  cadence: DEFAULT_CADENCE
};

function methodByKey(key) { return OUTREACH_METHODS.find(m => m.key === key); }
function resultByKey(key) { return ATTEMPT_RESULTS.find(r => r.key === key); }

function methodForChannel(channel) {
  if (channel === 'in_person' || channel === 'address') return 'door_to_door';
  if (channel === 'phone') return 'cold_call';
  if (channel === 'email' || channel === 'sms') return 'email_dm';
  return 'digital';
}

/** Compact text form of the standards + CPS, embedded in AI prompts. */
function playbookPromptBlock() {
  return [
    'MEETING-SETTING STANDARDS (non-negotiable):',
    ...MEETING_STANDARDS.map(s => `- ${s.label}: ${s.guidance}`),
    '',
    'MEETING STRATEGY - Conversational Problem Solving (for the meeting itself, never before it):',
    ...CPS_STAGES.map(s => `${s.step}. ${s.label}: ${s.goal}`)
  ].join('\n');
}

module.exports = {
  AGENCY_STAGES, OUTREACH_METHODS, CHANNEL_LABELS, CONTACT_CHANNELS, ATTEMPT_RESULTS, LEAD_OUTCOMES, LEAD_STATUSES,
  MEETING_STANDARDS, CPS_STAGES, FUNNEL_STEPS, SERVICES, AD_PLATFORMS, AI_TOOLS, LOSS_REASONS, HIGH_DEMAND_NICHES,
  DEFAULT_CADENCE, DEFAULT_SETTINGS, methodByKey, resultByKey, methodForChannel, playbookPromptBlock
};
