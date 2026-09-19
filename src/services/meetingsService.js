/**
 * Meeting scheduling. Always generates a real, standards-based .ics
 * calendar invite (works with zero API keys/cost - RFC 5545, opens in
 * Gmail/Outlook/Apple Calendar/etc.). Optionally also pushes the meeting
 * to a real calendar provider when credentials are configured, so the
 * feature is genuinely useful out of the box and upgrades cleanly.
 *
 * BEFORE GOING LIVE with a real calendar provider: Google Calendar and
 * Microsoft Graph (Outlook) both require OAuth2 user consent, not just an
 * API key - wire that flow up in googleCalendarSync()/outlookCalendarSync()
 * below once you have a client id/secret and a redirect flow. Both are
 * left as clearly-marked stubs so the rest of the app (and the AI
 * assistant's `scheduleMeeting` tool) doesn't need to change when you do.
 */
const { v4: uuid } = require('uuid');
const { db } = require('../db/database');

function pad(n) { return String(n).padStart(2, '0'); }
function toIcsDate(iso) {
  const d = new Date(iso);
  return `${d.getUTCFullYear()}${pad(d.getUTCMonth() + 1)}${pad(d.getUTCDate())}T${pad(d.getUTCHours())}${pad(d.getUTCMinutes())}${pad(d.getUTCSeconds())}Z`;
}

function buildIcs({ uid, title, description, startAt, endAt, location }) {
  const lines = [
    'BEGIN:VCALENDAR', 'VERSION:2.0', 'PRODID:-//LeadGen Platform//EN', 'CALSCALE:GREGORIAN', 'METHOD:PUBLISH',
    'BEGIN:VEVENT',
    `UID:${uid}`,
    `DTSTAMP:${toIcsDate(new Date().toISOString())}`,
    `DTSTART:${toIcsDate(startAt)}`,
    `DTEND:${toIcsDate(endAt)}`,
    `SUMMARY:${escapeIcs(title)}`,
    description ? `DESCRIPTION:${escapeIcs(description)}` : null,
    location ? `LOCATION:${escapeIcs(location)}` : null,
    'END:VEVENT', 'END:VCALENDAR'
  ].filter(Boolean);
  return lines.join('\r\n');
}

function escapeIcs(s) {
  return String(s).replace(/[\\,;]/g, m => '\\' + m).replace(/\n/g, '\\n');
}

/** Stub - wire up real Google Calendar OAuth2 + Calendar API v3 insert here. */
async function googleCalendarSync(/* meeting */) {
  if (!process.env.GOOGLE_CALENDAR_CLIENT_ID) return null;
  console.warn('[meetingsService] GOOGLE_CALENDAR_CLIENT_ID is set but OAuth2 flow is not implemented yet - add it here, then return the created event id.');
  return null;
}

/**
 * @param {string} companyId
 * @param {object} input - { leadId?, title, description?, startAt, endAt, locationOrLink?, createdBy? }
 */
async function scheduleMeeting(companyId, input) {
  if (!input.title || !input.startAt || !input.endAt) throw new Error('title, startAt and endAt are required');
  const id = uuid();
  const icsUid = `${id}@leadgen-platform`;
  db.prepare(`
    INSERT INTO meetings (id, company_id, lead_id, title, description, start_at, end_at, location_or_link, ics_uid, created_by)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(id, companyId, input.leadId || null, input.title, input.description || null, input.startAt, input.endAt,
    input.locationOrLink || null, icsUid, input.createdBy || 'user');

  const externalId = await googleCalendarSync({ id, ...input }).catch(() => null);
  if (externalId) db.prepare('UPDATE meetings SET external_calendar_id = ? WHERE id = ?').run(externalId, id);

  const meeting = db.prepare('SELECT * FROM meetings WHERE id = ?').get(id);
  const ics = buildIcs({ uid: icsUid, title: meeting.title, description: meeting.description, startAt: meeting.start_at, endAt: meeting.end_at, location: meeting.location_or_link });
  return { meeting, ics };
}

function listMeetings(companyId, { leadId, status } = {}) {
  let q = 'SELECT * FROM meetings WHERE company_id = ?';
  const params = [companyId];
  if (leadId) { q += ' AND lead_id = ?'; params.push(leadId); }
  if (status) { q += ' AND status = ?'; params.push(status); }
  q += ' ORDER BY start_at ASC';
  return db.prepare(q).all(...params);
}

function updateMeetingStatus(companyId, id, status) {
  const existing = db.prepare('SELECT * FROM meetings WHERE id = ? AND company_id = ?').get(id, companyId);
  if (!existing) return null;
  db.prepare('UPDATE meetings SET status = ? WHERE id = ?').run(status, id);
  return db.prepare('SELECT * FROM meetings WHERE id = ?').get(id);
}

module.exports = { scheduleMeeting, listMeetings, updateMeetingStatus, buildIcs };
