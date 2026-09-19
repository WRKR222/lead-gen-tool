/**
 * AI cold-calling coach: generates a call script (opener, discovery
 * questions, value prop, objection handling, close) tailored to one lead
 * and this company's sales narrative/brand voice - "introducing sales
 * concepts" the way an experienced sales manager would brief a rep before
 * a call. Same real-AI + mock-fallback pattern as the rest of the app.
 */
const fetch = require('node-fetch');

const ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY;
const ANTHROPIC_MODEL = process.env.ANTHROPIC_MODEL || 'claude-sonnet-5';
const USE_MOCK = !ANTHROPIC_API_KEY || process.env.MOCK_MODE === 'true';

function scriptShape() {
  return {
    opener: 'string - first 10-15 seconds, states who you are and why you are calling, earns 20 more seconds',
    discoveryQuestions: ['string', '...3-4 open questions to qualify and understand their situation'],
    valuePropPitch: 'string - 2-3 sentences tying the value prop to what a lead like this likely cares about',
    objectionHandling: { objection_text: 'short_rebuttal' },
    closingAsk: 'string - the specific next step to ask for (meeting/demo/follow-up call)',
    coachingNotes: 'string - one or two tips for the rep specific to this lead (seniority, industry, geo)'
  };
}

async function callModel(system, user) {
  const res = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'x-api-key': ANTHROPIC_API_KEY, 'anthropic-version': '2023-06-01' },
    body: JSON.stringify({ model: ANTHROPIC_MODEL, max_tokens: 900, temperature: 0.6, system, messages: [{ role: 'user', content: user }] })
  });
  if (!res.ok) throw new Error(`Anthropic API error ${res.status}: ${await res.text().catch(() => '')}`);
  const data = await res.json();
  const textBlock = (data.content || []).find(b => b.type === 'text');
  if (!textBlock) throw new Error('No text content returned from model');
  return JSON.parse(textBlock.text.replace(/```json|```/g, '').trim());
}

function localFallbackScript(lead, directions) {
  const sn = directions.salesNarrative || {};
  const sender = directions.sender || {};
  const firstName = lead.contactName ? lead.contactName.split(' ')[0] : 'there';
  return {
    opener: `Hi ${firstName}, this is ${sender.senderName || 'a rep'} from ${sender.companyName || 'our company'}. I know this is out of the blue - I'll be quick. I'm reaching out to ${lead.companyName} because of what you're doing in ${lead.industry || 'your space'}.`,
    discoveryQuestions: [
      `How is ${lead.companyName} currently handling this today?`,
      'What would need to be true for this to be a priority in the next quarter?',
      'Who else is usually involved in a decision like this?'
    ],
    valuePropPitch: sender.valueProposition || `We help companies like ${lead.companyName} solve this more efficiently.`,
    objectionHandling: (sn.objectionHandling) || {
      'Not interested': 'Totally understand - can I ask what you are using today, just so I know for next time?',
      'Send me an email': "Happy to - I'll send something short and specific rather than a generic deck."
    },
    closingAsk: sender.callToAction || 'Would a 15-minute call next week make sense?',
    coachingNotes: `${lead.title || 'This contact'} at a ${lead.companySize || 'this-sized'} company will respond better to concrete outcomes than features - lead with the result, not the how.`,
    _generatedBy: 'local_heuristic_fallback'
  };
}

/**
 * @param {object} lead - { contactName, title, companyName, industry, city, country, companySize }
 * @param {object} directions - company directions (sender, salesNarrative, brand)
 */
async function generateCallScript(lead, directions) {
  if (USE_MOCK) return localFallbackScript(lead, directions);
  try {
    const system = 'You are a sales manager briefing a rep before a cold call. Write ONLY valid JSON matching the given shape, no markdown, no preamble. Be concrete and specific to this lead, never generic.';
    const user = `SENDER: ${JSON.stringify(directions.sender)}
SALES NARRATIVE: ${JSON.stringify(directions.salesNarrative || {})}
LEAD: ${JSON.stringify({ contactName: lead.contactName, title: lead.title, companyName: lead.companyName, industry: lead.industry, city: lead.city, country: lead.country, companySize: lead.companySize })}
SHAPE: ${JSON.stringify(scriptShape())}
Return the filled JSON now.`;
    const script = await callModel(system, user);
    return { ...script, _generatedBy: 'anthropic:' + ANTHROPIC_MODEL };
  } catch (err) {
    console.warn(`[callsService] AI script generation failed (${err.message}), using fallback.`);
    return localFallbackScript(lead, directions);
  }
}

module.exports = { generateCallScript };
