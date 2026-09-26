/**
 * The one place this app talks to Claude (official Anthropic SDK).
 *
 * Every AI feature calls `llm.enabled()` first and keeps its own
 * deterministic fallback, so the product still works end to end with no
 * API key (or MOCK_MODE=true) - see the "real integration + safe fallback"
 * principle in the Architecture Plan.
 */
const Anthropic = require('@anthropic-ai/sdk');

const MODEL = process.env.ANTHROPIC_MODEL || 'claude-opus-5';
// Server-side refusal fallback: if the model's safety classifiers decline
// a request, the API re-runs it on Anthropic's recommended fallback model
// inside the same call. Only sent for models that support it.
const FALLBACK_MODELS = new Set(['claude-opus-5', 'claude-fable-5-1']);
const USE_FALLBACKS = FALLBACK_MODELS.has(MODEL) && process.env.ANTHROPIC_FALLBACKS !== 'off';

let client = null;
function getClient() {
  if (!client) client = new Anthropic({ maxRetries: 2, timeout: 120000 });
  return client;
}

function enabled() {
  return !!process.env.ANTHROPIC_API_KEY && process.env.MOCK_MODE !== 'true';
}

/**
 * @param {object} params - Messages API params (system, messages, tools, max_tokens, output_config ...)
 * @returns {Promise<object>} the Message
 */
async function create(params) {
  const body = { model: MODEL, max_tokens: 16000, ...params };
  if (USE_FALLBACKS) {
    return getClient().beta.messages.create({ ...body, betas: ['server-side-fallback-2026-07-01'], fallbacks: 'default' });
  }
  return getClient().messages.create(body);
}

function textOf(message) {
  if (message.stop_reason === 'refusal') throw new Error('The model declined this request');
  return (message.content || []).filter(b => b.type === 'text').map(b => b.text).join('\n').trim();
}

/** Pull the first JSON object/array out of a model reply (tolerates code fences / stray prose). */
function parseJsonLoose(text) {
  const cleaned = text.replace(/```(?:json)?/gi, '').trim();
  try { return JSON.parse(cleaned); } catch { /* fall through */ }
  const start = cleaned.search(/[[{]/);
  if (start === -1) throw new Error('No JSON found in model output');
  const open = cleaned[start];
  const close = open === '{' ? '}' : ']';
  const end = cleaned.lastIndexOf(close);
  if (end <= start) throw new Error('Unterminated JSON in model output');
  return JSON.parse(cleaned.slice(start, end + 1));
}

/**
 * One-shot text generation.
 * @param {object} o - { system, user | content, effort, maxTokens }
 */
async function complete({ system, user, content, effort = 'medium', maxTokens = 16000 }) {
  const message = await create({
    system,
    max_tokens: maxTokens,
    output_config: { effort },
    messages: [{ role: 'user', content: content || user }]
  });
  return textOf(message);
}

/** One-shot generation that must return JSON. */
async function completeJson(opts) {
  const text = await complete(opts);
  return parseJsonLoose(text);
}

/**
 * Fill anything the model left out from the deterministic fallback, one
 * level deep, so downstream code can always rely on the shape. Arrays and
 * scalars from the model win when present and non-empty.
 */
function withFallback(generated, fallback) {
  if (!generated || typeof generated !== 'object' || Array.isArray(generated)) return fallback;
  const out = { ...fallback };
  for (const [k, v] of Object.entries(generated)) {
    const base = fallback[k];
    if (v == null || (Array.isArray(v) && !v.length && Array.isArray(base))) continue;
    if (Array.isArray(base)) out[k] = Array.isArray(v) ? v : base;
    else if (base && typeof base === 'object') out[k] = v && typeof v === 'object' && !Array.isArray(v) ? { ...base, ...v } : base;
    else out[k] = v;
  }
  return out;
}

/**
 * Content blocks safe to send back as the assistant turn in a tool loop.
 * After a mid-output fallback, blocks the declined model produced before
 * the last `fallback` marker (other than text) must not be echoed.
 */
function echoableContent(content) {
  const lastFallback = content.map(b => b.type).lastIndexOf('fallback');
  if (lastFallback === -1) return content;
  return content.filter((b, i) => i > lastFallback || b.type === 'text');
}

module.exports = { MODEL, enabled, create, complete, completeJson, parseJsonLoose, textOf, echoableContent, withFallback };
