import { state, api, esc, $, $$, label, ago, dateTime, leadName, methodLabel, statusTag, toast, busy, formValues } from '../core.js';

let tab = 'email';

export async function render(root) {
  if (state.emailSelection && state.emailSelection.length) tab = 'email';
  root.innerHTML = `
    <div class="page-head"><div><div class="kicker">Outreach</div><h1>Email, follow-ups & replies</h1>
      <p>Send one lightly personalised email to many leads or a bespoke one to each, keep non-responders warm without spamming, and answer replies - with an AI bot for the generic ones.</p></div></div>
    <div class="chips" id="tabs" style="margin-bottom:16px">
      <button class="chip" data-tab="email">Email leads</button><button class="chip" data-tab="followups">Follow-up queue</button><button class="chip" data-tab="inbox">Inbox & AI replies</button></div>
    <div id="tabBody"></div>`;
  $('#tabs', root).addEventListener('click', e => { const b = e.target.closest('[data-tab]'); if (b) { tab = b.dataset.tab; draw(root); } });
  await draw(root);
}

async function draw(root) {
  $$('#tabs .chip', root).forEach(c => c.classList.toggle('on', c.dataset.tab === tab));
  const body = $('#tabBody', root);
  body.innerHTML = '<p class="empty">Loading…</p>';
  if (tab === 'email') return emailTab(body);
  if (tab === 'followups') return followupsTab(body);
  return inboxTab(body);
}

// ---------------- bulk / bespoke email ----------------
async function emailTab(body) {
  const preselected = new Set(state.emailSelection || []);
  state.emailSelection = null;
  body.innerHTML = `<div class="grid2">
    <div class="card"><h3>1 · Who</h3>
      <div class="chips" id="grp"><button class="chip" data-s="new">New</button><button class="chip" data-s="contacted">Contacted</button><button class="chip" data-s="on_fence">On the fence</button><button class="chip" data-s="no_response">Not responded</button><button class="chip" data-s="replied">Replied</button></div>
      <div class="row" style="justify-content:space-between;margin-top:10px"><label class="check small"><input type="checkbox" id="allLeads"/> Select all with an email</label><span class="small muted" id="selCount"></span></div>
      <div id="leadPick" style="max-height:340px;overflow-y:auto;margin-top:8px"></div></div>
    <div class="card"><h3>2 · What</h3>
      <div class="field"><label class="check"><input type="radio" name="mode" value="template" checked/> One email for everyone, lightly personalised (name + a line about each lead)</label>
        <label class="check" style="margin-top:6px"><input type="radio" name="mode" value="bespoke"/> A bespoke AI email for each lead</label></div>
      <div class="field"><label>Goal / offer (optional)</label><textarea class="input" name="goal" rows="3" placeholder="e.g. Invite them for a free smile check this month"></textarea></div>
      <p class="hint">Every email follows the meeting-setting standards and carries an unsubscribe link. Nothing is sent until you review the drafts.</p>
      <button class="btn btn-primary" id="compose">Write drafts</button></div></div>
    <div id="drafts" style="margin-top:16px"></div>`;

  let pool = [];
  const statuses = new Set(preselected.size ? [] : ['new']);
  const pick = $('#leadPick', body);
  const chosen = new Set(preselected);
  async function loadPool() {
    if (preselected.size && !statuses.size) {
      const all = await api('/leads?limit=1000');
      pool = all.filter(l => preselected.has(l.id));
    } else {
      pool = statuses.size ? await api('/leads?limit=1000&status=' + [...statuses].join(',')) : [];
    }
    pick.innerHTML = pool.map(l => `<label class="check small" style="display:flex;padding:4px 0"><input type="checkbox" value="${esc(l.id)}" ${chosen.has(l.id) ? 'checked' : ''} ${l.email ? '' : 'disabled'}/>
      <span>${esc(leadName(l))} <span class="muted">${esc(l.email || 'no email')}</span></span></label>`).join('') || '<p class="empty">Pick a group above.</p>';
    pick.querySelectorAll('input').forEach(cb => cb.addEventListener('change', () => { cb.checked ? chosen.add(cb.value) : chosen.delete(cb.value); count(); }));
    count();
  }
  function count() { $('#selCount', body).textContent = `${chosen.size} selected`; }
  $$('#grp .chip', body).forEach(c => { c.classList.toggle('on', statuses.has(c.dataset.s)); c.addEventListener('click', () => {
    statuses.has(c.dataset.s) ? statuses.delete(c.dataset.s) : statuses.add(c.dataset.s); c.classList.toggle('on'); preselected.clear(); loadPool();
  }); });
  $('#allLeads', body).addEventListener('change', e => { pool.filter(l => l.email).forEach(l => e.target.checked ? chosen.add(l.id) : chosen.delete(l.id)); loadPool(); });
  await loadPool();

  $('#compose', body).addEventListener('click', e => busy(e.target, async () => {
    if (!chosen.size) throw new Error('Select at least one lead');
    const v = formValues(body);
    const r = await api('/outreach/email/compose', { method: 'POST', body: { leadIds: [...chosen], mode: v.mode, goal: v.goal || undefined } });
    drawDrafts($('#drafts', body), r);
  }, 'Writing…'));
}

function drawDrafts(el, r) {
  const drafts = r.drafts;
  el.innerHTML = `<div class="card"><div class="row" style="justify-content:space-between"><h3>3 · Review ${drafts.length} draft${drafts.length === 1 ? '' : 's'}</h3>
      <button class="btn btn-primary" id="sendAll" ${drafts.length ? '' : 'disabled'}>Send ${drafts.length}</button></div>
    ${r.skipped.length ? `<p class="hint">Skipped: ${esc(r.skipped.map(s => `${s.name} (${s.reason})`).join(', '))}</p>` : ''}
    <div class="stack" id="draftList">${drafts.map((d, i) => `<div class="draft" data-i="${i}"><div class="row" style="justify-content:space-between"><b class="small">${esc(d.name)} · ${esc(d.to)}</b><button class="btn btn-ghost btn-sm" data-rm="${i}">Remove</button></div>
      <input class="input" data-f="subject" value="${esc(d.subject)}" style="margin:6px 0"/><textarea class="input" data-f="body" rows="6">${esc(d.body)}</textarea></div>`).join('')}</div></div>`;
  const removed = new Set();
  $$('[data-rm]', el).forEach(b => b.addEventListener('click', () => { removed.add(Number(b.dataset.rm)); b.closest('.draft').remove(); }));
  $('#sendAll', el).addEventListener('click', e => busy(e.target, async () => {
    const payload = drafts.map((d, i) => {
      if (removed.has(i)) return null;
      const box = $(`.draft[data-i="${i}"]`, el);
      return { leadId: d.leadId, subject: $('[data-f="subject"]', box).value, body: $('[data-f="body"]', box).value, mode: d.mode, angle: d.angle };
    }).filter(Boolean);
    const res = await api('/outreach/email/send', { method: 'POST', body: { drafts: payload } });
    const failed = res.results.filter(x => x.status !== 'sent');
    const why = (st) => st === 'skipped_rate_limited' ? 'daily sending limit reached - new domains warm up gradually, send the rest tomorrow' : label(st);
    toast(`${res.sent} of ${res.total} sent${failed.length ? ` · ${failed.length} not sent (${[...new Set(failed.map(f => why(f.status)))].join(', ')})` : ''}`, failed.length ? '' : 'ok');
    el.innerHTML = `<div class="card"><h3>Sent ${res.sent} of ${res.total}</h3><p class="sub">Each lead is now "contacted" and scheduled for a follow-up if they don't reply.</p></div>`;
  }, 'Sending…'));
}

// ---------------- follow-up queue ----------------
async function followupsTab(body) {
  const [due, settings] = await Promise.all([api('/followups/due?limit=200'), api('/companies/me/settings')]);
  const c = settings.cadence;
  body.innerHTML = `<div class="card"><div class="row" style="justify-content:space-between"><div><h3>${due.length} follow-up${due.length === 1 ? '' : 's'} due</h3>
      <p class="sub">Gaps of ${esc(c.intervalsDays.join(', '))} days · max ${esc(c.maxAttempts)} attempts · at most ${esc(c.maxTouchesPer30Days)} touches per 30 days · ${esc(c.minHoursBetweenTouches)}h minimum gap · then every ${esc(c.nurtureIntervalDays)} days. Auto email follow-ups: <b>${settings.autoFollowUpEmails ? 'on' : 'off'}</b> (<a href="#/settings">change</a>).</p></div>
      <div class="row"><button class="btn btn-secondary" id="runTasks">Create tasks</button><button class="btn btn-primary" id="runAll">Send email follow-ups + create tasks</button></div></div>
    <div class="tablewrap" style="margin-top:10px"><table class="table"><thead><tr><th>Lead</th><th>Status</th><th>Attempts</th><th>Last attempt</th><th>Next method</th><th>Due</th></tr></thead>
      <tbody>${due.map(d => `<tr class="clickable" data-lead="${esc(d.lead.id)}"><td>${esc(leadName(d.lead))}</td><td>${statusTag(d.lead.status)}</td><td class="num">${esc(d.attemptsSoFar)}</td>
        <td class="small">${d.lastAttempt ? `${esc(methodLabel(d.lastAttempt.method))} · ${esc(label(d.lastAttempt.result))}` : '—'}</td>
        <td>${d.suggestedMethod ? `<b>${esc(methodLabel(d.suggestedMethod))}</b>` : '<span class="muted">needs a contact</span>'}<div class="cell-meta">${esc(d.reason)}</div></td><td class="small">${esc(ago(d.dueAt))}</td></tr>`).join('')
        || '<tr><td colspan="6" class="empty">Nothing due - every lead is on schedule.</td></tr>'}</tbody></table></div></div>
    <div id="runResult" style="margin-top:12px"></div>`;
  $$('tr[data-lead]', body).forEach(tr => tr.addEventListener('click', () => { location.hash = `#/lead/${tr.dataset.lead}`; }));
  const run = (sendEmails) => async () => {
    const r = await api('/followups/run', { method: 'POST', body: { sendEmails } });
    toast(`${r.emailed} emailed · ${r.tasksCreated} tasks created · ${r.skipped} skipped`, 'ok');
    await followupsTab(body);
  };
  $('#runTasks', body).addEventListener('click', e => busy(e.target, run(false)));
  $('#runAll', body).addEventListener('click', e => busy(e.target, run(true), 'Sending…'));
}

// ---------------- inbox ----------------
async function inboxTab(body) {
  const [items, settings] = await Promise.all([api('/inbox'), api('/companies/me/settings')]);
  body.innerHTML = `<div class="card" style="margin-bottom:14px"><div class="row" style="justify-content:space-between"><div class="small">AI reply bot: <b>${esc({ off: 'off', draft: 'drafts replies for approval', send: 'sends replies automatically' }[settings.autoReplyMode])}</b> · replies arrive in real time from your inbound webhook or IMAP mailbox (<a href="#/settings">set up</a>).</div>
    <button class="btn btn-secondary btn-sm" id="poll">Check mailbox now</button></div></div>
    <div class="stack">${items.map(e => e.status === 'draft' ? `
      <div class="card" data-draft="${esc(e.id)}"><div class="row" style="justify-content:space-between"><b>📝 AI draft reply to ${esc(leadName(e))}</b><span class="small muted">${esc(ago(e.created_at))}</span></div>
        <input class="input" data-f="subject" value="${esc(e.subject || '')}"/><textarea class="input" data-f="body" rows="5">${esc(e.body || '')}</textarea>
        <div class="row"><button class="btn btn-primary btn-sm" data-send="${esc(e.id)}">Send</button><button class="btn btn-ghost btn-sm" data-discard="${esc(e.id)}">Discard</button>
        ${e.lead_id ? `<a class="btn btn-ghost btn-sm" href="#/lead/${esc(e.lead_id)}">Open lead</a>` : ''}</div></div>` : `
      <div class="card"><div class="row" style="justify-content:space-between"><b>📨 ${esc(e.lead_id ? leadName(e) : e.from_addr)}</b><span class="small muted">${esc(dateTime(e.received_at))}</span></div>
        <div class="row small">${e.classification ? `<span class="tag tag-accent">${esc(label(e.classification))}</span>` : ''}<span class="muted">${esc(e.subject || '')}</span></div>
        <p class="pre">${esc(e.body || '')}</p>${e.lead_id ? `<div><a class="btn btn-ghost btn-sm" href="#/lead/${esc(e.lead_id)}">Open lead</a></div>` : '<p class="hint">Not matched to a lead.</p>'}</div>`).join('')
      || '<p class="empty">No replies yet. Open a lead and use "Simulate a reply" to try the flow.</p>'}</div>`;
  $('#poll', body).addEventListener('click', e => busy(e.target, async () => { const r = await api('/inbox/poll', { method: 'POST' }); toast(`Checked mailbox · ${r.processed || 0} new`, 'ok'); await inboxTab(body); }));
  $$('[data-send]', body).forEach(b => b.addEventListener('click', () => busy(b, async () => {
    const card = b.closest('[data-draft]');
    const r = await api(`/inbox/${b.dataset.send}/send`, { method: 'POST', body: { subject: $('[data-f="subject"]', card).value, body: $('[data-f="body"]', card).value } });
    toast(r.status === 'sent' ? 'Reply sent' : r.status === 'skipped_rate_limited' ? 'Not sent: daily sending limit reached (domain warm-up) - try again tomorrow' : `Not sent: ${label(r.status)}`, r.status === 'sent' ? 'ok' : 'err');
    await inboxTab(body);
  })));
  $$('[data-discard]', body).forEach(b => b.addEventListener('click', () => busy(b, async () => { await api(`/inbox/${b.dataset.discard}`, { method: 'DELETE' }); await inboxTab(body); })));
}
