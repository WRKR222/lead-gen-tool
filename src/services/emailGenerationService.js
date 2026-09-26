/**
 * Generates a fully custom cold email for a single lead, every time it's
 * called - no shared templates, no merge-field placeholders. Two emails
 * to the same lead (e.g. the intro and a later follow-up, or a resend)
 * will never match, because every generation call:
 *
 *  1. Pulls that lead's full history of emails already sent to them
 *     (subject + body, oldest to newest) from campaign_sends, and gives
 *     it to the model as "already said, do not repeat".
 *  2. Picks a fresh rhetorical angle (pain point / social proof /
 *     question / industry trend / curiosity / referral-style) that is
 *     different from the angle used in the immediately previous email
 *     to that lead.
 *  3. Passes the full history as "do not repeat", so phrasing varies even
 *     when the underlying facts (lead + company) are the same.
 *  4. Post-generation, does a similarity check against prior emails to
 *     that lead and regenerates once if the new draft is too close to
 *     an existing one.
 *
 * Swap ANTHROPIC_MODEL / the API call below for any other LLM provider
 * if you don't want to use Claude for generation - the interface
 * (generateEmailForLead) stays the same either way.
 */
const { db } = require('../db/database');
const llm = require('./llm');
const { playbookPromptBlock } = require('../config/playbook');

const ANGLES = ['pain_point', 'social_proof', 'curiosity_question', 'industry_trend', 'direct_value_prop', 'mutual_connection_style'];

/** Every email already sent to this lead - campaign sends and direct/bulk/follow-up sends. */
function getSendHistory(leadId) {
  return db.prepare(`
    SELECT step_id, subject, body, angle, sent_at FROM campaign_sends
    WHERE lead_id = ? AND status = 'sent'
    UNION ALL
    SELECT mode AS step_id, subject, body, angle, sent_at FROM email_messages
    WHERE lead_id = ? AND direction = 'outbound' AND status = 'sent'
    ORDER BY sent_at ASC
  `).all(leadId, leadId);
}

function pickAngle(history) {
  const lastAngle = history.length ? history[history.length - 1].angle : null;
  const usedRecently = new Set(history.slice(-2).map(h => h.angle));
  const options = ANGLES.filter(a => a !== lastAngle && !usedRecently.has(a));
  const pool = options.length ? options : ANGLES;
  return pool[Math.floor(Math.random() * pool.length)];
}

function buildPrompt(lead, directions, history, angle, stepId) {
  const { sender } = directions;
  const historyBlock = history.length
    ? history.map((h, i) => `--- Previous email #${i + 1} (step: ${h.step_id}, angle: ${h.angle || 'unknown'}) ---\nSubject: ${h.subject}\n${h.body}`).join('\n\n')
    : '(No previous emails have been sent to this lead - this is the first touch.)';

  const system = `You write short, specific, non-generic outreach emails on behalf of a real sender whose ONLY goal is to book a meeting. \
Hard rules:
- Every email must be substantively different in wording, structure, and opening line from every previous email listed below, even though it's the same lead and same company.
- Never reuse a sentence, phrase, or subject line from a previous email to this lead.
- Keep it under 110 words. No em dashes, no "I hope this finds you well", no generic filler.
- Reference something specific and plausible about the lead - infer sensibly from the data given, don't invent false specifics like fake mutual connections or fake stats.
- Follow the standards below: straight to the point with a hook, create scarcity/exclusivity, address the decision maker, and NEVER pitch the service - the ask is a short meeting.
- Write ONLY valid JSON: {"subject": "...", "body": "..."}. No markdown, no preamble.
- The requested rhetorical angle for THIS email is: ${angle}.
- This is step "${stepId}" in the outreach sequence.

${playbookPromptBlock()}`;

  const user = `SENDER:
Name: ${sender.senderName}, ${sender.senderTitle} at ${sender.companyName}
One-liner: ${sender.companyOneLiner}
Value proposition: ${sender.valueProposition}
Proof point (only use if it fits naturally, don't force it): ${sender.proofPoint}
Desired call to action: ${sender.callToAction}

${directions.bookingLink ? `Meeting booking link (include it): ${directions.bookingLink}\n` : ''}
LEAD (${lead.leadType === 'person' ? 'an individual person' : 'a business'}):
Contact: ${lead.contactName || 'Unknown name'}
Title: ${lead.title || 'Unknown title'}
Company: ${lead.companyName || '(individual)'}
Industry: ${lead.industry || 'unknown'}
Location: ${[lead.city, lead.country].filter(Boolean).join(', ') || 'unknown'}
Company size: ${lead.companySize || 'unknown'}

EMAILS ALREADY SENT TO THIS LEAD (do not repeat any of this):
${historyBlock}

Write the next email now, as JSON only.`;

  return { system, user };
}

function crudeSimilarity(a, b) {
  const setA = new Set(a.toLowerCase().split(/\W+/).filter(Boolean));
  const setB = new Set(b.toLowerCase().split(/\W+/).filter(Boolean));
  const intersection = [...setA].filter(w => setB.has(w)).length;
  const union = new Set([...setA, ...setB]).size;
  return union === 0 ? 0 : intersection / union;
}

function callModel(system, user) {
  return llm.completeJson({ system, user, effort: 'low', maxTokens: 4000 });
}

/**
 * Zero-cost local fallback used when ANTHROPIC_API_KEY isn't set (or
 * MOCK_MODE=true). Not true generative AI - it recombines angle-specific
 * phrase pools and lead-specific facts so that runs still produce
 * genuinely different subjects/bodies per lead and per send (never the
 * exact same string twice), enough to exercise and demo the whole
 * pipeline for free. Swap to callModel() (real AI) for production emails
 * that read as truly personalized and high quality - this fallback is
 * intentionally simple.
 */
const OPENERS = {
  pain_point: [
    (l) => `Noticed ${l.companyName} is scaling in ${l.industry || 'your space'} - onboarding usually gets messier right around here.`,
    (l) => `Most ${l.industry || 'growing'} teams hit a wall managing this manually around ${l.companySize || 'this'} employees.`
  ],
  social_proof: [
    (l) => `A few ${l.industry || 'similar'} teams we work with cut this down significantly last quarter.`,
    (l) => `Companies your size in ${l.country || 'your market'} have been asking us about exactly this.`
  ],
  curiosity_question: [
    (l) => `Quick question, ${l.contactName ? l.contactName.split(' ')[0] : 'there'} - how is ${l.companyName} currently handling this today?`,
    (l) => `Curious how ${l.companyName} thinks about this as you grow.`
  ],
  industry_trend: [
    (l) => `${l.industry || 'Your industry'} is shifting fast this year, and most teams aren't set up for it yet.`,
    (l) => `We're seeing a pattern across ${l.industry || 'this space'} worth flagging for ${l.companyName}.`
  ],
  direct_value_prop: [
    (l) => `Straight to it: we help teams like ${l.companyName} solve this directly.`,
    (l) => `Wanted to reach out directly given where ${l.companyName} is headed.`
  ],
  mutual_connection_style: [
    (l) => `Reaching out because ${l.companyName}'s work in ${l.industry || 'this space'} caught our attention.`,
    (l) => `Came across ${l.companyName} recently and thought this was worth a note.`
  ]
};

function localFallbackGenerate(lead, directions, angle, stepId) {
  const { sender } = directions;
  const who = lead.companyName || lead.contactName || 'you';
  const opener = pick(OPENERS[angle] || OPENERS.direct_value_prop)({ ...lead, companyName: who });
  const scarcity = pick([
    `We only take on one business like yours per area, and ${lead.city || 'your area'} is still open.`,
    `We keep our client list small on purpose so each one gets real attention - there is room for one more this month.`,
    `I am reaching out to you specifically, not a list - I think ${who} is a strong fit.`
  ]);
  const ask = pick([
    'Open to a 15-minute conversation this week? I will answer everything there.',
    'Can we find 15 minutes this week? Any questions, I will cover in the meeting.',
    'Worth a short meeting to see if there is a fit?'
  ]);
  const booking = directions.bookingLink ? `\n\nPick a time here: ${directions.bookingLink}` : '';
  const body = `${opener}\n\n${scarcity}\n\n${ask}${booking}\n\n${sender.senderName}\n${sender.companyName}`;
  const subjects = [
    `Quick one for ${who}`,
    `${who} + ${sender.companyName}`,
    `${lead.contactName ? lead.contactName.split(' ')[0] : 'Quick note'} - 15 minutes?`,
    `${stepId === 'intro' ? 'Introduction' : 'Following up'} - ${who}`
  ];
  return { subject: pick(subjects), body: `${body}\n\n[demo mode - not sent by real AI]` };
}

function pick(arr) { return arr[Math.floor(Math.random() * arr.length)]; }

/**
 * @param {object} lead - { id, contactName, title, companyName, industry, city, country, companySize }
 * @param {object} directions - full directions.json config
 * @param {string} stepId - e.g. 'intro' | 'followup_1' | 'followup_2_breakup'
 * @returns {Promise<{subject: string, body: string, angle: string}>}
 */
async function generateEmailForLead(lead, directions, stepId) {
  const useMock = !llm.enabled();
  const history = getSendHistory(lead.id);
  let angle = pickAngle(history);

  if (useMock) {
    let draft = localFallbackGenerate(lead, directions, angle, stepId);
    const tooSimilar = history.some(h => crudeSimilarity(draft.body, h.body) > 0.55);
    if (tooSimilar) {
      angle = pickAngle([...history, { angle }]);
      draft = localFallbackGenerate(lead, directions, angle, stepId);
    }
    return { subject: draft.subject, body: draft.body, angle };
  }

  let { system, user } = buildPrompt(lead, directions, history, angle, stepId);
  let draft = await callModel(system, user);

  // Uniqueness guard: if the new draft is too similar to any prior email
  // to this lead, regenerate once with a different angle and an explicit
  // nudge.
  const tooSimilar = history.some(h => crudeSimilarity(draft.body, h.body) > 0.55);
  if (tooSimilar) {
    angle = pickAngle([...history, { angle }]); // force a different angle than the one just used
    const retry = buildPrompt(lead, directions, history, angle, stepId);
    retry.user += '\n\nIMPORTANT: your first attempt was too similar to a previous email. Use a distinctly different opening line and structure this time.';
    draft = await callModel(retry.system, retry.user);
  }

  if (!draft || !draft.subject || !draft.body) {
    const fb = localFallbackGenerate(lead, directions, angle, stepId);
    return { subject: fb.subject, body: fb.body.replace('\n\n[demo mode - not sent by real AI]', ''), angle };
  }
  return { subject: draft.subject, body: draft.body, angle };
}

module.exports = { generateEmailForLead, getSendHistory };
