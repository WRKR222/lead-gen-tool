/**
 * Video ad generation, pluggable provider, job-based (submit -> poll).
 *
 * Note on naming: there isn't a shipping public API literally called
 * "Astra" for video generation as of this writing (Astra is Google
 * DeepMind's real-time multimodal assistant project, not a video-gen
 * product) - the closest real fits for AI video-ad generation today are
 * things like OpenAI's Sora API, Google's Veo, Runway and Pika. Rather
 * than hardcode one that may rename/change its API shape by the time you
 * read this, this service wraps the generic "submit a prompt, get a job
 * id, poll for a result URL" shape nearly every one of them uses. Point
 * VIDEO_API_BASE / VIDEO_API_KEY / VIDEO_MODEL at whichever provider you
 * have access to and adjust submitJob()/pollJob() below to match its
 * exact current endpoint paths and payload - same "confirm against
 * current docs before going live" caveat as clayService.js.
 *
 * With no VIDEO_API_KEY (or MOCK_MODE=true): returns a mock job that
 * "completes" instantly with a short text storyboard instead of an actual
 * video, so the rest of the product (content studio UI, asset history,
 * the AI assistant's generate_content tool) can be built and demoed
 * end-to-end for free before you have a real video-gen contract.
 */
const fetch = require('node-fetch');

const VIDEO_API_BASE = process.env.VIDEO_API_BASE;
const VIDEO_API_KEY = process.env.VIDEO_API_KEY;
const VIDEO_MODEL = process.env.VIDEO_MODEL || 'default';
const USE_MOCK = !VIDEO_API_BASE || !VIDEO_API_KEY || process.env.MOCK_MODE === 'true';

async function submitJob(prompt, { durationSeconds = 15, aspectRatio = '9:16' } = {}) {
  const res = await fetch(`${VIDEO_API_BASE}/generations`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${VIDEO_API_KEY}` },
    body: JSON.stringify({ model: VIDEO_MODEL, prompt, duration_seconds: durationSeconds, aspect_ratio: aspectRatio })
  });
  if (!res.ok) throw new Error(`Video API error ${res.status}: ${await res.text().catch(() => '')}`);
  return res.json(); // expected: { id, status }
}

async function pollJob(jobId) {
  const res = await fetch(`${VIDEO_API_BASE}/generations/${jobId}`, {
    headers: { 'Authorization': `Bearer ${VIDEO_API_KEY}` }
  });
  if (!res.ok) throw new Error(`Video API poll error ${res.status}`);
  return res.json(); // expected: { id, status, url? }
}

function mockStoryboard(prompt, durationSeconds) {
  const beats = Math.max(2, Math.min(5, Math.round(durationSeconds / 5)));
  const storyboard = Array.from({ length: beats }, (_, i) => ({
    beat: i + 1,
    seconds: Math.round((durationSeconds / beats) * i),
    shot: i === 0 ? `Open on the problem: ${prompt}` : i === beats - 1 ? 'Close on logo + call to action.' : `Show the solution in action (beat ${i + 1}).`
  }));
  return storyboard;
}

/**
 * @param {string} prompt - the ad concept/script direction
 * @param {object} opts - { durationSeconds, aspectRatio }
 * @returns {Promise<{ status: 'completed'|'queued'|'failed', url: string|null, storyboard?: object[], provider: string, jobId?: string }>}
 */
async function generateVideoAd(prompt, opts = {}) {
  if (USE_MOCK) {
    return {
      status: 'completed', url: null, provider: 'mock',
      storyboard: mockStoryboard(prompt, opts.durationSeconds || 15),
      note: 'Demo mode: no VIDEO_API_BASE/VIDEO_API_KEY configured, so this is a storyboard, not a rendered video. Configure a real provider to get an actual .mp4.'
    };
  }
  try {
    const job = await submitJob(prompt, opts);
    // Real providers are async - report back "queued" with a job id; the
    // frontend/caller polls GET /api/content/video/:jobId (routes/content.js)
    // which calls pollVideoJob() below until status is completed/failed.
    return { status: job.status || 'queued', url: job.url || null, provider: 'video_api:' + VIDEO_MODEL, jobId: job.id };
  } catch (err) {
    console.warn(`[videoGenerationService] submission failed (${err.message}), returning mock storyboard instead.`);
    return { status: 'completed', url: null, provider: 'mock_fallback', storyboard: mockStoryboard(prompt, opts.durationSeconds || 15) };
  }
}

async function pollVideoJob(jobId) {
  if (USE_MOCK || !jobId) return { status: 'completed', url: null };
  const job = await pollJob(jobId);
  return { status: job.status, url: job.url || null };
}

module.exports = { generateVideoAd, pollVideoJob };
