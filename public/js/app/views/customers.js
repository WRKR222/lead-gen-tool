import { state, api, esc, $, $$, label, money, moneyShort, dateOnly, toast, busy, openDialog, formValues, fileToUpload, reasonOptions } from '../core.js';
import { statTiles, columnChart, barChart } from '../charts.js';

export async function render(root) {
  const [stats, list] = await Promise.all([api('/customers/stats'), api('/customers')]);
  const cur = state.workspace.currency;
  root.innerHTML = `
    <div class="page-head"><div><div class="kicker">Customers & churn</div><h1>Customers</h1>
      <p>Your current customers, and every one you lose - with why. Churn is calculated monthly, and the reasons teach the AI what to fix (see Analytics → Learning).</p></div>
      <div class="row"><button class="btn btn-secondary" id="addCustomer">Add customer</button><button class="btn btn-secondary" id="countLoss">Record lost customers (count)</button></div></div>
    <div id="tiles"></div>
    <div class="grid2" style="margin-top:16px"><div id="churnChart"></div><div id="reasons"></div></div>
    <div class="grid2" style="margin-top:16px">
      <div class="card"><h3>Import your customer list</h3><p class="sub">Excel (.xlsx) or CSV. Columns such as name, email, phone, tier/package, value, customer since, status are picked up automatically; rows marked lost/churned count as losses.</p>
        <div class="row"><input class="input grow" type="file" id="custFile" accept=".xlsx,.csv"/><button class="btn btn-primary" id="importCust">Import</button></div></div>
      <div class="card"><h3>Customers not listed individually</h3><p class="sub">No list? Enter how many customers you have today; record losses against it with the button above.</p>
        <div class="row"><input class="input grow" type="number" min="0" id="baseline" value="${esc(stats.baseline || '')}" placeholder="e.g. 240"/><button class="btn btn-secondary" id="saveBaseline">Save</button></div>
        ${stats.baselineDate ? `<p class="hint">Since ${esc(dateOnly(stats.baselineDate))} · ${esc(stats.unitemizedActive)} still active</p>` : ''}</div></div>
    <div class="section-title">Customer list</div>
    <div class="tablewrap"><table class="table"><thead><tr><th>Customer</th><th>Tier</th><th class="num">Value</th><th>Since</th><th>Status</th><th></th></tr></thead>
      <tbody>${list.map(c => `<tr><td>${esc(c.name)}<div class="cell-meta">${esc([c.contact_name, c.email, c.phone].filter(Boolean).join(' · '))}</div></td>
        <td class="small">${esc(c.tier || '—')}</td><td class="num">${esc(money(c.total_value, cur))}</td><td class="small">${esc(dateOnly(c.acquired_at))}</td>
        <td>${c.status === 'lost' ? `<span class="tag tag-bad">Lost</span><div class="cell-meta">${esc(label(c.lost_reason_category))}${c.lost_reason ? ' - ' + esc(c.lost_reason) : ''}</div>` : '<span class="tag tag-good">Active</span>'}</td>
        <td>${c.status === 'lost' ? `<button class="btn btn-ghost btn-sm" data-back="${esc(c.id)}">They came back</button>` : `<button class="btn btn-secondary btn-sm" data-lost="${esc(c.id)}">Mark lost</button>`}</td></tr>`).join('')
        || '<tr><td colspan="6" class="empty">No customers listed yet - import a list or add one.</td></tr>'}</tbody></table></div>`;

  statTiles($('#tiles', root), [
    { label: 'Active customers', value: stats.totalActive, sub: stats.unitemizedActive ? `${stats.itemizedActive} listed + ${stats.unitemizedActive} counted` : '' },
    { label: 'Churn this month', value: stats.churnRateThisMonth == null ? '—' : `${stats.churnRateThisMonth}%`, sub: `${stats.lostThisMonth} lost` },
    { label: 'New this month', value: stats.acquiredThisMonth },
    { label: 'Active customer value', value: moneyShort(stats.activeCustomerValue, cur), sub: stats.activeMonthlyValue ? `${money(stats.activeMonthlyValue, cur)} / month` : '' }
  ]);
  columnChart($('#churnChart', root), {
    title: 'Monthly churn rate', subtitle: 'Customers lost ÷ customers at the start of the month', x: stats.series.map(s => s.month), values: stats.series.map(s => s.churnRate),
    format: v => `${v}%`, valueHeader: 'Churn', detail: stats.series.map(s => [{ name: 'Lost', value: String(s.lost) }, { name: 'New', value: String(s.acquired) }, { name: 'At start', value: String(s.activeAtStart) }])
  });
  barChart($('#reasons', root), { title: 'Why customers left', valueHeader: 'Customers', rows: stats.reasons.map(r => ({ label: (state.playbook.LOSS_REASONS.find(x => x.key === r.reason) || { label: label(r.reason) }).label, value: r.n })) });

  $('#importCust', root).addEventListener('click', e => busy(e.target, async () => {
    const r = await api('/customers/import', { method: 'POST', body: await fileToUpload($('#custFile', root).files[0]) });
    toast(`Imported ${r.imported} customers${r.errors.length ? ` · ${r.errors.length} rows skipped` : ''}`, r.imported ? 'ok' : 'err');
    await render(root);
  }, 'Importing…'));
  $('#saveBaseline', root).addEventListener('click', e => busy(e.target, async () => { await api('/customers/baseline', { method: 'PUT', body: { count: $('#baseline', root).value } }); toast('Saved', 'ok'); await render(root); }));
  $('#addCustomer', root).addEventListener('click', () => openDialog({
    title: 'Add a customer',
    body: `<div class="field"><label>Name</label><input class="input" name="name" required/></div>
      <div class="row"><div class="field grow"><label>Email</label><input class="input" name="email"/></div><div class="field grow"><label>Phone</label><input class="input" name="phone"/></div></div>
      <div class="row"><div class="field grow"><label>Tier</label><select class="input" name="tier"><option value="">—</option>${(state.workspace.value_pyramid.tiers || []).map(t => `<option>${esc(t.name)}</option>`).join('')}</select></div>
        <div class="field grow"><label>Total value (${esc(cur)})</label><input class="input" type="number" name="totalValue"/></div></div>
      <div class="field"><label>Customer since</label><input class="input" type="date" name="acquiredAt"/></div>`,
    actions: [{ label: 'Add', primary: true, onClick: async (b) => { await api('/customers', { method: 'POST', body: formValues(b) }); await render(root); } }]
  }));
  $('#countLoss', root).addEventListener('click', () => openDialog({
    title: 'Record lost customers',
    body: `<p class="small muted">For customers you don't list by name - reduces the counted total.</p><div class="row"><div class="field" style="flex:0 0 120px"><label>How many</label><input class="input" type="number" min="1" name="count" value="1"/></div>
      <div class="field grow"><label>Main reason</label><select class="input" name="reasonCategory">${reasonOptions('price')}</select></div></div>
      <div class="field"><label>Details</label><textarea class="input" name="reason" rows="2"></textarea></div>`,
    actions: [{ label: 'Record', primary: true, onClick: async (b) => { await api('/customers/lost-count', { method: 'POST', body: formValues(b) }); await render(root); } }]
  }));
  $$('[data-lost]', root).forEach(b => b.addEventListener('click', () => openDialog({
    title: 'Why did we lose this customer?',
    body: `<div class="field"><label>Reason</label><select class="input" name="reasonCategory">${reasonOptions('price')}</select></div><div class="field"><label>Details (what they said)</label><textarea class="input" name="reason" rows="2"></textarea></div><div class="field"><label>When</label><input class="input" type="date" name="lostAt"/></div>`,
    actions: [{ label: 'Mark lost', primary: true, onClick: async (body) => { await api(`/customers/${b.dataset.lost}/lost`, { method: 'POST', body: formValues(body) }); await render(root); } }]
  })));
  $$('[data-back]', root).forEach(b => b.addEventListener('click', () => busy(b, async () => { await api(`/customers/${b.dataset.back}/reactivate`, { method: 'POST' }); await render(root); })));
}
