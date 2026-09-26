import { state, api, esc, $, label, dateTime, toast, busy, formValues, fileToUpload, canEdit, isAgencyWorkspace } from '../core.js';
import { clientFormFields, countrySelect } from './clients.js';
import { refreshWorkspace } from '../main.js';

export async function render(root) {
  const ws = state.workspace;
  const [s, integ] = await Promise.all([api('/companies/me/settings'), api('/integrations')]);
  const edit = canEdit();
  const base = location.origin + '/api/inbound';
  root.innerHTML = `
    <div class="page-head"><div><div class="kicker">Settings</div><h1>${esc(ws.name)}</h1><p>${isAgencyWorkspace() ? 'Agency workspace' : 'Client workspace'} · prices in ${esc(ws.currency)}</p></div></div>
    <div class="grid2">
      <form class="card" id="profileForm"><h3>Business profile</h3>
        <div class="field"><label>Name</label><input class="input" name="name" value="${esc(ws.name)}" ${edit ? '' : 'disabled'}/></div>
        <div class="field"><label>What the business does and wants</label><textarea class="input" name="description" rows="4" ${edit ? '' : 'disabled'}>${esc(ws.description || '')}</textarea></div>
        <div class="row"><div class="field grow"><label>Industry</label><input class="input" name="industry" value="${esc(ws.industry || '')}"/></div><div class="field grow"><label>Website</label><input class="input" name="website" value="${esc(ws.website || '')}"/></div></div>
        <div class="row"><div class="field grow"><label>Country (sets currency)</label>${countrySelect('homeCountry', ws.home_country)}</div><div class="field grow"><label>City</label><input class="input" name="homeCity" value="${esc(ws.home_city || '')}"/></div></div>
        ${isAgencyWorkspace() ? '' : clientFormFields(ws, { retainer: false })}
        ${edit ? '<div class="row"><button class="btn btn-primary" type="submit">Save</button><label class="check small"><input type="checkbox" name="regenerate"/> Also rebuild AI profile, pyramid & plan</label></div>' : ''}</form>
      <div class="stack">
        <div class="card"><h3>Business profile document</h3><p class="sub">Upload the company profile (Word .docx or PDF). Its content feeds every AI generation: ideal customers, value pyramid, scripts and emails.</p>
          ${ws.has_business_profile ? `<p class="small">Current: <b>${esc(ws.business_profile_filename || 'uploaded')}</b> · ${esc(ws.business_profile_chars.toLocaleString())} characters · ${esc(dateTime(ws.business_profile_uploaded_at))}</p>` : '<p class="small muted">None uploaded yet.</p>'}
          ${edit ? '<div class="row"><input class="input grow" type="file" id="bp" accept=".docx,.pdf,.txt"/><button class="btn btn-secondary" id="bpBtn">Upload & re-analyse</button></div>' : ''}</div>
        <form class="card" id="opsForm"><h3>Replies & follow-ups</h3>
          <div class="field"><label>AI reply bot for generic replies</label><select class="input" name="autoReplyMode"><option value="off">Off</option><option value="draft">Draft replies for approval (recommended)</option><option value="send">Send replies automatically</option></select></div>
          <label class="check"><input type="checkbox" name="autoFollowUpEmails" ${s.autoFollowUpEmails ? 'checked' : ''}/> Send email follow-ups automatically to non-responders</label>
          <div class="field" style="margin-top:10px"><label>Meeting booking link (added to emails and replies)</label><input class="input" name="bookingLink" value="${esc(s.bookingLink || '')}" placeholder="https://…"/></div>
          <div class="row"><div class="field grow"><label>Monthly lead target</label><input class="input" type="number" name="monthlyLeadTarget" value="${esc(s.monthlyLeadTarget)}"/></div><div class="field grow"><label>Monthly meeting target</label><input class="input" type="number" name="monthlyMeetingTarget" value="${esc(s.monthlyMeetingTarget)}"/></div></div>
          <div class="row"><div class="field grow"><label>Follow-up gaps (days)</label><input class="input" name="intervals" value="${esc(s.cadence.intervalsDays.join(', '))}"/></div><div class="field" style="flex:0 0 110px"><label>Max attempts</label><input class="input" type="number" name="maxAttempts" value="${esc(s.cadence.maxAttempts)}"/></div></div>
          <div class="row"><div class="field grow"><label>Max touches / 30 days</label><input class="input" type="number" name="maxTouchesPer30Days" value="${esc(s.cadence.maxTouchesPer30Days)}"/></div><div class="field grow"><label>Min hours between touches</label><input class="input" type="number" name="minHoursBetweenTouches" value="${esc(s.cadence.minHoursBetweenTouches)}"/></div><div class="field grow"><label>Then every (days)</label><input class="input" type="number" name="nurtureIntervalDays" value="${esc(s.cadence.nurtureIntervalDays)}"/></div></div>
          ${edit ? '<button class="btn btn-primary" type="submit">Save</button>' : ''}</form>
      </div></div>
    <div class="grid2" style="margin-top:16px">
      <form class="card" id="integForm"><h3>AI tools</h3>
        <label class="check"><input type="checkbox" name="hlEnabled" ${s.highlevel.enabled ? 'checked' : ''}/> <b>HighLevel</b> - CRM, pipelines & calendar booking</label>
        <div class="field" style="margin-top:6px"><label>HighLevel location (sub-account) ID</label><input class="input" name="locationId" value="${esc(s.highlevel.locationId || '')}"/>
          <p class="hint">${integ.highlevel.configured ? '✓ Ready' : 'Needs HIGHLEVEL_API_KEY on the server plus this location ID.'}</p></div>
        <label class="check"><input type="checkbox" name="awEnabled" ${s.appointwise.enabled ? 'checked' : ''}/> <b>Appointwise</b> - AI appointment setting</label>
        <div class="field" style="margin-top:6px"><label>Appointwise inbound webhook URL (https)</label><input class="input" name="webhookUrl" value="${esc(s.appointwise.webhookUrl || '')}"/></div>
        ${edit ? '<button class="btn btn-primary" type="submit">Save</button>' : ''}
        ${integ.recent.length ? `<div class="divider"></div><b class="small">Recent pushes</b>${integ.recent.slice(0, 6).map(r => `<div class="small muted">${esc(label(r.provider))} · ${esc(r.status)} · ${esc(dateTime(r.created_at))}</div>`).join('')}` : ''}</form>
      <div class="card"><h3>Inbound webhooks</h3><p class="sub">Keep these secret - the token authenticates them.</p>
        <div class="field"><label>Replies from leads (Postmark inbound, Mailgun routes, or any JSON/form forwarder)</label><input class="input" readonly value="${esc(base)}/email/${esc(s.inboundToken)}"/></div>
        <div class="field"><label>New leads from ad lead forms (Meta / TikTok via Zapier/Make, Google Ads lead-form webhook) or website forms</label><input class="input" readonly value="${esc(base)}/lead/${esc(s.inboundToken)}"/></div>
        <p class="hint">Or connect a mailbox over IMAP on the server (IMAP_HOST / IMAP_USER / IMAP_PASS) - replies then appear in real time without a webhook.</p></div>
    </div>
    <div class="section-title">AI profile (ideal customers, outreach, brand)</div>
    <pre class="pre" style="max-height:360px;overflow:auto">${esc(JSON.stringify(ws.directions, null, 2))}</pre>`;

  $('#opsForm [name="autoReplyMode"]', root).value = s.autoReplyMode;
  $('#profileForm', root).addEventListener('submit', e => { e.preventDefault(); busy(e.submitter, async () => {
    await api('/companies/me', { method: 'PUT', body: formValues(e.target) });
    await refreshWorkspace(); toast('Saved', 'ok'); await render(root);
  }, 'Saving…'); });
  const bp = $('#bpBtn', root);
  if (bp) bp.addEventListener('click', () => busy(bp, async () => {
    const r = await api('/companies/me/business-profile', { method: 'POST', body: await fileToUpload($('#bp', root).files[0]) });
    toast(`Read ${r.chars.toLocaleString()} characters${r.pages ? ` from ${r.pages} pages` : ''} - profile, pyramid and plan rebuilt`, 'ok');
    await refreshWorkspace(); await render(root);
  }, 'Analysing…'));
  $('#opsForm', root).addEventListener('submit', e => { e.preventDefault(); busy(e.submitter, async () => {
    const v = formValues(e.target);
    await api('/companies/me/settings', { method: 'PUT', body: {
      autoReplyMode: v.autoReplyMode, autoFollowUpEmails: v.autoFollowUpEmails, bookingLink: v.bookingLink.trim(),
      monthlyLeadTarget: v.monthlyLeadTarget, monthlyMeetingTarget: v.monthlyMeetingTarget,
      cadence: { intervalsDays: v.intervals.split(/[,\s]+/).filter(Boolean).map(Number), maxAttempts: v.maxAttempts, maxTouchesPer30Days: v.maxTouchesPer30Days, minHoursBetweenTouches: v.minHoursBetweenTouches, nurtureIntervalDays: v.nurtureIntervalDays }
    } });
    toast('Saved', 'ok');
  }, 'Saving…'); });
  $('#integForm', root).addEventListener('submit', e => { e.preventDefault(); busy(e.submitter, async () => {
    const v = formValues(e.target);
    await api('/companies/me/settings', { method: 'PUT', body: { highlevel: { enabled: v.hlEnabled, locationId: v.locationId }, appointwise: { enabled: v.awEnabled, webhookUrl: v.webhookUrl } } });
    toast('Saved', 'ok'); await render(root);
  }, 'Saving…'); });
}
