const express = require('express');
const { db } = require('../db/database');
const contentService = require('../services/contentService');
const imageGen = require('../services/imageGenerationService');
const videoGen = require('../services/videoGenerationService');
const { getDirections } = require('../services/directionsService');
const { requireAuth } = require('../middleware/auth');

const router = express.Router();
router.use(requireAuth);

function loadLead(companyId, leadId) {
  if (!leadId) return null;
  const l = db.prepare('SELECT * FROM leads WHERE id = ? AND company_id = ?').get(leadId, companyId);
  if (!l) return null;
  return { id: l.id, contactName: l.contact_name, title: l.title, companyName: l.company_name, industry: l.industry, city: l.city, country: l.country, companySize: l.company_size };
}

/** GET /api/content?type=sales_pitch|ad_copy|social_plan|graphic|video_ad */
router.get('/', (req, res) => {
  res.json(contentService.listContent(req.auth.companyId, req.query.type));
});

/** POST /api/content/sales-pitch  body: { leadId? } */
router.post('/sales-pitch', async (req, res) => {
  try {
    const directions = getDirections(req.auth.companyId);
    const asset = await contentService.generateSalesPitch(req.auth.companyId, directions, loadLead(req.auth.companyId, req.body.leadId));
    res.json(asset);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

/** POST /api/content/ad-copy  body: { leadId? } - ad ideas, copy variations, and video-ad concepts */
router.post('/ad-copy', async (req, res) => {
  try {
    const directions = getDirections(req.auth.companyId);
    const asset = await contentService.generateAdCopy(req.auth.companyId, directions, loadLead(req.auth.companyId, req.body.leadId));
    res.json(asset);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

/** POST /api/content/social-plan  body: { days? } */
router.post('/social-plan', async (req, res) => {
  try {
    const directions = getDirections(req.auth.companyId);
    const asset = await contentService.generateSocialPlan(req.auth.companyId, directions, { days: req.body.days || 14 });
    res.json(asset);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

/** POST /api/content/graphic  body: { prompt, leadId? } */
router.post('/graphic', async (req, res) => {
  try {
    const { prompt, leadId } = req.body;
    if (!prompt) return res.status(400).json({ error: 'prompt is required' });
    const directions = getDirections(req.auth.companyId);
    const { url, provider } = await imageGen.generateGraphic(prompt, directions.brand?.voice);
    const asset = contentService.saveAsset(req.auth.companyId, { leadId, type: 'graphic', provider, prompt, resultUrl: url, status: 'completed' });
    res.json(contentService.parseAsset(asset));
  } catch (err) { res.status(500).json({ error: err.message }); }
});

/** POST /api/content/video-ad  body: { prompt, leadId?, durationSeconds?, aspectRatio? } */
router.post('/video-ad', async (req, res) => {
  try {
    const { prompt, leadId, durationSeconds, aspectRatio } = req.body;
    if (!prompt) return res.status(400).json({ error: 'prompt is required' });
    const result = await videoGen.generateVideoAd(prompt, { durationSeconds, aspectRatio });
    const asset = contentService.saveAsset(req.auth.companyId, {
      leadId, type: 'video_ad', provider: result.provider, prompt,
      resultText: result.storyboard ? { storyboard: result.storyboard, note: result.note } : null,
      resultUrl: result.url, status: result.status === 'completed' ? 'completed' : 'generating'
    });
    res.json({ ...contentService.parseAsset(asset), jobId: result.jobId });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

/** GET /api/content/video-ad/:assetId/status - poll a real provider's async job */
router.get('/video-ad/:assetId/status', async (req, res) => {
  try {
    const asset = db.prepare('SELECT * FROM content_assets WHERE id = ? AND company_id = ?').get(req.params.assetId, req.auth.companyId);
    if (!asset) return res.status(404).json({ error: 'not found' });
    if (asset.status === 'completed' || !req.query.jobId) return res.json(contentService.parseAsset(asset));
    const status = await videoGen.pollVideoJob(req.query.jobId);
    if (status.url) db.prepare("UPDATE content_assets SET status = 'completed', result_url = ? WHERE id = ?").run(status.url, asset.id);
    res.json(contentService.parseAsset(db.prepare('SELECT * FROM content_assets WHERE id = ?').get(asset.id)));
  } catch (err) { res.status(500).json({ error: err.message }); }
});

module.exports = router;
