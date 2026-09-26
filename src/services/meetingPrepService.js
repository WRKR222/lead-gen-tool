/**
 * CPS (Conversational Problem Solving) meeting brief: Attention ->
 * Identify -> Solve -> Cost, personalised to one lead, with the price
 * anchored on the workspace's value pyramid and the objections this
 * workspace has actually lost deals to (from churn/loss learning).
 */
const llm = require('./llm');
const { CPS_STAGES, playbookPromptBlock } = require('../config/playbook');

function priceAnchor(pyramid) {
  const tiers = (pyramid?.tiers || []).filter(t => t.price > 0 && t.key !== 'lifetime');
  const core = tiers.find(t => t.key === 'core_offer') || tiers[0];
  return core ? { offer: core.name, price: core.price, currency: pyramid.currency } : null;
}

function fallbackBrief(lead, directions, pyramid, lossReasons = []) {
  const who = lead.companyName || lead.contactName || 'the prospect';
  const anchor = priceAnchor(pyramid);
  return {
    attention: {
      openingObservation: `Open with something specific you noticed about ${who}${lead.city ? ' in ' + lead.city : ''} (their reviews, their location, their busiest times).`,
      toneSetter: "I'm here to learn about your business. If there's real potential for us to grow together, I may make you an offer - and if not, no problem.",
      askWhyTheyAccepted: 'Before we start - what made you agree to meet today?'
    },
    identify: {
      questions: [
        'Do you have a revenue goal for this year? How close are you right now?',
        'Why that goal - growth, stability, something personal?',
        `Where do you lose the most ${lead.leadType === 'person' ? 'bookings' : 'customers'} today - getting enquiries, or turning them into sales?`,
        'What does that problem cost you each month?',
        "What's stopped you from solving it yourself so far?"
      ],
      listenFor: ['A concrete number (revenue gap, lost customers)', 'Emotional reason behind the goal', 'Past attempts that failed and why'],
      acknowledge: 'Repeat their problem back in their words before moving on.'
    },
    solve: {
      elevatorPitch: `${directions.sender?.companyName || 'We'} ${directions.sender?.companyOneLiner ? directions.sender.companyOneLiner.replace(/^[A-Z]/, c => c.toLowerCase()) : 'fix exactly this kind of problem'} - for businesses like yours, that means more of the right customers booked in without you chasing them.`,
      intrigueLines: ['There are a couple of things we do differently that I think would surprise you.', 'The results depend on setting it up specifically for you, which is what I would do next.'],
      doNotMention: ['Tool names or software', 'Every service - keep something back', 'Discounts before they ask the price']
    },
    cost: {
      anchor,
      howToState: anchor ? `Wait for them to ask. Then: "It's ${anchor.currency} ${anchor.price.toLocaleString()} for ${anchor.offer}." - then stop talking.` : 'Wait for them to ask, state the price once, then stop talking.',
      ifRejected: "That's completely fair - I appreciate you being straight with me. Can I stay in touch in case the timing changes?",
      captureContact: 'Confirm the best phone/WhatsApp and email before you leave, whatever the answer.'
    },
    knownObjections: lossReasons.slice(0, 3),
    reminders: ['Decision maker in the room?', 'No pitch until the Solve stage', 'Silence after the price'],
    _generatedBy: 'local_template'
  };
}

/**
 * @param {object} lead - lead shape
 * @param {object} directions - workspace directions
 * @param {object} pyramid - workspace value pyramid
 * @param {string[]} lossReasons - top reasons this workspace has lost deals/customers
 */
async function generateCpsBrief(lead, directions, pyramid, lossReasons = []) {
  if (!llm.enabled()) return fallbackBrief(lead, directions, pyramid, lossReasons);
  try {
    const system = `You prepare sales reps for a Conversational Problem Solving meeting. Return ONLY valid JSON, no markdown. Be specific to this lead.\n\n${playbookPromptBlock()}`;
    const user = `SELLER: ${JSON.stringify(directions.sender || {})}
SALES NARRATIVE: ${JSON.stringify(directions.salesNarrative || {})}
LEAD: ${JSON.stringify(lead)}
VALUE PYRAMID (price anchor for the Cost stage): ${JSON.stringify(pyramid || {})}
REASONS WE HAVE LOST DEALS BEFORE (pre-empt these): ${JSON.stringify(lossReasons)}
CPS STAGES: ${JSON.stringify(CPS_STAGES)}
SHAPE: ${JSON.stringify({
  attention: { openingObservation: '', toneSetter: '', askWhyTheyAccepted: '' },
  identify: { questions: [''], listenFor: [''], acknowledge: '' },
  solve: { elevatorPitch: 'intrigue, no tool names, not everything', intrigueLines: [''], doNotMention: [''] },
  cost: { anchor: { offer: '', price: 0, currency: '' }, howToState: '', ifRejected: '', captureContact: '' },
  knownObjections: [''], reminders: ['']
})}`;
    const brief = await llm.completeJson({ system, user, effort: 'medium', maxTokens: 10000 });
    return { ...llm.withFallback(brief, fallbackBrief(lead, directions, pyramid, lossReasons)), _generatedBy: 'anthropic:' + llm.MODEL };
  } catch (err) {
    console.warn(`[meetingPrepService] AI brief failed (${err.message}), using template.`);
    return fallbackBrief(lead, directions, pyramid, lossReasons);
  }
}

module.exports = { generateCpsBrief, fallbackBrief };
