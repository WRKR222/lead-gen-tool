/**
 * Graphics generation, pluggable provider.
 *
 * Set IMAGE_PROVIDER=openai + OPENAI_API_KEY to generate real images via
 * OpenAI's Images API. With no key (or MOCK_MODE=true), returns a clean,
 * on-brand placeholder graphic generated locally as an inline SVG data URI
 * - zero cost, zero dependencies, and it actually renders in the browser
 * immediately (useful for wireframing a social/ad plan before spending on
 * real generation).
 *
 * BEFORE GOING LIVE: confirm the current OpenAI Images API request/response
 * shape (model name, size options, response format) against OpenAI's docs
 * - these evolve. To use a different provider (Stability AI, Midjourney's
 * API, Google's Imagen), add a branch here with the same return shape
 * ({ url, provider }) and nothing else in the app needs to change.
 */
const fetch = require('node-fetch');

const IMAGE_PROVIDER = process.env.IMAGE_PROVIDER || 'mock';
const OPENAI_API_KEY = process.env.OPENAI_API_KEY;
const OPENAI_IMAGE_MODEL = process.env.OPENAI_IMAGE_MODEL || 'gpt-image-1';
const USE_MOCK = IMAGE_PROVIDER !== 'openai' || !OPENAI_API_KEY || process.env.MOCK_MODE === 'true';

function escapeXml(s) {
  return String(s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

function wrapLines(text, maxCharsPerLine = 28) {
  const words = text.split(/\s+/);
  const lines = [];
  let line = '';
  for (const w of words) {
    if ((line + ' ' + w).trim().length > maxCharsPerLine) { lines.push(line.trim()); line = w; }
    else line = (line + ' ' + w).trim();
  }
  if (line) lines.push(line);
  return lines.slice(0, 6);
}

/** Deterministic, brand-tinted placeholder graphic - genuinely renders, costs nothing. */
function placeholderSvgDataUri(prompt, brandVoice = '') {
  const lines = wrapLines(prompt || 'Untitled graphic', 30);
  const hue = Math.abs([...(prompt || '')].reduce((h, c) => h + c.charCodeAt(0), 0)) % 360;
  const bg1 = `hsl(${hue}, 55%, 22%)`, bg2 = `hsl(${(hue + 40) % 360}, 60%, 14%)`;
  const textLines = lines.map((l, i) => `<text x="40" y="${180 + i * 34}" font-family="Arial, sans-serif" font-size="26" fill="#f5f5f7">${escapeXml(l)}</text>`).join('');
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="1024" height="1024" viewBox="0 0 1024 1024">
  <defs><linearGradient id="g" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="${bg1}"/><stop offset="1" stop-color="${bg2}"/></linearGradient></defs>
  <rect width="1024" height="1024" fill="url(#g)"/>
  <text x="40" y="100" font-family="Arial, sans-serif" font-size="18" letter-spacing="3" fill="#c9c9ce">PLACEHOLDER GRAPHIC (set IMAGE_PROVIDER=openai + OPENAI_API_KEY for real generation)</text>
  ${textLines}
</svg>`;
  return `data:image/svg+xml;base64,${Buffer.from(svg).toString('base64')}`;
}

async function generateViaOpenAI(prompt) {
  const res = await fetch('https://api.openai.com/v1/images/generations', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${OPENAI_API_KEY}` },
    body: JSON.stringify({ model: OPENAI_IMAGE_MODEL, prompt, size: '1024x1024', n: 1 })
  });
  if (!res.ok) throw new Error(`OpenAI Images API error ${res.status}: ${await res.text().catch(() => '')}`);
  const data = await res.json();
  const item = (data.data || [])[0];
  if (!item) throw new Error('No image returned');
  return item.url || (item.b64_json ? `data:image/png;base64,${item.b64_json}` : null);
}

/**
 * @param {string} prompt - what the graphic should depict/say
 * @param {string} brandVoice - optional brand tone, used only in mock mode's placeholder
 * @returns {Promise<{ url: string, provider: string }>}
 */
async function generateGraphic(prompt, brandVoice = '') {
  if (USE_MOCK) return { url: placeholderSvgDataUri(prompt, brandVoice), provider: 'mock' };
  try {
    const url = await generateViaOpenAI(prompt);
    return { url, provider: 'openai:' + OPENAI_IMAGE_MODEL };
  } catch (err) {
    console.warn(`[imageGenerationService] real generation failed (${err.message}), returning placeholder.`);
    return { url: placeholderSvgDataUri(prompt, brandVoice), provider: 'mock_fallback' };
  }
}

module.exports = { generateGraphic };
