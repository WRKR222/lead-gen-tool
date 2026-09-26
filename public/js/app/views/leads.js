import {
  state, api, esc, $, $$, label, money, dateTime, dateOnly, ago, leadName, statusTag, statusLabel, methodLabel, channelLabel,
  reasonOptions, toast, busy, openDialog, openDrawer, closeDrawer, fileToUpload, formValues, isAgencyWorkspace, download
} from '../core.js';
import { refreshWorkspace } from '../main.js';

const SCOPES = [['nairobi', 'Home city'], ['kenya', 'Home country'], ['east_africa', 'East Africa'], ['africa', 'Africa'], ['global', 'Global']];
const FILTERS = [['', 'All'], ['new', 'New'], ['contacted', 'Contacted'], ['replied', 'Replied'], ['meeting_booked', 'Meeting booked'],
  ['on_fence', 'On the fence'], ['no_response', 'Not responded'], ['closed_won', 'Converted'], ['closed_lost', 'Said no']];

let list = [];
let selected = new Set();
let filter = { status: '', q: '', due: false };
let scope = 'kenya';

export async function render(root) {
  const agency = isAgencyWorkspace();
  selected = new Set();
  root.innerHTML = `
    <div class="page-head"><div><div class="kicker">${agency ? 'Stage 1 · Find clients' : 'Leads'}</div>
      <h1>${agency ? 'Prospects' : 'Leads'}</h1>
      <p>${agency ? 'Businesses that could hire the agency. Start scattergun across high-demand niches (dentists, clinics, local businesses customers come back to), then specialise in what converts.'
        : `${state.workspace.target_market === 'b2c' ? 'People' : 'Businesses'} who could buy from ${esc(state.workspace.name)}. Click any lead to reach them by every method and record what happened.`}</p></div>
      <div class="row"><button class="btn btn-secondary" id="addLead">Add lead</button></div></div>
    <div class="grid2">
      <div class="card"><h3>Find new ${agency ? 'prospects' : 'leads'}</h3>
        <div class="field"><span class="lbl">Where</span><div class="chips" id="scopeChips">${SCOPES.map(([k, l]) => `<button class="chip ${k === scope ? 'on' : ''}" data-scope="${k}">${esc(l)}</button>`).join('')}</div></div>
        <div class="row"><div class="grow"><input class="input" id="niche" list="niches" placeholder="${agency ? 'Niche, e.g. dentists (blank = your ideal-customer profile)' : 'Optional niche override'}" /></div>
          <button class="btn btn-primary" id="discoverBtn">Search</button></div>
        <datalist id="niches">${state.playbook.HIGH_DEMAND_NICHES.map(n => `<option value="${esc(n)}">`).join('')}</datalist>
        <p class="hint" id="discoverStatus">Searches every connected source at once (Clay, Explorium, web research) and scores each lead.</p></div>
      <div class="card"><h3>Import a lead list</h3><p class="sub">From a scraping tool, Google sweep, ad lead-form export or CRM - Excel (.xlsx) or CSV. Columns like company, name, phone, email, whatsapp, instagram, address are picked up automatically.</p>
        <div class="row"><input class="input grow" type="file" id="importFile" accept=".xlsx,.csv" /><button class="btn btn-secondary" id="importBtn">Import</button></div></div>
    </div>
    <div class="toolbar" style="margin-top:18px">
      <div class="chips" id="statusChips">${FILTERS.map(([k, l]) => `<button class="chip ${k === filter.status ? 'on' : ''}" data-status="${k}">${esc(l)}</button>`).join('')}</div>
      <label class="check small"><input type="checkbox" id="dueOnly" ${filter.due ? 'checked' : ''}/> Follow-up due</label>
      <input class="input" id="q" style="max-width:220px" placeholder="Search name, email, city…" value="${esc(filter.q)}" />
    </div>
    <div class="toolbar" id="bulkBar" hidden>
      <span class="small" id="bulkCount"></span>
      <button class="btn btn-primary btn-sm" id="bulkEmail">Email selected</button>
      <button class="btn btn-secondary btn-sm" data-push="highlevel">Push to HighLevel</button>
      <button class="btn btn-secondary btn-sm" data-push="appointwise">Push to Appointwise</button>
      <button class="btn btn-ghost btn-sm" id="clearSel">Clear</button>
    </div>
    <div class="tablewrap"><table class="table"><thead><tr><th><input type="checkbox" id="selAll" aria-label="Select all"/></th><th>Lead</th><th>Decision maker</th><th>Reach</th><th>Location</th><th>Status</th><th>Next follow-up</th><th class="num">Score</th></tr></thead>
      <tbody id="rows"><tr><td colspan="8" class="empty">Loading…</td></tr></tbody></table></div>`;

  $('#scopeChips', root).addEventListener('click', e => { const b = e.target.closest('[data-scope]'); if (!b) return; scope = b.dataset.scope; $$('#scopeChips .chip', root).forEach(c => c.classList.toggle('on', c === b)); });
  $('#discoverBtn', root).addEventListener('click', e => busy(e.target, async () => {
    const data = await api('/leads/discover', { method: 'POST', body: { geoScope: scope, niche: $('#niche', root).value.trim() || undefined } });
    $('#discoverStatus', root).textContent = `${data.leadsFound} found${data.niche ? ` for "${data.niche}"` : ''} · sources: ${data.sourcesQueried.join(', ')} · average score ${Math.round((data.avgScore || 0) * 100)}%`;
    toast(`${data.leadsFound} new ${agency ? 'prospects' : 'leads'} added`, 'ok');
    await load(root);
  }, 'Searching…'));
  $('#importBtn', root).addEventListener('click', e => busy(e.target, async () => {
    const up = await fileToUpload($('#importFile', root).files[0]);
    const r = await api('/leads/import', { method: 'POST', body: up });
    toast(`Imported ${r.imported} leads${r.errors.length ? ` (${r.errors.length} rows skipped)` : ''}`, r.imported ? 'ok' : 'err');
    await load(root);
  }, 'Importing…'));
  $('#addLead', root).addEventListener('click', () => addLeadDialog(() => load(root)));
  $('#statusChips', root).addEventListener('click', e => { const b = e.target.closest('[data-status]'); if (!b) return; filter.status = b.dataset.status; $$('#statusChips .chip', root).forEach(c => c.classList.toggle('on', c === b)); load(root); });
  $('#dueOnly', root).addEventListener('change', e => { filter.due = e.target.checked; load(root); });
  let t; $('#q', root).addEventListener('input', e => { clearTimeout(t); t = setTimeout(() => { filter.q = e.target.value.trim(); load(root); }, 250); });
  $('#selAll', root).addEventListener('change', e => { list.forEach(l => e.target.checked ? selected.add(l.id) : selected.delete(l.id)); drawRows(root); });
  $('#clearSel', root).addEventListener('click', () => { selected.clear(); drawRows(root); });
  $('#bulkEmail', root).addEventListener('click', () => { state.emailSelection = [...selected]; location.hash = '#/outreach'; });
  $$('[data-push]', root).forEach(b => b.addEventListener('click', () => busy(b, async () => {
    const r = await api(`/integrations/${b.dataset.push}/push`, { method: 'POST', body: { leadIds: [...selected] } });
    const ok = r.results.filter(x => x.status === 'ok').length; const mock = r.results.filter(x => x.status === 'mock').length;
    toast(mock ? `${label(b.dataset.push)} is not configured yet - ${mock} logged in demo mode (see Settings → Integrations)` : `${ok} of ${r.results.length} pushed to ${label(b.dataset.push)}`, mock ? '' : 'ok');
  })));
  await load(root);
}

async function load(root) {
  const qs = new URLSearchParams({ limit: '500' });
  if (filter.status) qs.set('status', filter.status);
  if (filter.q) qs.set('q', filter.q);
  if (filter.due) qs.set('followUpDue', 'true');
  list = await api('/leads?' + qs);
  drawRows(root);
}

function reachIcons(l) {
  const ch = [['address', l.address, '📍'], ['phone', l.phone, '📞'], ['email', l.email, '✉️'], ['website', l.website, '🌐']].filter(x => x[1]);
  return ch.length ? ch.map(([c, , i]) => `<span title="${esc(channelLabel(c))}">${i}</span>`).join(' ') : '<span class="muted small">none yet</span>';
}

function drawRows(root) {
  const tbody = $('#rows', root);
  tbody.innerHTML = list.map(l => `<tr class="clickable" data-id="${esc(l.id)}">
      <td><input type="checkbox" class="sel" data-id="${esc(l.id)}" ${selected.has(l.id) ? 'checked' : ''} aria-label="Select"/></td>
      <td>${esc(leadName(l))}<div class="cell-meta">${esc([l.lead_type === 'person' ? 'Person' : l.industry, l.source].filter(Boolean).join(' · '))}</div></td>
      <td>${esc(l.lead_type === 'person' ? '—' : (l.contact_name || '—'))}<div class="cell-meta">${esc(l.lead_type === 'person' ? '' : (l.title || ''))}</div></td>
      <td>${reachIcons(l)}</td>
      <td>${esc([l.city, l.country].filter(Boolean).join(', '))}</td>
      <td>${statusTag(l.status)}</td>
      <td class="small">${l.next_follow_up_at ? esc(ago(l.next_follow_up_at)) : '<span class="muted">—</span>'}${l.follow_up_paused ? ' <span class="tag tag-neutral">paused</span>' : ''}</td>
      <td class="num">${Math.round((l.score || 0) * 100)}%</td></tr>`).join('') || `<tr><td colspan="8" class="empty">No leads match - search or import above.</td></tr>`;
  tbody.querySelectorAll('.sel').forEach(cb => cb.addEventListener('click', e => { e.stopPropagation(); cb.checked ? selected.add(cb.dataset.id) : selected.delete(cb.dataset.id); bulkBar(root); }));
  tbody.querySelectorAll('tr[data-id]').forEach(tr => tr.addEventListener('click', () => { location.hash = `#/lead/${tr.dataset.id}`; }));
  bulkBar(root);
}

function bulkBar(root) {
  $('#bulkBar', root).hidden = !selected.size;
  $('#bulkCount', root).textContent = `${selected.size} selected`;
}

function contactFields() {
  const channels = state.playbook.CONTACT_CHANNELS;
  return `<div class="row"><div class="field" style="flex:0 0 150px"><label>Channel</label><select class="input" name="channel">${channels.map(c => `<option value="${c}">${esc(channelLabel(c))}</option>`).join('')}</select></div>
    <div class="field grow"><label>Number / handle / address</label><input class="input" name="value" required /></div></div>
    <div class="row"><div class="field grow"><label>Belongs to (name)</label><input class="input" name="personName" placeholder="e.g. Dr Wanjiru or Reception" /></div>
    <div class="field grow"><label>Their role</label><input class="input" name="personRole" placeholder="e.g. Owner" /></div></div>
    <label class="check"><input type="checkbox" name="isDecisionMaker" /> This is the decision maker</label>`;
}

function addLeadDialog(onDone) {
  const b2c = state.workspace.target_market === 'b2c';
  openDialog({
    title: 'Add a lead',
    body: `<div class="field"><div class="chips"><label class="check"><input type="radio" name="leadType" value="business" ${b2c ? '' : 'checked'}/> Business</label>
        <label class="check"><input type="radio" name="leadType" value="person" ${b2c ? 'checked' : ''}/> Person</label></div></div>
      <div class="row"><div class="field grow"><label>Company (for a business)</label><input class="input" name="companyName" /></div>
        <div class="field grow"><label>Person's name</label><input class="input" name="contactName" /></div></div>
      <div class="row"><div class="field grow"><label>Role</label><input class="input" name="title" placeholder="Owner, practice manager…" /></div>
        <div class="field grow"><label>Industry</label><input class="input" name="industry" /></div></div>
      <div class="row"><div class="field grow"><label>Phone</label><input class="input" name="phone" /></div><div class="field grow"><label>Email</label><input class="input" name="email" type="email" /></div></div>
      <div class="row"><div class="field grow"><label>WhatsApp</label><input class="input" name="whatsapp" /></div><div class="field grow"><label>Instagram</label><input class="input" name="instagram" placeholder="@handle" /></div></div>
      <div class="row"><div class="field grow"><label>Facebook</label><input class="input" name="facebook" /></div><div class="field grow"><label>LinkedIn</label><input class="input" name="linkedin" /></div></div>
      <div class="row"><div class="field grow"><label>TikTok</label><input class="input" name="tiktok" /></div><div class="field grow"><label>Website</label><input class="input" name="website" /></div></div>
      <div class="field"><label>Physical address (for door-to-door)</label><input class="input" name="address" /></div>
      <div class="row"><div class="field grow"><label>City</label><input class="input" name="city" value="${esc(state.workspace.home_city || '')}" /></div><div class="field grow"><label>Country</label><input class="input" name="country" value="${esc(state.workspace.home_country || '')}" /></div></div>
      <div class="field"><label>Notes</label><textarea class="input" name="notes" rows="2"></textarea></div>`,
    actions: [{ label: 'Add lead', primary: true, onClick: async (body) => {
      const v = formValues(body);
      const lead = await api('/leads', { method: 'POST', body: {
        leadType: v.leadType, companyName: v.companyName || undefined, contactName: v.contactName || undefined, title: v.title, industry: v.industry,
        phone: v.phone, email: v.email, website: v.website, address: v.address, city: v.city, country: v.country, notes: v.notes,
        socials: { whatsapp: v.whatsapp, instagram: v.instagram, facebook: v.facebook, linkedin: v.linkedin, tiktok: v.tiktok }
      } });
      toast('Lead added', 'ok');
      onDone();
      location.hash = `#/lead/${lead.id}`;
    } }]
  });
}

// ====================== lead drawer ======================

let current = null;

export async function openLead(id) {
  const drawer = openDrawer('<p class="empty">Loading lead…</p>');
  try { current = await api(`/leads/${id}`); }
  catch (err) { drawer.innerHTML = `<p class="empty">${esc(err.message)}</p>`; return; }
  drawLead(drawer);
}

async function reloadLead() {
  current = await api(`/leads/${current.id}`);
  drawLead($('#drawer'));
}

function contactLink(c) {
  const v = c.value;
  const href = {
    phone: `tel:${v.replace(/\s+/g, '')}`, email: `mailto:${v}`, whatsapp: `https://wa.me/${v.replace(/[^\d]/g, '')}`,
    address: `https://www.google.com/maps/search/?api=1&query=${encodeURIComponent(v)}`, website: /^https?:/i.test(v) ? v : `https://${v}`,
    instagram: /^https?:/i.test(v) ? v : `https://instagram.com/${v.replace(/^@/, '')}`, facebook: /^https?:/i.test(v) ? v : `https://facebook.com/${v.replace(/^@/, '')}`,
    tiktok: /^https?:/i.test(v) ? v : `https://www.tiktok.com/@${v.replace(/^@/, '')}`, x: /^https?:/i.test(v) ? v : `https://x.com/${v.replace(/^@/, '')}`,
    linkedin: /^https?:/i.test(v) ? v : null
  }[c.channel];
  return href ? `<a href="${esc(href)}" target="_blank" rel="noopener">${esc(v)}</a>` : esc(v);
}

function timeline(l) {
  const items = [
    ...l.attempts.map(a => ({ at: a.occurred_at, html: `<b>${esc(methodLabel(a.method))}</b> ${a.direction === 'inbound' ? '(they reached out)' : ''} → ${esc(label(a.result))}${a.automated ? ' <span class="tag tag-neutral">auto</span>' : ''}${a.spoke_to_decision_maker ? ' <span class="tag tag-good">decision maker</span>' : ''}${a.notes ? `<div class="small muted">${esc(a.notes)}</div>` : ''}` })),
    ...l.emails.map(e => ({ at: e.sent_at || e.received_at || e.created_at, html: `${e.direction === 'inbound' ? '📨 <b>Reply received</b>' : e.status === 'draft' ? '📝 <b>AI draft reply</b>' : '✉️ <b>Email sent</b>'}: ${esc(e.subject || '')}${e.classification ? ` <span class="tag tag-accent">${esc(label(e.classification))}</span>` : ''}<div class="small muted">${esc((e.body || '').slice(0, 220))}</div>` })),
    ...l.meetings.map(m => ({ at: m.created_at, html: `📅 <b>Meeting</b> ${esc(dateTime(m.start_at))} (${esc(label(m.meeting_type))})${m.outcome ? ` → ${esc(label(m.outcome))}` : ''}` })),
    ...l.tasks.map(t => ({ at: t.created_at, html: `☑️ <b>Task</b>: ${esc(t.title)} <span class="tag tag-neutral">${esc(t.status)}</span>` }))
  ].sort((a, b) => String(b.at).localeCompare(String(a.at)));
  return items.length ? `<div class="timeline">${items.map(i => `<div class="tl-item"><span class="dot"></span><div>${i.html}<div class="when">${esc(dateTime(i.at))}</div></div></div>`).join('')}</div>` : '<p class="empty">No activity yet.</p>';
}

function drawLead(drawer) {
  const l = current;
  const agency = isAgencyWorkspace();
  const methods = state.playbook.OUTREACH_METHODS;
  const pre = l.preferred_methods.length ? l.preferred_methods : methods.map(m => m.key);
  drawer.innerHTML = `
    <div class="drawer-head"><div><div class="kicker">${l.lead_type === 'person' ? 'Person' : 'Business'}${l.industry ? ' · ' + esc(l.industry) : ''}</div>
      <h2>${esc(leadName(l))}</h2>
      <div class="row small" style="margin-top:6px">${statusTag(l.status)}<span class="muted">Score ${Math.round((l.score || 0) * 100)}%</span>
        ${l.estimated_value ? `<span class="muted">· worth ~${esc(money(l.estimated_value))}</span>` : ''}${l.lost_reason_category ? `<span class="muted">· lost: ${esc(label(l.lost_reason_category))}</span>` : ''}</div></div>
      <button class="btn btn-secondary" id="closeLead">Close</button></div>

    <div class="section-title">Outcome</div>
    <div class="row">
      <button class="btn btn-secondary btn-sm" data-outcome="converted">✓ Converted</button>
      <button class="btn btn-secondary btn-sm" data-outcome="on_fence">~ On the fence</button>
      <button class="btn btn-secondary btn-sm" data-outcome="said_no">✕ Said no</button>
      <button class="btn btn-secondary btn-sm" data-outcome="no_response">… Not responded</button>
      ${agency ? `<button class="btn btn-primary btn-sm" id="signClient" ${l.converted_client_id ? 'disabled' : ''}>${l.converted_client_id ? 'Signed as client' : 'Sign as client →'}</button>` : ''}
    </div>

    <div class="section-title">All ways to reach ${esc(l.lead_type === 'person' ? 'them' : 'this business')}</div>
    <div class="card" style="padding:8px 14px">
      ${l.contacts.map(c => `<div class="contact"><span class="small muted">${esc(channelLabel(c.channel))}</span>
        <div>${contactLink(c)}${c.person_name || c.person_role ? `<div class="who">${esc([c.person_name, c.person_role].filter(Boolean).join(' · '))}${c.is_decision_maker ? ' · <b>decision maker</b>' : ''}</div>` : ''}</div>
        <button class="btn btn-ghost btn-sm" data-del-contact="${esc(c.id)}" title="Remove">✕</button></div>`).join('') || '<p class="empty">No contact details yet.</p>'}
      <button class="btn btn-ghost btn-sm" id="addContact" style="margin:6px 0">+ Add a phone, email, social handle or address</button>
    </div>

    <div class="section-title">Reach out - pick one or more methods</div>
    <div class="method-list" id="methodList">${methods.map(m => `
      <label class="method ${pre.includes(m.key) ? 'on' : ''}"><input type="checkbox" value="${m.key}" ${pre.includes(m.key) ? 'checked' : ''}/>
        <div><b>${esc(m.label)}</b> ${m.badge ? `<span class="tag tag-good">${esc(m.badge)}</span>` : ''}<div class="small muted">${esc(m.description)}</div></div>
        <span class="m-rank">#${m.rank}</span></label>`).join('')}</div>
    <div class="row" style="margin-top:10px"><button class="btn btn-primary" id="prepBtn">Prepare with AI</button>
      <span class="hint">Every script follows the standards: decision maker, straight to the point, scarcity, no pitch before the meeting.</span></div>
    <div id="prepOut" class="stack" style="margin-top:12px"></div>

    <div class="section-title">Meetings</div>
    <div class="stack">${l.meetings.map(m => `<div class="card"><div class="row" style="justify-content:space-between"><div><b>${esc(m.title)}</b>
        <div class="small muted">${esc(dateTime(m.start_at))} · ${esc(label(m.meeting_type))}${m.location_or_link ? ' · ' + esc(m.location_or_link) : ''}${m.outcome ? ` · outcome: <b>${esc(label(m.outcome))}</b>` : ''}</div></div>
        <div class="row"><button class="btn btn-secondary btn-sm" data-ics="${esc(m.id)}">.ics</button><button class="btn btn-secondary btn-sm" data-brief="${esc(m.id)}">CPS brief</button>
        <button class="btn btn-primary btn-sm" data-record-meeting="${esc(m.id)}">Record how it went</button></div></div></div>`).join('')}
      <div><button class="btn btn-secondary" id="bookMeeting">Book a meeting (CPS brief included)</button></div></div>

    <div class="section-title">Follow-up</div>
    <div class="card"><div class="row" style="justify-content:space-between">
      <div class="small">${l.next_follow_up_at ? `Next touch <b>${esc(ago(l.next_follow_up_at))}</b> (${esc(dateOnly(l.next_follow_up_at))})` : 'No follow-up scheduled'} · ${esc(l.follow_up_count || 0)} touches so far${l.follow_up_paused ? ' · <b>paused</b>' : ''}</div>
      <button class="btn btn-secondary btn-sm" id="pauseFollow">${l.follow_up_paused ? 'Resume follow-ups' : 'Pause follow-ups'}</button></div>
      <p class="hint">Non-responders are followed up with growing gaps and rotating methods, capped per month - persistent, never spammy.</p></div>

    <div class="section-title">Notes & tools</div>
    <div class="card"><textarea class="input" id="notes" rows="3" placeholder="Anything worth remembering…">${esc(l.notes || '')}</textarea>
      <div class="row" style="margin-top:8px"><button class="btn btn-secondary btn-sm" id="saveNotes">Save notes</button>
        <button class="btn btn-secondary btn-sm" data-push1="highlevel">Send to HighLevel</button><button class="btn btn-secondary btn-sm" data-push1="appointwise">Send to Appointwise</button>
        ${l.email ? '<button class="btn btn-ghost btn-sm" id="simReply">Simulate a reply</button>' : ''}</div></div>

    <div class="section-title">Timeline</div>
    ${timeline(l)}`;

  $('#closeLead').addEventListener('click', closeDrawer);
  $$('[data-outcome]', drawer).forEach(b => b.addEventListener('click', () => outcomeDialog(b.dataset.outcome)));
  const sign = $('#signClient'); if (sign && !l.converted_client_id) sign.addEventListener('click', signClientDialog);
  $$('[data-del-contact]', drawer).forEach(b => b.addEventListener('click', () => busy(b, async () => { await api(`/leads/${l.id}/contacts/${b.dataset.delContact}`, { method: 'DELETE' }); await reloadLead(); })));
  $('#addContact').addEventListener('click', () => openDialog({ title: 'Add a contact point', body: contactFields(), actions: [{ label: 'Add', primary: true, onClick: async (body) => {
    await api(`/leads/${l.id}/contacts`, { method: 'POST', body: formValues(body) }); await reloadLead();
  } }] }));
  $$('#methodList input', drawer).forEach(cb => cb.addEventListener('change', () => cb.closest('.method').classList.toggle('on', cb.checked)));
  $('#prepBtn').addEventListener('click', e => busy(e.target, prepare, 'Preparing…'));
  $('#bookMeeting').addEventListener('click', bookMeetingDialog);
  $$('[data-ics]', drawer).forEach(b => b.addEventListener('click', () => busy(b, () => download(`/meetings/${b.dataset.ics}/ics`, 'meeting.ics'))));
  $$('[data-brief]', drawer).forEach(b => b.addEventListener('click', () => showBrief(l.meetings.find(m => m.id === b.dataset.brief))));
  $$('[data-record-meeting]', drawer).forEach(b => b.addEventListener('click', () => recordMeetingDialog(l.meetings.find(m => m.id === b.dataset.recordMeeting))));
  $('#pauseFollow').addEventListener('click', e => busy(e.target, async () => { await api(`/leads/${l.id}/follow-up`, { method: 'POST', body: { paused: !l.follow_up_paused } }); await reloadLead(); }));
  $('#saveNotes').addEventListener('click', e => busy(e.target, async () => { await api(`/leads/${l.id}`, { method: 'PATCH', body: { notes: $('#notes').value } }); toast('Saved', 'ok'); }));
  $$('[data-push1]', drawer).forEach(b => b.addEventListener('click', () => busy(b, async () => {
    const r = await api(`/integrations/${b.dataset.push1}/push`, { method: 'POST', body: { leadIds: [l.id] } });
    const s = r.results[0] && r.results[0].status;
    toast(s === 'ok' ? `Sent to ${label(b.dataset.push1)}` : s === 'mock' ? `${label(b.dataset.push1)} isn't configured - logged in demo mode (Settings → Integrations)` : `Failed: ${r.results[0] && (r.results[0].error || r.results[0].httpStatus)}`, s === 'ok' ? 'ok' : s === 'mock' ? '' : 'err');
  })));
  const sim = $('#simReply');
  if (sim) sim.addEventListener('click', () => openDialog({ title: 'Simulate a reply from this lead', body: '<p class="small muted">Runs the real inbound pipeline: matching, classification, notification and the AI reply bot.</p><textarea class="input" name="text" rows="4">Hi, sounds interesting - how much does it cost? Could we meet next week?</textarea>',
    actions: [{ label: 'Send reply in', primary: true, onClick: async (body) => { const r = await api('/inbox/simulate-reply', { method: 'POST', body: { leadId: l.id, text: formValues(body).text } }); toast(`Reply classified as "${label(r.classification)}"${r.autoReply ? ` · AI reply ${r.autoReply.status}` : ''}`, 'ok'); await reloadLead(); } }] }));
}

function outcomeDialog(outcome) {
  const l = current;
  const needsReason = outcome === 'said_no';
  const pyramid = state.workspace.value_pyramid || {};
  openDialog({
    title: { converted: 'Mark as converted', on_fence: 'Mark as on the fence', said_no: 'Mark as said no', no_response: 'Mark as not responded' }[outcome],
    body: needsReason
      ? `<div class="field"><label>Why did they say no?</label><select class="input" name="reasonCategory">${reasonOptions('price')}</select></div>
         <div class="field"><label>In their words (optional)</label><textarea class="input" name="reason" rows="2"></textarea></div><p class="hint">Reasons feed the AI learning on the Analytics page.</p>`
      : outcome === 'converted' && !isAgencyWorkspace()
        ? `<p class="small">They'll be added to Customers.</p><div class="field"><label>What did they buy?</label><select class="input" name="tier">${(pyramid.tiers || []).filter(t => t.key !== 'lifetime').map(t => `<option>${esc(t.name)}</option>`).join('')}</select></div>`
        : outcome === 'on_fence' ? '<p class="small">We\'ll check back in a week, keeping the cadence gentle.</p>'
          : outcome === 'no_response' ? '<p class="small">They move to slow nurture - a light touch every couple of months.</p>' : '<p class="small">Great - use "Sign as client" to set up their workspace.</p>',
    actions: [{ label: 'Save', primary: true, onClick: async (body) => {
      await api(`/leads/${l.id}/outcome`, { method: 'POST', body: { outcome, ...formValues(body) } });
      toast('Outcome saved', 'ok');
      await reloadLead();
    } }]
  });
}

function signClientDialog() {
  const l = current;
  openDialog({
    title: `Sign ${leadName(l)} as a client`,
    body: `<p class="small muted">Creates their client workspace and runs the AI setup: profile, value pyramid in their currency, and growth plan.</p>
      <div class="field"><span class="lbl">Services they're buying</span>${state.playbook.SERVICES.map(s => `<label class="check" style="margin-right:12px"><input type="checkbox" name="services" value="${s.key}" checked/> ${esc(s.label)}</label>`).join('')}</div>
      <div class="field"><span class="lbl">One ad platform</span>${state.playbook.AD_PLATFORMS.map((p, i) => `<label class="check" style="margin-right:12px"><input type="radio" name="adPlatform" value="${p.key}" ${i === 0 ? 'checked' : ''}/> ${esc(p.label)}</label>`).join('')}</div>
      <div class="row"><div class="field grow"><label>Their leads are</label><select class="input" name="targetMarket"><option value="b2c">People (B2C, e.g. patients)</option><option value="b2b">Businesses (B2B)</option></select></div>
        <div class="field grow"><label>Monthly retainer (${esc(state.workspace.currency)})</label><input class="input" name="monthlyRetainer" type="number" min="0" /></div></div>
      <div class="field"><label>What they do and want (optional)</label><textarea class="input" name="description" rows="3">${esc(l.notes || '')}</textarea></div>`,
    actions: [{ label: 'Create client workspace', primary: true, onClick: async (body) => {
      const v = formValues(body);
      const client = await api(`/leads/${l.id}/convert-to-client`, { method: 'POST', body: { ...v, description: v.description || undefined, monthlyRetainer: v.monthlyRetainer || undefined } });
      toast(`${client.name} is now a client`, 'ok');
      await refreshWorkspace();
      await reloadLead();
    } }]
  });
}

function guide(obj, keys) {
  return `<dl class="guide">${keys.filter(([k]) => obj && obj[k]).map(([k, t]) => `<dt>${esc(t)}</dt><dd>${esc(Array.isArray(obj[k]) ? obj[k].join(' · ') : typeof obj[k] === 'object' ? Object.entries(obj[k]).map(([a, b]) => `"${a}" → ${b}`).join('\n') : obj[k])}</dd>`).join('')}</dl>`;
}

function recordForm(method, channels) {
  const results = state.playbook.ATTEMPT_RESULTS;
  const defaults = { door_to_door: 'gatekeeper', cold_call: 'no_answer', digital: 'sent', email_dm: 'sent' };
  return `<form class="record" data-method="${method}"><div class="divider"></div><b class="small">Record what happened</b>
    <div class="row" style="margin-top:8px"><div class="field grow"><label>Result</label><select class="input" name="result">${results.map(r => `<option value="${r.key}" ${r.key === defaults[method] ? 'selected' : ''}>${esc(r.label)}</option>`).join('')}</select></div>
      ${channels.length > 1 ? `<div class="field grow"><label>Channel</label><select class="input" name="channel">${channels.map(c => `<option value="${c}">${esc(channelLabel(c))}</option>`).join('')}</select></div>` : `<input type="hidden" name="channel" value="${channels[0]}"/>`}</div>
    <div class="field reason-field" hidden><label>Why they said no</label><select class="input" name="reasonCategory">${reasonOptions('price')}</select></div>
    <div class="field"><span class="lbl">Meeting-setting standards followed</span><div class="chips">
      <label class="check small"><input type="checkbox" name="spokeToDecisionMaker"/> Spoke to the decision maker</label>
      ${state.playbook.MEETING_STANDARDS.filter(s => s.key !== 'decision_maker').map(s => `<label class="check small"><input type="checkbox" data-std="${s.key}" checked/> ${esc(s.label)}</label>`).join('')}</div></div>
    <div class="field"><textarea class="input" name="notes" rows="2" placeholder="Notes (who you spoke to, what they said, best time to come back)"></textarea></div>
    <button class="btn btn-primary btn-sm" type="submit">Save result</button></form>`;
}

async function prepare() {
  const l = current;
  const methods = $$('#methodList input:checked').map(i => i.value);
  if (!methods.length) { toast('Pick at least one method', 'err'); return; }
  const r = await api('/outreach/prepare', { method: 'POST', body: { leadId: l.id, methods } });
  const out = $('#prepOut');
  const m = r.methods;
  const blocks = [];
  if (m.door_to_door) blocks.push(`<div class="card"><h3>🚪 Door to door <span class="tag tag-good">Best</span></h3>
    ${m.door_to_door.addresses.map(a => `<div class="small">📍 <a href="${esc(a.mapUrl)}" target="_blank" rel="noopener">${esc(a.value)}</a></div>`).join('') || `<p class="hint">${esc(m.door_to_door.missing)}</p>`}
    ${guide(m.door_to_door.brief, [['bestTime', 'Best time'], ['walkInOpener', 'Walk-in opener'], ['ifGatekeeper', 'If a gatekeeper answers'], ['hook', 'Hook'], ['scarcityLine', 'Scarcity'], ['meetingAsk', 'Ask for the meeting'], ['leaveBehind', 'Leave behind']])}
    ${recordForm('door_to_door', ['in_person'])}</div>`);
  if (m.cold_call) blocks.push(`<div class="card"><h3>📞 Cold call</h3>
    ${m.cold_call.numbers.map(n => `<div class="small"><a href="${esc(n.telUrl)}">${esc(n.value)}</a> <span class="muted">${esc([n.person, n.role].filter(Boolean).join(' · '))}${n.decisionMaker ? ' · decision maker' : ''}</span></div>`).join('') || `<p class="hint">${esc(m.cold_call.missing)}</p>`}
    ${guide(m.cold_call.script, [['opener', 'Opener (first 10 seconds)'], ['gatekeeperScript', 'Gatekeeper'], ['hook', 'Hook'], ['scarcityLine', 'Scarcity'], ['meetingAsk', 'Ask for the meeting'], ['questionDeflection', 'If they ask what it is / the price'], ['objectionHandling', 'Objections'], ['ifTheySayNo', 'If they say no'], ['coachingNotes', 'Coaching']])}
    ${recordForm('cold_call', ['phone'])}</div>`);
  if (m.digital) blocks.push(`<div class="card"><h3>💬 Multi-platform digital</h3><p class="hint">${esc(m.digital.note)}${m.digital.missing ? ' ' + esc(m.digital.missing) : ''}</p>
    ${m.digital.messages.map((d, i) => `<div class="field"><label>${esc(channelLabel(d.platform))}${d.handle ? ` · ${esc(d.handle)}` : ''}</label><textarea class="input dm" data-i="${i}" rows="3">${esc(d.text)}</textarea>
      <div class="row" style="margin-top:6px">${d.openUrl ? `<a class="btn btn-secondary btn-sm" href="${esc(d.openUrl)}" target="_blank" rel="noopener">Open ${esc(channelLabel(d.platform))}</a>` : ''}<button class="btn btn-ghost btn-sm" data-copy="${i}" type="button">Copy</button></div></div>`).join('')}
    ${recordForm('digital', m.digital.messages.map(d => d.platform))}</div>`);
  if (m.email_dm) blocks.push(`<div class="card"><h3>✉️ Email</h3>${m.email_dm.to.length ? `<div class="small">To: ${esc(m.email_dm.to.map(t => t.value).join(', '))}</div>` : `<p class="hint">${esc(m.email_dm.missing)}</p>`}
    <div class="field" style="margin-top:8px"><label>Subject</label><input class="input" id="emSubject" value="${esc(m.email_dm.draft.subject)}"/></div>
    <div class="field"><label>Body</label><textarea class="input" id="emBody" rows="7">${esc(m.email_dm.draft.body)}</textarea></div>
    <button class="btn btn-primary btn-sm" id="emSend" ${m.email_dm.to.length ? '' : 'disabled'}>Send email</button><span class="hint"> Sent with an unsubscribe link; logged and followed up automatically.</span></div>`);
  out.innerHTML = blocks.join('');

  $$('[data-copy]', out).forEach(b => b.addEventListener('click', async () => {
    try { await navigator.clipboard.writeText($(`textarea.dm[data-i="${b.dataset.copy}"]`, out).value); toast('Copied', 'ok'); } catch { toast('Copy blocked by the browser - select the text instead', 'err'); }
  }));
  $$('form.record', out).forEach(f => {
    const reason = $('.reason-field', f);
    $('[name="result"]', f).addEventListener('change', e => { reason.hidden = e.target.value !== 'said_no'; });
    f.addEventListener('submit', e => {
      e.preventDefault();
      busy($('button[type="submit"]', f), async () => {
        const v = formValues(f);
        const standards = { decision_maker: !!v.spokeToDecisionMaker };
        $$('[data-std]', f).forEach(c => { standards[c.dataset.std] = c.checked; });
        const method = f.dataset.method;
        const msg = method === 'digital' ? ($$('textarea.dm', out).map(t => t.value).find(Boolean) || '') : '';
        const res = await api('/outreach/attempts', { method: 'POST', body: { leadId: l.id, method, channel: v.channel, result: v.result, spokeToDecisionMaker: !!v.spokeToDecisionMaker, standards, notes: v.notes, message: msg, reasonCategory: v.result === 'said_no' ? v.reasonCategory : undefined, reason: v.result === 'said_no' ? v.notes : undefined } });
        toast(`Saved · lead is now "${statusLabel(res.lead.status)}"${res.lead.next_follow_up_at ? ` · next touch ${ago(res.lead.next_follow_up_at)}` : ''}`, 'ok');
        if (v.result === 'meeting_booked') bookMeetingDialog();
        await reloadLead();
      }, 'Saving…');
    });
  });
  const send = $('#emSend', out);
  if (send) send.addEventListener('click', () => busy(send, async () => {
    const r2 = await api('/outreach/email/send', { method: 'POST', body: { drafts: [{ leadId: l.id, subject: $('#emSubject', out).value, body: $('#emBody', out).value, mode: 'bespoke', angle: m.email_dm.draft.angle }] } });
    const s = r2.results[0].status;
    toast(s === 'sent' ? 'Email sent' : s === 'skipped_rate_limited' ? 'Not sent: daily sending limit reached (domain warm-up) - try again tomorrow' : `Not sent: ${label(s)}`, s === 'sent' ? 'ok' : 'err');
    if (s === 'sent') await reloadLead();
  }, 'Sending…'));
}

function bookMeetingDialog() {
  const l = current;
  const start = new Date(Date.now() + 2 * 86400000); start.setHours(10, 0, 0, 0);
  const local = new Date(start.getTime() - start.getTimezoneOffset() * 60000).toISOString().slice(0, 16);
  openDialog({
    title: `Book a meeting with ${leadName(l)}`,
    body: `<div class="row"><div class="field grow"><label>Starts</label><input class="input" type="datetime-local" name="start" value="${local}" required/></div>
      <div class="field" style="flex:0 0 130px"><label>Minutes</label><input class="input" type="number" name="minutes" value="30" min="10"/></div></div>
      <div class="row"><div class="field grow"><label>Type</label><select class="input" name="meetingType"><option value="in_person">In person</option><option value="call">Phone call</option><option value="video">Video call</option></select></div>
      <div class="field grow"><label>Where / link</label><input class="input" name="locationOrLink" value="${esc(l.address || '')}"/></div></div>
      <p class="hint">A CPS brief (Attention → Identify → Solve → Cost) is prepared for this meeting, priced from the value pyramid.</p>`,
    actions: [{ label: 'Book meeting', primary: true, onClick: async (body) => {
      const v = formValues(body);
      const s = new Date(v.start);
      if (isNaN(s)) throw new Error('Pick a start time');
      const r = await api('/meetings', { method: 'POST', body: { leadId: l.id, title: `Meeting with ${leadName(l)}`, startAt: s.toISOString(), endAt: new Date(s.getTime() + (Number(v.minutes) || 30) * 60000).toISOString(), meetingType: v.meetingType, locationOrLink: v.locationOrLink } });
      toast('Meeting booked', 'ok');
      await reloadLead();
      showBrief(r.meeting);
      return false; // the brief now occupies the dialog
    } }]
  });
}

function showBrief(m) {
  const b = m && m.cps_brief;
  if (!b || !b.attention) { toast('No brief on this meeting yet', 'err'); return; }
  const anchor = b.cost && b.cost.anchor;
  openDialog({
    title: 'CPS meeting brief',
    body: `<div class="kicker">1 · Attention</div>${guide(b.attention, [['openingObservation', 'Open with'], ['toneSetter', 'Set the tone'], ['askWhyTheyAccepted', 'Ask']])}
      <div class="kicker">2 · Identify</div>${guide(b.identify, [['questions', 'Questions'], ['listenFor', 'Listen for'], ['acknowledge', 'Acknowledge']])}
      <div class="kicker">3 · Solve</div>${guide(b.solve, [['elevatorPitch', 'Elevator pitch (intrigue, no tool names)'], ['intrigueLines', 'Intrigue'], ['doNotMention', 'Do not mention']])}
      <div class="kicker">4 · Cost</div>${anchor ? `<p class="small">Price anchor: <b>${esc(anchor.offer)}</b> · ${esc(money(anchor.price, anchor.currency))}</p>` : ''}${guide(b.cost, [['howToState', 'How to state it'], ['ifRejected', 'If they reject'], ['captureContact', 'Before you leave']])}
      ${b.knownObjections && b.knownObjections.length ? `<div class="kicker">Objections that cost us deals before</div><p class="small">${esc(b.knownObjections.join(' · '))}</p>` : ''}`
  });
}

function recordMeetingDialog(m) {
  const stages = state.playbook.CPS_STAGES;
  const notes = m.cps_notes || {};
  openDialog({
    title: 'How did the meeting go?',
    body: `${stages.map(s => `<div class="field"><label>${s.step}. ${esc(s.label)} - ${esc(s.goal)}</label><textarea class="input" name="${s.key}" rows="2">${esc(notes[s.key] || '')}</textarea></div>`).join('')}
      <div class="row"><div class="field grow"><label>Price quoted (${esc(state.workspace.currency)})</label><input class="input" type="number" name="quotedPrice" value="${esc(m.quoted_price ?? '')}"/></div>
        <div class="field grow"><label>Outcome</label><select class="input" name="outcome"><option value="yes">Yes - they're in</option><option value="on_fence">On the fence</option><option value="no">No</option><option value="no_show">No-show</option></select></div></div>
      <div class="field" id="mReason"><label>If no - why?</label><select class="input" name="reasonCategory">${reasonOptions('price')}</select></div>`,
    actions: [{ label: 'Save', primary: true, onClick: async (body) => {
      const v = formValues(body);
      const cpsNotes = Object.fromEntries(stages.map(s => [s.key, v[s.key]]));
      await api(`/meetings/${m.id}`, { method: 'PATCH', body: { outcome: v.outcome, cpsNotes, quotedPrice: v.quotedPrice, reasonCategory: v.outcome === 'no' ? v.reasonCategory : undefined } });
      toast('Meeting recorded', 'ok');
      await reloadLead();
    } }]
  });
}
