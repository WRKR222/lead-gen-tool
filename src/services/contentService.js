/**
 * Content studio (text): sales pitches, ad copy/ad ideas, and social media
 * plans, all generated from this company's own directions (brand voice,
 * sales narrative, value prop) so output is unique per company, not a
 * generic template. Every generation is persisted to `content_assets` so
 * a company can browse and reuse past output instead of regenerating.
 * Same real-AI + mock-fallback pattern as the rest of the app.
 */
const fetch = require('node-fetch');
const { v4: uuid } = require('uuid');
const { db } = require('../db/database');

const ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY;
const ANTHROPIC_MODEL = process.env.ANTHROPIC_MODEL || 'claude-sonnet-5';
const USE_MOCK = !ANTHROPIC_API_KEY || process.env.MOCK_MODE === 'true';

async function callModel(system, user, maxTokens = 1400) {
  const res = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'x-api-key': ANTHROPIC_API_KEY, 'anthropic-version': '2023-06-01' },
    body: JSON.stringify({ model: ANTHROPIC_MODEL, max_tokens: maxTokens, temperature: 0.75, system, messages: [{ role: 'user', content: user }] })
  });
  if (!res.ok) throw new Error(`Anthropic API error ${res.status}: ${await res.text().catch(() => '')}`);
  const data = await res.json();
  const textBlock = (data.content || []).find(b => b.type === 'text');
  if (!textBlock) throw new Error('No text content returned from model');
  return JSON.parse(textBlock.text.replace(/```json|```/g, '').trim());
}

function saveAsset(companyId, { leadId, type, provider, prompt, resultText, resultUrl, status }) {
  const id = uuid();
  db.prepare(`
    INSERT INTO content_assets (id, company_id, lead_id, type, provider, prompt, result_text, result_url, status)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(id, companyId, leadId || null, type, provider, prompt || null, resultText ? JSON.stringify(resultText) : null, resultUrl || null, status || 'completed');
  return db.prepare('SELECT * FROM content_assets WHERE id = ?').get(id);
}

function parseAsset(row) {
  return row ? { ...row, result_text: row.result_text ? JSON.parse(row.result_text) : null } : row;
}

// ---------- Sales pitch ----------

function fallbackPitch(directions, lead) {
  const sn = directions.salesNarrative || {};
  const sender = directions.sender || {};
  return {
    elevatorPitch: sn.elevatorPitch || sender.valueProposition || `${sender.companyName} helps businesses grow.`,
    fullScript: `${sn.elevatorPitch || sender.valueProposition}\n\nThe problem: ${(sn.painPointsSolved || [])[0] || 'inefficiency and lost time'}.\nOur approach: ${sender.valueProposition}.\nWhy now: ${(sn.painPointsSolved || [])[1] || 'the cost of waiting compounds'}.\nProof: ${sender.proofPoint || '(add a real result once available)'}.\nAsk: ${sender.callToAction}`,
    talkingPoints: sn.painPointsSolved || ['Saves time', 'Reduces cost', 'Easy to adopt'],
    personalizedFor: lead ? lead.companyName : null,
    _generatedBy: 'local_heuristic_fallback'
  };
}

async function generateSalesPitch(companyId, directions, lead = null) {
  let result;
  if (USE_MOCK) result = fallbackPitch(directions, lead);
  else {
    try {
      const system = 'You are a sales enablement expert. Write ONLY valid JSON: {"elevatorPitch":"","fullScript":"","talkingPoints":["",""]}. No markdown.';
      const user = `SENDER: ${JSON.stringify(directions.sender)}\nSALES NARRATIVE: ${JSON.stringify(directions.salesNarrative || {})}\nBRAND VOICE: ${directions.brand?.voice || ''}\n${lead ? 'PERSONALIZE FOR THIS PROSPECT: ' + JSON.stringify(lead) : 'Write a general pitch (no specific prospect).'}\nReturn JSON now.`;
      result = { ...(await callModel(system, user)), personalizedFor: lead ? lead.companyName : null, _generatedBy: 'anthropic:' + ANTHROPIC_MODEL };
    } catch (err) {
      console.warn(`[contentService] pitch generation failed (${err.message}), using fallback.`);
      result = fallbackPitch(directions, lead);
    }
  }
  return parseAsset(saveAsset(companyId, { leadId: lead?.id, type: 'sales_pitch', provider: USE_MOCK ? 'mock' : 'anthropic', resultText: result }));
}

// ---------- Ad copy / ad ideas ----------

function fallbackAdCopy(directions, lead) {
  const sender = directions.sender || {};
  const themes = directions.brand?.themes || ['results', 'trust', 'speed'];
  return {
    adIdeas: themes.map(t => `A short before/after story showing the impact of solving "${t}" - real numbers if you have them, a clear single message if not.`),
    variations: [
      { platform: 'facebook_instagram', headline: `${sender.companyName}: ${themes[0] || 'get more done'}`, primaryText: sender.valueProposition, cta: sender.callToAction },
      { platform: 'google_search', headline: `${sender.companyName} | ${themes[0] || 'Solutions'}`, primaryText: (sender.valueProposition || '').slice(0, 90), cta: 'Learn more' },
      { platform: 'linkedin', headline: `How ${sender.companyName} helps ${directions.idealCustomerProfile?.industries?.[0] || 'growing teams'}`, primaryText: sender.valueProposition, cta: sender.callToAction }
    ],
    videoAdConcepts: [
      { concept: `15-second problem/solution: open on the pain point (${themes[0] || 'the problem'}), cut to the fix, end on the CTA.`, lengthSeconds: 15 },
      { concept: 'Customer-style testimonial read (can be AI-voiced) over simple on-screen text.', lengthSeconds: 20 }
    ],
    personalizedFor: lead ? lead.companyName : null,
    _generatedBy: 'local_heuristic_fallback'
  };
}

async function generateAdCopy(companyId, directions, lead = null) {
  let result;
  if (USE_MOCK) result = fallbackAdCopy(directions, lead);
  else {
    try {
      const system = 'You are a performance marketing copywriter. Write ONLY valid JSON: {"adIdeas":["",""],"variations":[{"platform":"","headline":"","primaryText":"","cta":""}],"videoAdConcepts":[{"concept":"","lengthSeconds":15}]}. Provide at least 4 adIdeas, 3 variations (facebook_instagram, google_search, linkedin), and 2 videoAdConcepts. No markdown.';
      const user = `SENDER: ${JSON.stringify(directions.sender)}\nBRAND: ${JSON.stringify(directions.brand || {})}\nICP: ${JSON.stringify(directions.idealCustomerProfile)}\n${lead ? 'PERSONALIZE FOR THIS PROSPECT: ' + JSON.stringify(lead) : ''}\nReturn JSON now.`;
      result = { ...(await callModel(system, user)), personalizedFor: lead ? lead.companyName : null, _generatedBy: 'anthropic:' + ANTHROPIC_MODEL };
    } catch (err) {
      console.warn(`[contentService] ad copy generation failed (${err.message}), using fallback.`);
      result = fallbackAdCopy(directions, lead);
    }
  }
  return parseAsset(saveAsset(companyId, { leadId: lead?.id, type: 'ad_copy', provider: USE_MOCK ? 'mock' : 'anthropic', resultText: result }));
}

// ---------- Social media plan ----------

function fallbackSocialPlan(directions, days) {
  const themes = directions.brand?.themes || ['product', 'customer story', 'behind the scenes', 'tip', 'industry news'];
  const platforms = ['linkedin', 'instagram', 'facebook', 'x', 'tiktok'];
  const posts = [];
  for (let i = 0; i < days; i++) {
    const theme = themes[i % themes.length];
    posts.push({
      day: i + 1, platform: platforms[i % platforms.length], theme,
      caption: `${theme[0].toUpperCase()}${theme.slice(1)} spotlight - a short post about ${theme} relevant to ${directions.sender?.companyName || 'us'}.`,
      hashtags: [`#${(directions.idealCustomerProfile?.industries?.[0] || 'business').replace(/\s+/g, '')}`, '#Kenya', '#SME'],
      imagePrompt: `Clean, modern graphic representing "${theme}" in ${directions.sender?.companyName || 'the brand'}'s colors.`
    });
  }
  return { days, posts, _generatedBy: 'local_heuristic_fallback' };
}

async function generateSocialPlan(companyId, directions, { days = 14 } = {}) {
  let result;
  if (USE_MOCK) result = fallbackSocialPlan(directions, days);
  else {
    try {
      const system = `You are a social media strategist. Write ONLY valid JSON: {"days":${days},"posts":[{"day":1,"platform":"","theme":"","caption":"","hashtags":["",""],"imagePrompt":""}]}. Produce exactly ${days} posts, rotating across linkedin/instagram/facebook/x/tiktok, using the brand's content themes. No markdown.`;
      const user = `SENDER: ${JSON.stringify(directions.sender)}\nBRAND: ${JSON.stringify(directions.brand || {})}\nReturn JSON now.`;
      result = { ...(await callModel(system, user, 2200)), _generatedBy: 'anthropic:' + ANTHROPIC_MODEL };
    } catch (err) {
      console.warn(`[contentService] social plan generation failed (${err.message}), using fallback.`);
      result = fallbackSocialPlan(directions, days);
    }
  }
  return parseAsset(saveAsset(companyId, { type: 'social_plan', provider: USE_MOCK ? 'mock' : 'anthropic', resultText: result }));
}

function listContent(companyId, type) {
  let q = 'SELECT * FROM content_assets WHERE company_id = ?';
  const params = [companyId];
  if (type) { q += ' AND type = ?'; params.push(type); }
  q += ' ORDER BY created_at DESC LIMIT 100';
  return db.prepare(q).all(...params).map(parseAsset);
}

module.exports = { generateSalesPitch, generateAdCopy, generateSocialPlan, listContent, saveAsset, parseAsset };
