/**
 * Learning from losses, and period summaries.
 *
 * Every lost customer, every lead that said no, and every client the
 * agency lost is stored with a reason. This service turns those reasons
 * (plus which outreach methods are and aren't working) into concrete
 * recommendations, and the top reasons are fed back into CPS meeting
 * briefs so reps pre-empt the objections that actually cost deals.
 */
const { v4: uuid } = require('uuid');
const { db } = require('../db/database');
const llm = require('./llm');
const analytics = require('./analyticsService');
const { LOSS_REASONS } = require('../config/playbook');

const PLAYBOOK_FIXES = {
  price: 'Anchor on value before price: quantify what their problem costs per month in the Identify stage, then lead with the entry tier of the value pyramid.',
  timing: 'Keep "bad timing" leads in the nurture cadence and log the month they said to come back; book a check-in rather than closing the door.',
  no_need: 'Dig deeper in Identify: ask about revenue goals and the gap to them - "no need" usually means the pain was never made visible.',
  competitor: 'Ask what they chose and why; build a comparison talk track and use scarcity (one business per area) earlier.',
  trust: 'Bring proof earlier: a short case study, reviews, or a free-value offer before asking for commitment.',
  results: 'Set clear targets at kick-off and report weekly; flag at-risk clients from the health score before they decide to leave.',
  service_quality: 'Review the delivery checklist and response times; assign one owner per client.',
  communication: 'Tighten follow-up: reply to every lead within 4 hours and let the cadence engine handle non-responders.',
  moved_or_closed: 'Clean the data: verify contacts before outreach and remove closed businesses.',
  other: 'Capture a specific reason every time - "other" hides the pattern.'
};

function label(key) { return (LOSS_REASONS.find(r => r.key === key) || { label: key }).label; }

function gatherLosses(companyId) {
  const kinds = db.prepare(`SELECT subject_kind, reason_category, SUM(count) AS n FROM churn_events WHERE company_id = ?
    GROUP BY subject_kind, reason_category ORDER BY n DESC`).all(companyId);
  const texts = db.prepare(`SELECT subject_kind, reason_category, reason_text FROM churn_events WHERE company_id = ? AND reason_text IS NOT NULL
    ORDER BY occurred_at DESC LIMIT 60`).all(companyId);
  return { kinds, texts };
}

/** Top loss reasons as readable labels - fed into meeting briefs. */
function topLossReasons(companyId, limit = 4) {
  return db.prepare(`SELECT reason_category, SUM(count) AS n FROM churn_events WHERE company_id = ? GROUP BY reason_category ORDER BY n DESC LIMIT ?`)
    .all(companyId, limit).map(r => label(r.reason_category));
}

function fallbackLearning(losses, overview) {
  const totals = {};
  for (const k of losses.kinds) totals[k.reason_category] = (totals[k.reason_category] || 0) + k.n;
  const all = Object.values(totals).reduce((s, n) => s + n, 0);
  const top = Object.entries(totals).sort((a, b) => b[1] - a[1]).slice(0, 5)
    .map(([reason, n]) => ({ reason, label: label(reason), count: n, share: all ? Math.round((n / all) * 100) : 0 }));
  const methods = overview.methods.filter(m => m.attempts >= 3).sort((a, b) => (b.successRate || 0) - (a.successRate || 0));
  const recommendations = top.map(t => ({ title: `Address "${t.label}" (${t.share}% of losses)`, detail: PLAYBOOK_FIXES[t.reason] || PLAYBOOK_FIXES.other, appliesTo: ['results', 'service_quality', 'communication'].includes(t.reason) ? 'retention' : 'sales' }));
  if (methods.length >= 2) {
    recommendations.push({ title: `Lean on ${methods[0].label.toLowerCase()}`, detail: `${methods[0].label} converts ${methods[0].successRate}% of attempts into a positive response vs ${methods[methods.length - 1].successRate}% for ${methods[methods.length - 1].label.toLowerCase()}. Shift effort accordingly.`, appliesTo: 'outreach' });
  }
  const weakStandard = (overview.standards.standards || []).filter(s => s.rate != null).sort((a, b) => a.rate - b.rate)[0];
  if (weakStandard && weakStandard.rate < 80) {
    recommendations.push({ title: `Coach the team on "${weakStandard.label}"`, detail: `Only ${weakStandard.rate}% of logged attempts confirmed it.`, appliesTo: 'outreach' });
  }
  return {
    summary: all ? `${all} losses recorded. The biggest driver is "${top[0].label}" (${top[0].share}%).` : 'No losses recorded yet - log a reason every time a lead says no or a customer leaves, and recommendations will appear here.',
    topReasons: top, recommendations, _generatedBy: 'local_rules'
  };
}

async function churnLearning(companyId) {
  const losses = gatherLosses(companyId);
  const overview = analytics.workspaceOverview(companyId, { days: 90 });
  let content = fallbackLearning(losses, overview);
  if (llm.enabled() && losses.kinds.length) {
    try {
      const out = await llm.completeJson({
        system: 'You analyse why a business loses leads, customers and clients, and recommend specific fixes to its sales process, offer and retention. Return ONLY valid JSON, no markdown.',
        user: `LOSS COUNTS (subject_kind: lead = prospect said no, customer = customer lost, client = agency lost a client): ${JSON.stringify(losses.kinds)}
LOSS NOTES (most recent): ${JSON.stringify(losses.texts)}
OUTREACH METHOD RESULTS (last 90 days): ${JSON.stringify(overview.methods)}
MEETING-SETTING STANDARDS ADHERENCE: ${JSON.stringify(overview.standards)}
FUNNEL: ${JSON.stringify(overview.funnel)}
SHAPE: {"summary":"2 sentences","topReasons":[{"reason":"category key","label":"","count":0,"share":0}],"patterns":[""],"recommendations":[{"title":"","detail":"","appliesTo":"sales|outreach|offer|retention"}],"scriptTweaks":[""]}`,
        effort: 'medium', maxTokens: 10000
      });
      content = { ...llm.withFallback(out, content), _generatedBy: 'anthropic:' + llm.MODEL };
    } catch (err) {
      console.warn(`[insightsService] AI learning failed (${err.message}), using rules.`);
    }
  }
  const id = uuid();
  db.prepare('INSERT INTO ai_insights (id, company_id, kind, content_json, generated_by) VALUES (?, ?, ?, ?, ?)')
    .run(id, companyId, 'churn_learning', JSON.stringify(content), content._generatedBy);
  return { id, createdAt: new Date().toISOString(), ...content };
}

function latest(companyId, kind, periodKey) {
  const row = db.prepare(`SELECT * FROM ai_insights WHERE company_id = ? AND kind = ? ${periodKey ? 'AND period_key = ?' : ''} ORDER BY created_at DESC LIMIT 1`)
    .get(...[companyId, kind, periodKey].filter(v => v !== undefined));
  return row ? { id: row.id, createdAt: row.created_at, ...JSON.parse(row.content_json) } : null;
}

function describe(n, word) { return `${n} ${word}${n === 1 ? '' : 's'}`; }

function fallbackNarrative(pm) {
  const c = pm.current; const d = pm.deltas;
  const trend = (k) => (d[k] > 0 ? `up ${d[k]}` : d[k] < 0 ? `down ${Math.abs(d[k])}` : 'flat');
  const best = pm.methods.filter(m => m.attempts).sort((a, b) => (b.successRate || 0) - (a.successRate || 0))[0];
  const highlights = [
    `${describe(c.generated, 'new lead')} (${trend('generated')} vs previous ${pm.period})`,
    `${describe(c.attempts, 'contact attempt')}, ${describe(c.replied, 'lead')} responded`,
    `${describe(c.meetings, 'meeting')} booked (${trend('meetings')}), ${c.converted} converted`
  ];
  if (best) highlights.push(`Best method: ${best.label} (${best.successRate}% positive)`);
  const recommendations = [];
  if (c.generated && !c.attempts) recommendations.push('New leads are not being contacted - work the lead list with door-to-door and calls first.');
  if (c.attempts && !c.replied) recommendations.push('No responses yet - check you are reaching decision makers and leading with a specific hook.');
  if (c.meetings && !c.converted) recommendations.push('Meetings are not converting - review the CPS brief: let them ask the price, then stay silent.');
  if (d.generated < 0) recommendations.push('Lead volume dropped - schedule another discovery sweep or increase ad spend on the one platform.');
  if (!recommendations.length) recommendations.push('Keep the cadence running and log every outcome so the scorer keeps learning.');
  return { narrative: highlights.join('. ') + '.', highlights, recommendations, _generatedBy: 'local_template' };
}

/** Daily or monthly performance summary (cached per period; `refresh` regenerates). */
async function periodSummary(companyId, { period = 'month', date, refresh = false } = {}) {
  const pm = analytics.periodMetrics(companyId, period, date);
  if (!refresh) {
    const cached = latest(companyId, 'period_summary', `${pm.period}:${pm.key}`);
    const periodClosed = new Date(pm.to) < new Date();
    const ageMs = cached ? Date.now() - new Date(String(cached.createdAt).replace(' ', 'T') + 'Z').getTime() : Infinity;
    if (cached && (periodClosed || ageMs < 3600000)) return { ...pm, ...cached };
  }
  let text = fallbackNarrative(pm);
  if (llm.enabled()) {
    try {
      const out = await llm.completeJson({
        system: 'You write a short performance summary for a business owner about their lead generation and sales. Plain language, specific numbers, no fluff. Return ONLY valid JSON, no markdown.',
        user: `PERIOD: ${pm.period} ${pm.key}\nTHIS PERIOD: ${JSON.stringify(pm.current)}\nPREVIOUS PERIOD: ${JSON.stringify(pm.previous)}\nMETHODS: ${JSON.stringify(pm.methods)}\nSHAPE: {"narrative":"3-4 sentences","highlights":["",""],"recommendations":["",""]}`,
        effort: 'low', maxTokens: 6000
      });
      text = { ...llm.withFallback(out, text), _generatedBy: 'anthropic:' + llm.MODEL };
    } catch (err) {
      console.warn(`[insightsService] AI summary failed (${err.message}), using template.`);
    }
  }
  db.prepare('INSERT INTO ai_insights (id, company_id, kind, period_key, content_json, generated_by) VALUES (?, ?, ?, ?, ?, ?)')
    .run(uuid(), companyId, 'period_summary', `${pm.period}:${pm.key}`, JSON.stringify(text), text._generatedBy);
  return { ...pm, ...text, createdAt: new Date().toISOString() };
}

module.exports = { churnLearning, topLossReasons, latest, periodSummary };
