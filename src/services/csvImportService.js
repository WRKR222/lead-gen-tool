/**
 * CSV import: lets a company bring in leads it already has the right to
 * contact (a licensed data export, a trade-show badge-scan list, a
 * referral list, a CRM extract, a manually-compiled list from LinkedIn/
 * social media research done by a human). This is the "manual" source -
 * no dependency needed beyond a small RFC-4180-ish parser, so it works
 * offline with zero API keys.
 *
 * Expected header row (case-insensitive, order doesn't matter, unknown
 * columns are ignored): company_name, contact_name, title, email, phone,
 * linkedin_url, country, region, city, industry, company_size
 */
const REQUIRED = ['company_name'];
const KNOWN_COLUMNS = ['company_name', 'contact_name', 'title', 'email', 'phone', 'linkedin_url', 'country', 'region', 'city', 'industry', 'company_size'];

/** Minimal CSV line parser that handles quoted fields containing commas/newlines. */
function parseCsv(text) {
  const rows = [];
  let row = [], field = '', inQuotes = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i], next = text[i + 1];
    if (inQuotes) {
      if (c === '"' && next === '"') { field += '"'; i++; }
      else if (c === '"') { inQuotes = false; }
      else { field += c; }
    } else {
      if (c === '"') inQuotes = true;
      else if (c === ',') { row.push(field); field = ''; }
      else if (c === '\n' || c === '\r') {
        if (c === '\r' && next === '\n') i++;
        row.push(field); field = '';
        if (row.some(v => v !== '')) rows.push(row);
        row = [];
      } else field += c;
    }
  }
  if (field !== '' || row.length) { row.push(field); rows.push(row); }
  return rows;
}

/**
 * @param {string} csvText - raw CSV content
 * @returns {{ leads: object[], errors: string[] }}
 */
function parseLeadsCsv(csvText) {
  const rows = parseCsv(csvText.trim());
  if (rows.length < 2) return { leads: [], errors: ['CSV must have a header row plus at least one data row'] };

  const header = rows[0].map(h => h.trim().toLowerCase());
  const missing = REQUIRED.filter(r => !header.includes(r));
  if (missing.length) return { leads: [], errors: [`Missing required column(s): ${missing.join(', ')}`] };

  const leads = [];
  const errors = [];
  for (let i = 1; i < rows.length; i++) {
    const cells = rows[i];
    const obj = {};
    header.forEach((col, idx) => { if (KNOWN_COLUMNS.includes(col)) obj[col] = (cells[idx] || '').trim() || null; });
    if (!obj.company_name) { errors.push(`Row ${i + 1}: missing company_name, skipped`); continue; }
    leads.push({
      companyName: obj.company_name,
      contactName: obj.contact_name || null,
      title: obj.title || null,
      email: obj.email || null,
      phone: obj.phone || null,
      linkedinUrl: obj.linkedin_url || null,
      country: obj.country || null,
      region: obj.region || null,
      city: obj.city || null,
      industry: obj.industry || null,
      companySize: obj.company_size ? Number(obj.company_size) || null : null,
      source: 'csv_import'
    });
  }
  return { leads, errors };
}

// Header aliases for spreadsheets exported from scraping tools, Google
// sweeps, ad lead forms or CRMs (Excel or CSV, keyed by lower-cased header).
const LEAD_ALIASES = {
  companyName: ['company_name', 'company', 'business', 'business name', 'organisation', 'organization'],
  contactName: ['contact_name', 'contact', 'name', 'full name', 'full_name', 'owner', 'decision maker'],
  title: ['title', 'role', 'position', 'job title'],
  email: ['email', 'e-mail', 'email address'],
  phone: ['phone', 'mobile', 'tel', 'telephone', 'phone number'],
  website: ['website', 'site', 'url', 'web'],
  address: ['address', 'location', 'street', 'physical address'],
  city: ['city', 'town'],
  country: ['country', 'country code'],
  industry: ['industry', 'category', 'niche', 'sector'],
  companySize: ['company_size', 'employees', 'size', 'staff'],
  leadType: ['lead_type', 'type'],
  notes: ['notes', 'description', 'comment']
};
const SOCIAL_ALIASES = {
  whatsapp: ['whatsapp'], instagram: ['instagram', 'ig'], facebook: ['facebook', 'fb'], linkedin: ['linkedin', 'linkedin_url'],
  tiktok: ['tiktok'], x: ['x', 'twitter']
};

function first(row, keys) {
  for (const k of keys) if (row[k] != null && String(row[k]).trim() !== '') return String(row[k]).trim();
  return null;
}

/** Map one spreadsheet row to the lead shape leadsService.createLead expects. */
function mapLeadRow(row) {
  const lead = Object.fromEntries(Object.entries(LEAD_ALIASES).map(([k, keys]) => [k, first(row, keys)]));
  lead.companySize = lead.companySize ? Number(String(lead.companySize).replace(/[^\d]/g, '')) || null : null;
  lead.leadType = /person|individual|b2c|patient|consumer/i.test(lead.leadType || '') || (!lead.companyName && lead.contactName) ? 'person' : 'business';
  lead.socials = Object.fromEntries(Object.entries(SOCIAL_ALIASES).map(([k, keys]) => [k, first(row, keys)]).filter(([, v]) => v));
  return lead;
}

module.exports = { parseLeadsCsv, parseCsv, mapLeadRow, KNOWN_COLUMNS };
