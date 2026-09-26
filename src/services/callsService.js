/**
 * AI cold-calling coach. A cold call has ONE job - book the meeting - so
 * the script follows the meeting-setting standards: reach the decision
 * maker, open straight to the point with a hook, create scarcity, and never
 * pitch (questions are answered in the meeting). The pitch itself lives in
 * the CPS meeting brief (meetingPrepService.js). Real AI + local fallback,
 * like the rest of the app.
 */
const llm = require('./llm');
const { playbookPromptBlock } = require('../config/playbook');

function scriptShape() {
  return {
    opener: 'string - first 10 seconds: who you are + a hook specific to this lead. No "how are you".',
    gatekeeperScript: 'string - what to say if someone other than the decision maker answers (get their name and best time; do not pitch)',
    hook: 'string - one sentence showing you paid attention to THEIR business',
    scarcityLine: 'string - why this is exclusive to them / limited',
    meetingAsk: 'string - the specific ask for a short meeting, with two time options',
    questionDeflection: 'string - how to answer "what is it / how much?" without pitching: it is covered in the meeting',
    objectionHandling: { objection_text: 'short response that keeps the door open' },
    ifTheySayNo: 'string - calm, affirming close that leaves the door open and captures the best contact',
    coachingNotes: 'string - one or two tips for this specific lead'
  };
}

function localFallbackScript(lead, directions) {
  const sender = directions.sender || {};
  const firstName = lead.contactName ? lead.contactName.split(' ')[0] : null;
  const who = lead.companyName || lead.contactName || 'your business';
  return {
    opener: `${firstName ? firstName + ', ' : ''}${sender.senderName && !/team|sales|department|^business/i.test(sender.senderName) ? `it's ${sender.senderName} from` : 'I\'m calling from'} ${sender.companyName || 'our team'}. I'll be quick - I called ${who} specifically, not off a list.`,
    gatekeeperScript: `Could you tell me who makes decisions about new customers and marketing there? ... Great - what's the best time to catch ${firstName || 'them'} directly?`,
    hook: `Most ${lead.industry || 'businesses'} we speak to${lead.city ? ' in ' + lead.city : ''} are leaving customers on the table between the first enquiry and the booking.`,
    scarcityLine: 'We only work with one business like yours per area, and I wanted to offer it to you before anyone else.',
    meetingAsk: 'Can we sit down for 15 minutes - does Tuesday morning or Thursday afternoon suit you better?',
    questionDeflection: "Great question - that's exactly what we'll go through in the meeting, it depends on your business and I'd rather not guess.",
    objectionHandling: {
      "I'm busy": 'Totally understand - that is why it is 15 minutes. Would early morning or end of day be easier?',
      'Send me an email': 'Happy to - what is the best email? And so it is useful, can I pencil 15 minutes to walk through it?',
      'We already do marketing': 'Good - then you will be able to tell quickly if we can add anything. 15 minutes?',
      'How much is it?': "It depends on what you need, which is what the meeting is for - I'd rather give you a real number than a guess."
    },
    ifTheySayNo: 'No problem at all, I appreciate your honesty. Can I send you my details in case timing changes?',
    coachingNotes: `Ask for ${firstName || 'the owner'} by name. Keep it under two minutes, do not explain the service - the only goal is the meeting.`,
    _generatedBy: 'local_heuristic_fallback'
  };
}

/**
 * @param {object} lead - { contactName, title, companyName, industry, city, country, companySize, leadType }
 * @param {object} directions - workspace directions (sender, salesNarrative, brand)
 */
async function generateCallScript(lead, directions) {
  if (!llm.enabled()) return localFallbackScript(lead, directions);
  try {
    const system = `You are a sales manager briefing a rep before a cold call whose ONLY goal is to book a meeting. Write ONLY valid JSON matching the given shape, no markdown, no preamble. Be concrete and specific to this lead, never generic. Never include a pitch of the service.\n\n${playbookPromptBlock()}`;
    const user = `SENDER: ${JSON.stringify(directions.sender)}
LEAD: ${JSON.stringify({ leadType: lead.leadType, contactName: lead.contactName, title: lead.title, companyName: lead.companyName, industry: lead.industry, city: lead.city, country: lead.country, companySize: lead.companySize })}
SHAPE: ${JSON.stringify(scriptShape())}
Return the filled JSON now.`;
    const script = await llm.completeJson({ system, user, effort: 'low', maxTokens: 6000 });
    return { ...llm.withFallback(script, localFallbackScript(lead, directions)), _generatedBy: 'anthropic:' + llm.MODEL };
  } catch (err) {
    console.warn(`[callsService] AI script generation failed (${err.message}), using fallback.`);
    return localFallbackScript(lead, directions);
  }
}

module.exports = { generateCallScript, localFallbackScript };
