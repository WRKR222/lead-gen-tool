import { state, api, esc, $, $$, label, money, dateOnly, toast, busy, openDialog, formValues, fileToUpload, canEdit } from '../core.js';
import { healthMeter } from '../charts.js';
import { switchWorkspace, refreshWorkspace } from '../main.js';

const STATUSES = ['onboarding', 'active', 'at_risk', 'paused', 'churned'];

export async function render(root) {
  const [clients, settings] = await Promise.all([api('/workspaces/clients'), api('/companies/me/settings')]);
  const link = `${location.origin}/register.html?agency=${encodeURIComponent(settings.slug)}`;
  const live = clients.filter(c => c.client_status !== 'churned');
  const mrr = live.reduce((s, c) => s + (c.monthly_retainer || 0), 0);
  root.innerHTML = `
    <div class="page-head"><div><div class="kicker">Stage 3 · Get results</div><h1>Clients</h1>
      <p>Every company that hired the agency. Watch health every week - a client whose leads or meetings drop is flagged at risk before they leave. ${live.length} live · ${esc(money(mrr, state.home.currency))} monthly retainers.</p></div>
      <div class="row">${canEdit() ? '<button class="btn btn-primary" id="addClient">Add client</button>' : ''}</div></div>
    <div class="card" style="margin-bottom:16px"><div class="row" style="justify-content:space-between"><div class="small"><b>Client signup link</b> - send it to a new client so they register under ${esc(state.home.name)} and upload their business profile:<br><code>${esc(link)}</code></div>
      <button class="btn btn-secondary btn-sm" id="copyLink">Copy link</button></div></div>
    <div class="tablewrap"><table class="table"><thead><tr><th>Client</th><th>Status</th><th>Health (30 days)</th><th>Services</th><th class="num">Retainer</th><th class="num">Value / lead</th><th></th></tr></thead>
      <tbody>${clients.map(c => `<tr>
        <td><b>${esc(c.name)}</b><div class="cell-meta">${esc([c.industry, c.home_city, c.target_market === 'b2c' ? 'B2C' : 'B2B', c.client_since ? 'since ' + dateOnly(c.client_since) : ''].filter(Boolean).join(' · '))}</div></td>
        <td><span class="tag ${c.client_status === 'churned' ? 'tag-bad' : c.client_status === 'at_risk' ? 'tag-warn' : c.client_status === 'active' ? 'tag-good' : 'tag-neutral'}">${esc(label(c.client_status))}</span>${c.churn_reason ? `<div class="cell-meta">${esc(c.churn_reason)}</div>` : ''}</td>
        <td style="min-width:170px">${healthMeter(c.health)}${c.health ? `<div class="cell-meta">${esc(c.health.last30.leadsNew)} leads · ${esc(c.health.last30.meetings)} meetings · ${esc(c.health.last30.conversions)} won</div>` : ''}</td>
        <td class="small">${esc(c.services.map(s => (state.playbook.SERVICES.find(x => x.key === s) || { label: s }).label).join(', ') || '—')}${c.ad_platform ? `<div class="cell-meta">Ads: ${esc((state.playbook.AD_PLATFORMS.find(p => p.key === c.ad_platform) || {}).label || c.ad_platform)}</div>` : ''}</td>
        <td class="num">${esc(money(c.monthly_retainer, state.home.currency))}</td>
        <td class="num">${esc(money(c.value_per_lead, c.currency))}</td>
        <td><div class="row" style="flex-wrap:nowrap"><button class="btn btn-primary btn-sm" data-open="${esc(c.id)}">Open</button>
          ${canEdit() ? `<button class="btn btn-secondary btn-sm" data-edit="${esc(c.id)}">Edit</button><button class="btn btn-ghost btn-sm" data-invite="${esc(c.id)}">Invite login</button>` : ''}</div></td></tr>`).join('')
        || '<tr><td colspan="7" class="empty">No clients yet. Add one, or sign a prospect from its lead page.</td></tr>'}</tbody></table></div>`;

  $('#copyLink', root).addEventListener('click', async () => { try { await navigator.clipboard.writeText(link); toast('Link copied', 'ok'); } catch { toast('Copy blocked - select the link instead', 'err'); } });
  const add = $('#addClient', root); if (add) add.addEventListener('click', () => addClientDialog(root));
  $$('[data-open]', root).forEach(b => b.addEventListener('click', () => switchWorkspace(b.dataset.open)));
  $$('[data-edit]', root).forEach(b => b.addEventListener('click', () => editDialog(clients.find(c => c.id === b.dataset.edit), root)));
  $$('[data-invite]', root).forEach(b => b.addEventListener('click', () => inviteDialog(clients.find(c => c.id === b.dataset.invite))));
}

export function clientFormFields(c = {}, { retainer = true } = {}) {
  const pb = state.playbook;
  const svc = c.services || pb.SERVICES.map(s => s.key);
  return `
    <div class="row"><div class="field grow"><label>Their leads are</label><select class="input" name="targetMarket"><option value="b2b" ${c.target_market === 'b2c' ? '' : 'selected'}>Businesses (B2B)</option><option value="b2c" ${c.target_market === 'b2c' ? 'selected' : ''}>People (B2C, e.g. patients)</option></select></div>
      ${retainer ? `<div class="field grow"><label>Monthly retainer (${esc(state.home.currency)})</label><input class="input" type="number" min="0" name="monthlyRetainer" value="${esc(c.monthly_retainer ?? '')}"/></div>` : ''}</div>
    <div class="field"><span class="lbl">Services</span>${pb.SERVICES.map(s => `<label class="check" style="margin-right:12px"><input type="checkbox" name="services" value="${s.key}" ${svc.includes(s.key) ? 'checked' : ''}/> ${esc(s.label)}</label>`).join('')}</div>
    <div class="field"><span class="lbl">One ad platform (keeps it simple for the client)</span>${pb.AD_PLATFORMS.map((p, i) => `<label class="check" style="margin-right:12px"><input type="radio" name="adPlatform" value="${p.key}" ${(c.ad_platform ? c.ad_platform === p.key : i === 0) ? 'checked' : ''}/> ${esc(p.label)}</label>`).join('')}</div>`;
}

function addClientDialog(root) {
  openDialog({
    title: 'Add a client',
    body: `<div class="field"><label>Company name</label><input class="input" name="name" required/></div>
      <div class="field"><label>What they do, and what they want from us</label><textarea class="input" name="description" rows="3" placeholder="e.g. Family dental clinic in Westlands. Wants 40 new patients a month for cleaning, whitening and Invisalign."></textarea></div>
      <div class="row"><div class="field grow"><label>Industry</label><input class="input" name="industry"/></div><div class="field grow"><label>Website</label><input class="input" name="website"/></div></div>
      <div class="row"><div class="field grow"><label>Country (sets their currency)</label>${countrySelect('homeCountry', state.home.home_country)}</div><div class="field grow"><label>City</label><input class="input" name="homeCity" value="${esc(state.home.home_city || '')}"/></div></div>
      ${clientFormFields()}
      <div class="row"><div class="field grow"><label>Current number of customers</label><input class="input" type="number" min="0" name="baselineCustomerCount"/></div></div>
      <div class="field"><label>Business profile (Word .docx or PDF) - optional, makes the AI much sharper</label><input class="input" type="file" name="profile" accept=".docx,.pdf,.txt"/></div>
      <p class="hint">The AI builds their profile, a value pyramid in their local currency and a growth plan. This takes a few seconds.</p>`,
    actions: [{ label: 'Create client', primary: true, onClick: async (body) => {
      const v = formValues(body);
      if (!v.name) throw new Error('Company name is required');
      const file = body.querySelector('[name="profile"]').files[0];
      const c = await api('/workspaces/clients', { method: 'POST', body: { ...v, businessProfile: file ? await fileToUpload(file) : undefined } });
      toast(`${c.name} added`, 'ok');
      await refreshWorkspace();
      await render(root);
    } }]
  });
}

function editDialog(c, root) {
  openDialog({
    title: `Edit ${c.name}`,
    body: `<div class="field"><label>Status</label><select class="input" name="clientStatus">${STATUSES.map(s => `<option value="${s}" ${s === c.client_status ? 'selected' : ''}>${esc(label(s))}</option>`).join('')}</select></div>
      <div id="churnFields" ${c.client_status === 'churned' ? '' : 'hidden'}><div class="field"><label>Why did we lose them?</label><select class="input" name="churnReasonCategory">${state.playbook.LOSS_REASONS.map(r => `<option value="${r.key}">${esc(r.label)}</option>`).join('')}</select></div>
        <div class="field"><label>In their words</label><textarea class="input" name="churnReason" rows="2">${esc(c.churn_reason || '')}</textarea></div></div>
      ${clientFormFields(c)}`,
    actions: [{ label: 'Save', primary: true, onClick: async (body) => {
      await api(`/workspaces/clients/${c.id}`, { method: 'PATCH', body: formValues(body) });
      toast('Saved', 'ok');
      await refreshWorkspace();
      await render(root);
    } }]
  });
  const sel = document.querySelector('#dialogBody [name="clientStatus"]');
  sel.addEventListener('change', () => { document.querySelector('#churnFields').hidden = sel.value !== 'churned'; });
}

function inviteDialog(c) {
  openDialog({
    title: `Give ${c.name} a login`,
    body: `<p class="small muted">They'll see only their own workspace: leads, outreach, customers & churn, value pyramid and analytics.</p>
      <div class="field"><label>Name</label><input class="input" name="name" required/></div><div class="field"><label>Email</label><input class="input" type="email" name="email" required/></div>
      <div class="field"><label>Temporary password (8+ characters)</label><input class="input" name="password" minlength="8" required/></div>`,
    actions: [{ label: 'Create login', primary: true, onClick: async (body) => { const u = await api(`/workspaces/clients/${c.id}/invite`, { method: 'POST', body: formValues(body) }); toast(`Login created for ${u.email}`, 'ok'); } }]
  });
}

const COUNTRIES = [['KE', 'Kenya'], ['UG', 'Uganda'], ['TZ', 'Tanzania'], ['RW', 'Rwanda'], ['ET', 'Ethiopia'], ['NG', 'Nigeria'], ['GH', 'Ghana'], ['ZA', 'South Africa'], ['EG', 'Egypt'],
  ['US', 'United States'], ['GB', 'United Kingdom'], ['DE', 'Germany'], ['FR', 'France'], ['AE', 'United Arab Emirates'], ['IN', 'India'], ['CA', 'Canada'], ['AU', 'Australia']];
export function countrySelect(name, selected) {
  return `<select class="input" name="${name}">${COUNTRIES.map(([k, l]) => `<option value="${k}" ${k === selected ? 'selected' : ''}>${esc(l)}</option>`).join('')}</select>`;
}
