/**
 * Lead and sales analytics for a workspace, and agency-wide analytics
 * across clients (client churn, retainer revenue, results delivered).
 *
 * Timestamps in this schema are a mix of SQLite `datetime('now')` and JS
 * ISO strings, so range comparisons go through julianday(), which parses
 * both and (unlike datetime()) keeps sub-second precision.
 */
const { db } = require('../db/database');
const customers = require('./customersService');
const cadence = require('./cadenceService');
const { safeParse } = require('./directionsService');
const { OUTREACH_METHODS, LEAD_STATUSES, MEETING_STANDARDS } = require('../config/playbook');

const DAY = 86400000;
const RESPONDED = ['replied', 'interested', 'meeting_booked', 'converted', 'on_fence', 'said_no', 'callback_requested'];
const POSITIVE = ['replied', 'interested', 'meeting_booked', 'converted', 'callback_requested'];
const q = (list) => list.map(v => `'${v}'`).join(',');

function range(days, end = new Date()) {
  return { from: new Date(end.getTime() - days * DAY).toISOString(), to: end.toISOString(), days };
}

function count(sql, ...params) { return db.prepare(sql).get(...params).n; }

function pct(num, den) { return den ? Math.round((num / den) * 1000) / 10 : null; }

/** Funnel + outreach numbers for any time window. */
function metricsBetween(companyId, from, to) {
  const inRange = (col) => `julianday(${col}) >= julianday(?) AND julianday(${col}) < julianday(?)`;
  const generated = count(`SELECT COUNT(*) AS n FROM leads WHERE company_id = ? AND ${inRange('created_at')}`, companyId, from, to);
  const contacted = count(`SELECT COUNT(DISTINCT lead_id) AS n FROM outreach_attempts WHERE company_id = ? AND direction = 'outbound' AND ${inRange('occurred_at')}`, companyId, from, to);
  const replied = count(`SELECT COUNT(DISTINCT lead_id) AS n FROM (
      SELECT lead_id FROM outreach_attempts WHERE company_id = ? AND result IN (${q(RESPONDED)}) AND ${inRange('occurred_at')}
      UNION SELECT lead_id FROM email_messages WHERE company_id = ? AND direction = 'inbound' AND lead_id IS NOT NULL AND ${inRange('received_at')})`,
  companyId, from, to, companyId, from, to);
  const meetings = count(`SELECT COUNT(DISTINCT lead_id) AS n FROM (
      SELECT lead_id FROM meetings WHERE company_id = ? AND lead_id IS NOT NULL AND ${inRange('created_at')}
      UNION SELECT lead_id FROM outreach_attempts WHERE company_id = ? AND result = 'meeting_booked' AND ${inRange('occurred_at')})`,
  companyId, from, to, companyId, from, to);
  const converted = count(`SELECT COUNT(*) AS n FROM leads WHERE company_id = ? AND status = 'closed_won' AND converted_at IS NOT NULL AND ${inRange('converted_at')}`, companyId, from, to);
  const saidNo = count(`SELECT COUNT(*) AS n FROM churn_events WHERE company_id = ? AND subject_kind = 'lead' AND ${inRange('occurred_at')}`, companyId, from, to);
  const attempts = count(`SELECT COUNT(*) AS n FROM outreach_attempts WHERE company_id = ? AND direction = 'outbound' AND ${inRange('occurred_at')}`, companyId, from, to);
  const emailsSent = count(`SELECT COUNT(*) AS n FROM email_messages WHERE company_id = ? AND direction = 'outbound' AND status = 'sent' AND ${inRange('sent_at')}`, companyId, from, to);
  const emailReplies = count(`SELECT COUNT(*) AS n FROM email_messages WHERE company_id = ? AND direction = 'inbound' AND ${inRange('received_at')}`, companyId, from, to);
  const wonValue = db.prepare(`SELECT COALESCE(SUM(estimated_value), 0) AS v FROM leads WHERE company_id = ? AND status = 'closed_won' AND converted_at IS NOT NULL AND ${inRange('converted_at')}`).get(companyId, from, to).v;
  return { generated, contacted, replied, meetings, converted, saidNo, attempts, emailsSent, emailReplies, wonValue };
}

function methodStats(companyId, from, to) {
  const rows = db.prepare(`SELECT method, COUNT(*) AS attempts, COUNT(DISTINCT lead_id) AS leads,
      SUM(CASE WHEN result IN (${q(POSITIVE)}) THEN 1 ELSE 0 END) AS positive,
      SUM(CASE WHEN result = 'meeting_booked' THEN 1 ELSE 0 END) AS meetings,
      SUM(CASE WHEN result = 'converted' THEN 1 ELSE 0 END) AS conversions,
      SUM(CASE WHEN spoke_to_decision_maker = 1 THEN 1 ELSE 0 END) AS decision_maker
    FROM outreach_attempts WHERE company_id = ? AND direction = 'outbound' AND julianday(occurred_at) >= julianday(?) AND julianday(occurred_at) < julianday(?)
    GROUP BY method`).all(companyId, from, to);
  return OUTREACH_METHODS.map(m => {
    const r = rows.find(x => x.method === m.key) || { attempts: 0, leads: 0, positive: 0, meetings: 0, conversions: 0, decision_maker: 0 };
    return { method: m.key, label: m.label, rank: m.rank, attempts: r.attempts, leads: r.leads, positive: r.positive, meetings: r.meetings,
      conversions: r.conversions, successRate: pct(r.positive, r.attempts), meetingRate: pct(r.meetings, r.attempts), decisionMakerRate: pct(r.decision_maker, r.attempts) };
  });
}

/** How often reps confirmed each meeting-setting standard when logging attempts. */
function standardsAdherence(companyId, from, to) {
  const rows = db.prepare(`SELECT standards_json FROM outreach_attempts WHERE company_id = ? AND direction = 'outbound' AND automated = 0
    AND standards_json IS NOT NULL AND julianday(occurred_at) >= julianday(?) AND julianday(occurred_at) < julianday(?)`).all(companyId, from, to);
  return {
    logged: rows.length,
    standards: MEETING_STANDARDS.map(s => ({
      key: s.key, label: s.label,
      rate: pct(rows.filter(r => safeParse(r.standards_json)[s.key] === true).length, rows.length)
    }))
  };
}

function workspaceOverview(companyId, { days = 30 } = {}) {
  const { from, to } = range(days);
  const company = db.prepare('SELECT kind, currency, value_pyramid_json FROM companies WHERE id = ?').get(companyId);
  const pyramid = safeParse(company.value_pyramid_json);
  const m = metricsBetween(companyId, from, to);
  const byStatus = Object.fromEntries(db.prepare('SELECT status, COUNT(*) AS n FROM leads WHERE company_id = ? GROUP BY status').all(companyId).map(r => [r.status, r.n]));
  const total = Object.values(byStatus).reduce((s, n) => s + n, 0);
  const open = db.prepare(`SELECT COALESCE(SUM(estimated_value), 0) AS v FROM leads WHERE company_id = ? AND status NOT IN ('closed_won','closed_lost','bounced','unsubscribed','spam')`).get(companyId).v;
  const lossReasons = db.prepare(`SELECT reason_category AS reason, SUM(count) AS n FROM churn_events WHERE company_id = ? AND subject_kind = 'lead' GROUP BY reason_category ORDER BY n DESC`).all(companyId);
  const outcomes = ['closed_won', 'on_fence', 'closed_lost', 'no_response'].map(k => ({ key: k, label: LEAD_STATUSES.find(s => s.key === k).label, n: byStatus[k] || 0 }));
  return {
    kind: company.kind,
    period: { from, to, days },
    leads: { total, byStatus, outcomes, byType: Object.fromEntries(db.prepare('SELECT lead_type, COUNT(*) AS n FROM leads WHERE company_id = ? GROUP BY lead_type').all(companyId).map(r => [r.lead_type || 'business', r.n])) },
    funnel: [
      { key: 'generated', label: 'Leads generated', n: m.generated },
      { key: 'contacted', label: 'Contacted', n: m.contacted },
      { key: 'replied', label: 'Responded', n: m.replied },
      { key: 'meetings', label: 'Meetings booked', n: m.meetings },
      { key: 'converted', label: 'Converted', n: m.converted }
    ],
    rates: { contactRate: pct(m.contacted, m.generated), responseRate: pct(m.replied, m.contacted), meetingRate: pct(m.meetings, m.contacted), winRate: pct(m.converted, m.meetings || m.contacted) },
    activity: { attempts: m.attempts, emailsSent: m.emailsSent, emailReplies: m.emailReplies, emailReplyRate: pct(m.emailReplies, m.emailsSent), saidNo: m.saidNo },
    methods: methodStats(companyId, from, to),
    standards: standardsAdherence(companyId, from, to),
    value: { currency: company.currency, valuePerLead: pyramid.valuePerLead ?? null, valuePerCustomer: pyramid.valuePerCustomer ?? null, pipelineValue: open, wonValue: m.wonValue },
    customers: customers.stats(companyId),
    followUpsDue: cadence.dueQueue(companyId, { limit: 500 }).length,
    lossReasons
  };
}

function bucketStart(d, granularity) {
  return granularity === 'month' ? new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), 1)) : new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()));
}

function addBucket(d, granularity, n) {
  return granularity === 'month' ? new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + n, 1)) : new Date(d.getTime() + n * DAY);
}

/** Per-day or per-month series of the funnel numbers. */
function timeseries(companyId, { granularity = 'day', points } = {}) {
  const g = granularity === 'month' ? 'month' : 'day';
  const n = Math.min(Number(points) || (g === 'month' ? 6 : 30), g === 'month' ? 24 : 90);
  const last = bucketStart(new Date(), g);
  const out = [];
  for (let i = n - 1; i >= 0; i--) {
    const start = addBucket(last, g, -i); const end = addBucket(start, g, 1);
    const m = metricsBetween(companyId, start.toISOString(), end.toISOString());
    out.push({ bucket: g === 'month' ? start.toISOString().slice(0, 7) : start.toISOString().slice(0, 10), ...m });
  }
  return { granularity: g, series: out };
}

/** Numbers for one day or month compared with the previous one. */
function periodMetrics(companyId, period = 'month', dateStr) {
  const g = period === 'day' ? 'day' : 'month';
  const anchor = dateStr ? new Date(dateStr) : new Date();
  const start = bucketStart(isNaN(anchor) ? new Date() : anchor, g);
  const end = addBucket(start, g, 1); const prevStart = addBucket(start, g, -1);
  const current = metricsBetween(companyId, start.toISOString(), end.toISOString());
  const previous = metricsBetween(companyId, prevStart.toISOString(), start.toISOString());
  const deltas = Object.fromEntries(Object.keys(current).map(k => [k, current[k] - previous[k]]));
  return { period: g, key: g === 'month' ? start.toISOString().slice(0, 7) : start.toISOString().slice(0, 10), from: start.toISOString(), to: end.toISOString(), current, previous, deltas, methods: methodStats(companyId, start.toISOString(), end.toISOString()) };
}

function monthStart(offset) {
  const d = new Date();
  return new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + offset, 1));
}

/** Agency-wide: clients, retainer revenue, client churn, results delivered, and the 3 stages. */
function agencyOverview(agencyId, { days = 30 } = {}) {
  const { from, to } = range(days);
  const agency = db.prepare('SELECT currency FROM companies WHERE id = ?').get(agencyId);
  const clients = db.prepare("SELECT id, name, client_status, monthly_retainer, client_since, churned_at, currency FROM companies WHERE agency_id = ? AND kind = 'client'").all(agencyId);
  const live = clients.filter(c => c.client_status !== 'churned');
  const byStatus = clients.reduce((acc, c) => { acc[c.client_status || 'active'] = (acc[c.client_status || 'active'] || 0) + 1; return acc; }, {});
  const mrr = live.reduce((s, c) => s + (c.monthly_retainer || 0), 0);

  const churnSeries = [];
  for (let i = 5; i >= 0; i--) {
    const start = monthStart(-i); const end = monthStart(-i + 1);
    const activeAtStart = clients.filter(c => (c.client_since || '0000') < start.toISOString().slice(0, 10) && (!c.churned_at || c.churned_at >= start.toISOString())).length;
    const lost = clients.filter(c => c.churned_at && c.churned_at >= start.toISOString() && c.churned_at < end.toISOString()).length;
    const signed = clients.filter(c => c.client_since && c.client_since >= start.toISOString().slice(0, 10) && c.client_since < end.toISOString().slice(0, 10)).length;
    churnSeries.push({ month: start.toISOString().slice(0, 7), activeAtStart, signed, lost, churnRate: pct(lost, activeAtStart) });
  }
  const churnReasons = db.prepare("SELECT reason_category AS reason, COUNT(*) AS n FROM churn_events WHERE company_id = ? AND subject_kind = 'client' GROUP BY reason_category ORDER BY n DESC").all(agencyId);

  const delivered = live.map(c => {
    const m = metricsBetween(c.id, from, to);
    return { clientId: c.id, name: c.name, status: c.client_status, currency: c.currency, leads: m.generated, contacted: m.contacted, meetings: m.meetings, conversions: m.converted, valueWon: m.wonValue };
  });
  const own = metricsBetween(agencyId, from, to);
  const onFence = count("SELECT COUNT(*) AS n FROM leads WHERE company_id = ? AND status = 'on_fence'", agencyId);
  const prospects = count("SELECT COUNT(*) AS n FROM leads WHERE company_id = ? AND status IN ('new','contacted','replied','no_response')", agencyId);
  return {
    period: { from, to, days },
    currency: agency.currency,
    clients: { total: clients.length, active: live.length, byStatus, mrr, churnRateThisMonth: churnSeries[churnSeries.length - 1].churnRate, churnSeries, churnReasons },
    delivered: {
      totals: delivered.reduce((t, d) => ({ leads: t.leads + d.leads, meetings: t.meetings + d.meetings, conversions: t.conversions + d.conversions }), { leads: 0, meetings: 0, conversions: 0 }),
      perClient: delivered
    },
    stages: [
      { key: 'find_clients', label: 'Find clients', n: prospects, detail: `${own.generated} new prospects, ${own.contacted} contacted (last ${days} days)` },
      { key: 'sign_clients', label: 'Sign clients', n: own.meetings + onFence, detail: `${own.meetings} meetings booked, ${onFence} on the fence` },
      { key: 'get_results', label: 'Get results', n: live.length, detail: `${live.length} live clients, ${mrr.toLocaleString()} ${agency.currency} monthly retainers` }
    ],
    prospecting: { ...own, rates: { responseRate: pct(own.replied, own.contacted), meetingRate: pct(own.meetings, own.contacted) } }
  };
}

module.exports = { workspaceOverview, timeseries, periodMetrics, agencyOverview, metricsBetween, methodStats };
