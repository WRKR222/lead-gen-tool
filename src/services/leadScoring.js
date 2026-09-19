/**
 * Self-improving lead scorer - one model PER COMPANY.
 *
 * Implements online logistic regression: a lightweight model that scores
 * each lead 0-1 (likelihood of converting), and updates its own weights
 * every time a feedback event comes in (reply, meeting booked, closed
 * won/lost, bounce, unsubscribe, spam complaint). No external ML
 * infra required - weights persist in the `model_weights` table, keyed by
 * company_id so every tenant's scorer learns only from ITS OWN outcomes -
 * but the same feature vector can be swapped into a real ML/AI service
 * later without touching the rest of the app.
 *
 * Positive events (see directions.json `scoring.conversionEvents`) push
 * weights up for the features that lead had; negative events push them
 * down. Over time the model learns which industries, titles, company
 * sizes, and geo tiers actually convert for THIS company.
 */
const { db } = require('../db/database');

const DEFAULT_FEATURES = [
  'bias', 'industry_match', 'title_seniority', 'size_in_range',
  'geo_tier_1', 'geo_tier_2', 'geo_tier_3', 'keyword_match', 'has_phone', 'has_email'
];

function sigmoid(z) {
  return 1 / (1 + Math.exp(-z));
}

function loadWeights(companyId) {
  const row = db.prepare('SELECT * FROM model_weights WHERE company_id = ?').get(companyId);
  if (row && row.weights_json && row.weights_json !== '{}') return { weights: JSON.parse(row.weights_json), samplesSeen: row.samples_seen };
  const initial = Object.fromEntries(DEFAULT_FEATURES.map(f => [f, f === 'bias' ? -1 : 0.1]));
  db.prepare(`
    INSERT INTO model_weights (company_id, weights_json, samples_seen) VALUES (?, ?, 0)
    ON CONFLICT(company_id) DO UPDATE SET weights_json = excluded.weights_json
  `).run(companyId, JSON.stringify(initial));
  return { weights: initial, samplesSeen: 0 };
}

function saveWeights(companyId, weights, samplesSeen) {
  db.prepare('UPDATE model_weights SET weights_json = ?, samples_seen = ?, updated_at = datetime(\'now\') WHERE company_id = ?')
    .run(JSON.stringify(weights), samplesSeen, companyId);
}

/**
 * Build the feature vector for a lead against the current directions/ICP.
 */
function featuresFor(lead, directions) {
  const icp = directions.idealCustomerProfile;
  const industryMatch = lead.industry && icp.industries.some(i =>
    lead.industry.toLowerCase().includes(i.toLowerCase())) ? 1 : 0;

  const seniorityKey = classifySeniority(lead.title);
  const titleSeniority = icp.titleSeniorityWeight[seniorityKey] ?? 0.2;

  const sizeInRange = lead.companySize != null &&
    lead.companySize >= icp.companySizeMin &&
    lead.companySize <= icp.companySizeMax ? 1 : 0;

  const keywordMatch = icp.keywords.length > 0 && lead.companyName
    ? icp.keywords.some(k => (lead.companyName + ' ' + (lead.industry || '')).toLowerCase().includes(k.toLowerCase())) ? 1 : 0
    : 0.5; // neutral if no keywords configured

  return {
    bias: 1,
    industry_match: industryMatch,
    title_seniority: titleSeniority,
    size_in_range: sizeInRange,
    geo_tier_1: lead.geoTier === 1 ? 1 : 0,
    geo_tier_2: lead.geoTier === 2 ? 1 : 0,
    geo_tier_3: lead.geoTier === 3 ? 1 : 0,
    keyword_match: keywordMatch,
    has_phone: lead.phone ? 1 : 0,
    has_email: lead.email ? 1 : 0
  };
}

function classifySeniority(title) {
  if (!title) return 'other';
  const t = title.toLowerCase();
  if (/\b(ceo|founder|owner|president|cfo|coo|chief)\b/.test(t)) return 'c_level';
  if (/\bvp|vice president\b/.test(t)) return 'vp';
  if (/\bdirector|head of\b/.test(t)) return 'director';
  if (/\bmanager\b/.test(t)) return 'manager';
  return 'other';
}

/** Score a single lead 0-1 for a given company's model. */
function scoreLead(lead, directions, companyId) {
  const { weights } = loadWeights(companyId);
  const features = featuresFor(lead, directions);
  const z = DEFAULT_FEATURES.reduce((sum, f) => sum + (weights[f] || 0) * (features[f] || 0), 0);
  return sigmoid(z);
}

/**
 * Update a company's model from a feedback event. label = 1 for positive
 * conversion events, 0 for negative events (bounced/unsubscribed/spam/lost).
 */
function updateFromFeedback(lead, directions, label, companyId) {
  const { weights, samplesSeen } = loadWeights(companyId);
  const features = featuresFor(lead, directions);
  const lr = directions.scoring.learningRate || 0.05;

  const z = DEFAULT_FEATURES.reduce((sum, f) => sum + (weights[f] || 0) * (features[f] || 0), 0);
  const prediction = sigmoid(z);
  const error = label - prediction;

  const newWeights = { ...weights };
  for (const f of DEFAULT_FEATURES) {
    newWeights[f] = (weights[f] || 0) + lr * error * (features[f] || 0);
  }

  saveWeights(companyId, newWeights, samplesSeen + 1);
  return { newScore: sigmoid(DEFAULT_FEATURES.reduce((s, f) => s + newWeights[f] * (features[f] || 0), 0)), samplesSeen: samplesSeen + 1 };
}

const POSITIVE_DEFAULT = new Set(['replied', 'meeting_booked', 'opportunity_created', 'closed_won']);
const NEGATIVE_DEFAULT = new Set(['bounced', 'unsubscribed', 'marked_spam', 'closed_lost']);

function labelForEvent(eventType, directions) {
  const positives = new Set(directions.scoring.conversionEvents || Array.from(POSITIVE_DEFAULT));
  const negatives = new Set(directions.scoring.negativeEvents || Array.from(NEGATIVE_DEFAULT));
  if (positives.has(eventType)) return 1;
  if (negatives.has(eventType)) return 0;
  return null; // neutral event, no learning signal
}

module.exports = { scoreLead, updateFromFeedback, labelForEvent, featuresFor, loadWeights };
