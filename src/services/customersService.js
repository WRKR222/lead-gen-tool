/**
 * A workspace's customer base and its churn. Customers come from an
 * uploaded roster (Excel/CSV), manual entry, converted leads, or simply a
 * baseline count ("we have 240 customers") for businesses that don't list
 * them individually. Every loss is recorded with a reason (churn_events),
 * which is what churn rates and the AI loss-learning are computed from.
 *
 *   active now          = active listed customers + (baseline - count-only losses since the baseline)
 *   churn rate (month)  = customers lost in the month / customers active at the start of it
 */
const { v4: uuid } = require('uuid');
const { db } = require('../db/database');
const { excelSerialToIso } = require('./documentService');

const HEADER_MAP = {
  name: ['name', 'customer', 'customer_name', 'customer name', 'client', 'client name', 'company', 'company_name', 'full name', 'patient', 'patient name'],
  contact_name: ['contact', 'contact_name', 'contact name', 'contact person'],
  email: ['email', 'e-mail', 'email address'],
  phone: ['phone', 'mobile', 'tel', 'telephone', 'phone number', 'whatsapp'],
  tier: ['tier', 'package', 'service', 'product', 'plan', 'treatment'],
  total_value: ['value', 'total_value', 'total value', 'lifetime_value', 'lifetime value', 'amount', 'revenue', 'spend', 'total spend'],
  monthly_value: ['monthly', 'monthly_value', 'monthly value', 'mrr', 'monthly spend', 'retainer'],
  acquired_at: ['acquired_at', 'acquired', 'since', 'customer since', 'start_date', 'start date', 'date', 'joined', 'signup date', 'first purchase'],
  status: ['status', 'state', 'active'],
  lost_reason: ['lost_reason', 'lost reason', 'reason', 'churn reason', 'why lost'],
  customer_type: ['type', 'customer_type', 'customer type']
};

const LOST_WORDS = /^(lost|churned|inactive|former|cancel+ed|left|no|false|0)$/i;

function pickField(row, key) {
  for (const h of HEADER_MAP[key]) if (row[h] !== undefined && String(row[h]).trim() !== '') return String(row[h]).trim();
  return null;
}

function toIsoDate(v) {
  if (!v) return null;
  if (/^\d{4,5}(\.\d+)?$/.test(v)) { const n = Number(v); if (n > 20000 && n < 80000) return excelSerialToIso(n); }
  const d = new Date(v);
  return isNaN(d) ? null : d.toISOString().slice(0, 10);
}

function toNumber(v) {
  if (v == null) return null;
  const n = Number(String(v).replace(/[^0-9.\-]/g, ''));
  return Number.isFinite(n) ? n : null;
}

function create(companyId, data) {
  if (!data.name) throw new Error('name is required');
  const id = uuid();
  const status = data.status === 'lost' ? 'lost' : 'active';
  db.prepare(`INSERT INTO customers (id, company_id, name, contact_name, email, phone, customer_type, tier, total_value, monthly_value,
      acquired_at, source, lead_id, status, lost_at, lost_reason, lost_reason_category, notes)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
    .run(id, companyId, data.name, data.contactName || null, data.email || null, data.phone || null,
      data.customerType === 'person' ? 'person' : 'business', data.tier || null, toNumber(data.totalValue), toNumber(data.monthlyValue),
      toIsoDate(data.acquiredAt) || new Date().toISOString().slice(0, 10), data.source || 'manual', data.leadId || null,
      status, status === 'lost' ? (toIsoDate(data.lostAt) || new Date().toISOString().slice(0, 10)) : null,
      data.lostReason || null, data.lostReasonCategory || null, data.notes || null);
  if (status === 'lost') {
    recordChurn(companyId, { subjectKind: 'customer', customerId: id, reasonCategory: data.lostReasonCategory || 'other', reasonText: data.lostReason, occurredAt: toIsoDate(data.lostAt) });
  }
  return db.prepare('SELECT * FROM customers WHERE id = ?').get(id);
}

/** Import roster rows (already parsed from Excel/CSV, keyed by lower-cased header). */
function importRows(companyId, rows) {
  const imported = []; const errors = [];
  db.transaction(() => {
    rows.forEach((row, i) => {
      const name = pickField(row, 'name');
      if (!name) { errors.push(`Row ${i + 2}: no customer name column found, skipped`); return; }
      const statusRaw = pickField(row, 'status');
      imported.push(create(companyId, {
        name, contactName: pickField(row, 'contact_name'), email: pickField(row, 'email'), phone: pickField(row, 'phone'),
        tier: pickField(row, 'tier'), totalValue: pickField(row, 'total_value'), monthlyValue: pickField(row, 'monthly_value'),
        acquiredAt: pickField(row, 'acquired_at'), customerType: /person|individual|patient/i.test(pickField(row, 'customer_type') || '') ? 'person' : 'business',
        status: statusRaw && LOST_WORDS.test(statusRaw) ? 'lost' : 'active', lostReason: pickField(row, 'lost_reason'),
        lostReasonCategory: pickField(row, 'lost_reason') ? 'other' : null, source: 'import'
      }));
    });
  })();
  return { imported: imported.length, errors };
}

function recordChurn(companyId, { subjectKind, customerId, leadId, clientCompanyId, count = 1, reasonCategory, reasonText, occurredAt, recordedBy }) {
  const id = uuid();
  db.prepare(`INSERT INTO churn_events (id, company_id, subject_kind, customer_id, lead_id, client_company_id, count, reason_category, reason_text, occurred_at, recorded_by)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
    .run(id, companyId, subjectKind, customerId || null, leadId || null, clientCompanyId || null, Math.max(1, Number(count) || 1),
      reasonCategory || 'other', reasonText || null, occurredAt ? new Date(occurredAt).toISOString() : new Date().toISOString(), recordedBy || null);
  return id;
}

function markLost(companyId, customerId, { reasonCategory, reason, lostAt, userId }) {
  const c = db.prepare('SELECT * FROM customers WHERE id = ? AND company_id = ?').get(customerId, companyId);
  if (!c) return null;
  if (c.status === 'lost') return c;
  const lostDate = toIsoDate(lostAt) || new Date().toISOString().slice(0, 10);
  db.prepare("UPDATE customers SET status = 'lost', lost_at = ?, lost_reason_category = ?, lost_reason = ?, updated_at = datetime('now') WHERE id = ?")
    .run(lostDate, reasonCategory || 'other', reason || null, customerId);
  recordChurn(companyId, { subjectKind: 'customer', customerId, reasonCategory, reasonText: reason, occurredAt: lostDate, recordedBy: userId });
  return db.prepare('SELECT * FROM customers WHERE id = ?').get(customerId);
}

function reactivate(companyId, customerId) {
  db.prepare("UPDATE customers SET status = 'active', lost_at = NULL, updated_at = datetime('now') WHERE id = ? AND company_id = ?").run(customerId, companyId);
  db.prepare("DELETE FROM churn_events WHERE customer_id = ? AND company_id = ? AND subject_kind = 'customer'").run(customerId, companyId);
  return db.prepare('SELECT * FROM customers WHERE id = ?').get(customerId);
}

/** Losses from the baseline count (customers not listed by name). */
function recordCountLoss(companyId, { count, reasonCategory, reason, occurredAt, userId }) {
  if (!(Number(count) > 0)) throw new Error('count must be a positive number');
  return recordChurn(companyId, { subjectKind: 'customer', count, reasonCategory, reasonText: reason, occurredAt, recordedBy: userId });
}

function setBaseline(companyId, { count, date }) {
  db.prepare("UPDATE companies SET baseline_customer_count = ?, baseline_customer_date = ?, updated_at = datetime('now') WHERE id = ?")
    .run(Math.max(0, Number(count) || 0), toIsoDate(date) || new Date().toISOString().slice(0, 10), companyId);
}

function createFromLead(companyId, lead, { tier, totalValue } = {}) {
  const existing = lead.converted_customer_id && db.prepare('SELECT * FROM customers WHERE id = ?').get(lead.converted_customer_id);
  if (existing) return existing;
  const customer = create(companyId, {
    name: lead.company_name || lead.contact_name, contactName: lead.contact_name, email: lead.email, phone: lead.phone,
    customerType: lead.lead_type === 'person' ? 'person' : 'business', tier, totalValue, source: 'lead_conversion', leadId: lead.id
  });
  db.prepare('UPDATE leads SET converted_customer_id = ? WHERE id = ?').run(customer.id, lead.id);
  return customer;
}

function list(companyId, { status } = {}) {
  let q = 'SELECT * FROM customers WHERE company_id = ?';
  const params = [companyId];
  if (status) { q += ' AND status = ?'; params.push(status); }
  return db.prepare(q + ' ORDER BY status ASC, acquired_at DESC, created_at DESC').all(...params);
}

function monthStart(offsetMonths = 0) {
  const d = new Date();
  return new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + offsetMonths, 1));
}

/** Churn numbers for a workspace's customer base. */
function stats(companyId, { months = 6 } = {}) {
  const company = db.prepare('SELECT baseline_customer_count, baseline_customer_date FROM companies WHERE id = ?').get(companyId);
  const itemizedActive = db.prepare("SELECT COUNT(*) AS n FROM customers WHERE company_id = ? AND status = 'active'").get(companyId).n;
  const baseline = company.baseline_customer_count || 0;
  const countOnlyLost = baseline ? db.prepare(`SELECT COALESCE(SUM(count), 0) AS n FROM churn_events
      WHERE company_id = ? AND subject_kind = 'customer' AND customer_id IS NULL AND date(occurred_at) >= date(?)`).get(companyId, company.baseline_customer_date || '1970-01-01').n : 0;
  const totalActive = itemizedActive + Math.max(0, baseline - countOnlyLost);

  const lostBetween = db.prepare(`SELECT COALESCE(SUM(count), 0) AS n FROM churn_events
    WHERE company_id = ? AND subject_kind = 'customer' AND datetime(occurred_at) >= datetime(?) AND datetime(occurred_at) < datetime(?)`);
  const acquiredBetween = db.prepare(`SELECT COUNT(*) AS n FROM customers
    WHERE company_id = ? AND date(COALESCE(acquired_at, created_at)) >= date(?) AND date(COALESCE(acquired_at, created_at)) < date(?)`);
  const farFuture = '9999-12-31T00:00:00.000Z';

  const series = [];
  for (let i = months - 1; i >= 0; i--) {
    const start = monthStart(-i); const end = monthStart(-i + 1);
    const lost = lostBetween.get(companyId, start.toISOString(), end.toISOString()).n;
    const acquired = acquiredBetween.get(companyId, start.toISOString().slice(0, 10), end.toISOString().slice(0, 10)).n;
    const lostSinceStart = lostBetween.get(companyId, start.toISOString(), farFuture).n;
    const acquiredSinceStart = acquiredBetween.get(companyId, start.toISOString().slice(0, 10), '9999-12-31').n;
    const activeAtStart = totalActive + lostSinceStart - acquiredSinceStart;
    series.push({
      month: start.toISOString().slice(0, 7), lost, acquired, activeAtStart,
      churnRate: activeAtStart > 0 ? Math.round((lost / activeAtStart) * 1000) / 10 : null
    });
  }

  const reasons = db.prepare(`SELECT reason_category AS reason, SUM(count) AS n FROM churn_events
    WHERE company_id = ? AND subject_kind = 'customer' GROUP BY reason_category ORDER BY n DESC`).all(companyId);
  const value = db.prepare("SELECT COALESCE(SUM(total_value), 0) AS total, COALESCE(SUM(monthly_value), 0) AS monthly FROM customers WHERE company_id = ? AND status = 'active'").get(companyId);
  const current = series[series.length - 1];
  return {
    totalActive, itemizedActive, baseline, baselineDate: company.baseline_customer_date, unitemizedActive: totalActive - itemizedActive,
    lostThisMonth: current.lost, acquiredThisMonth: current.acquired, churnRateThisMonth: current.churnRate,
    series, reasons, activeCustomerValue: value.total, activeMonthlyValue: value.monthly
  };
}

module.exports = { create, importRows, markLost, reactivate, recordCountLoss, recordChurn, setBaseline, createFromLead, list, stats, toIsoDate };
