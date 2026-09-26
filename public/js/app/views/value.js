import { state, api, esc, $, $$, money, label, toast, busy, canEdit, isAgencyWorkspace } from '../core.js';
import { refreshWorkspace } from '../main.js';

export async function render(root) {
  const ws = state.workspace;
  const p = ws.value_pyramid || { tiers: [] };
  const plan = ws.growth_plan || {};
  const cur = p.currency || ws.currency;
  const edit = canEdit();
  const tiers = p.tiers || [];
  root.innerHTML = `
    <div class="page-head"><div><div class="kicker">${isAgencyWorkspace() ? 'Our offer ladder' : 'Value pyramid & growth plan'}</div><h1>Value pyramid</h1>
      <p>The ladder from free value up to lifetime value, priced in ${esc(cur)}. It says what one lead is worth - which sets pipeline value, the price anchor in meeting briefs, and how hard each lead is worth chasing.</p></div>
      ${edit ? '<div class="row"><button class="btn btn-secondary" id="regen">Rebuild with AI</button></div>' : ''}</div>
    <div class="grid2">
      <div class="card"><h3>Pyramid</h3><div class="pyramid" style="margin-top:8px">${[...tiers].reverse().map((t, i) => `
        <div class="pyr-level" style="width:${40 + i * (60 / Math.max(1, tiers.length - 1))}%"><div class="p-name">${esc(t.name)}</div><div class="p-price">${t.key === 'lifetime' ? '+' : ''}${esc(money(t.price, cur))}${t.key === 'free_value' ? ' · the offer that creates the lead' : ''}</div></div>`).join('')}</div>
        <div class="tiles" style="margin-top:14px"><div class="tile"><div class="t-label">Value per customer</div><div class="t-value">${esc(money(p.valuePerCustomer, cur))}</div></div>
          <div class="tile"><div class="t-label">Value per lead</div><div class="t-value">${esc(money(p.valuePerLead, cur))}</div><div class="t-sub">at ${Math.round((p.leadToCustomerRate || 0) * 100)}% lead → customer</div></div></div>
        ${p.notes ? `<p class="hint" style="margin-top:10px">${esc(p.notes)}</p>` : ''}</div>
      <div class="card"><h3>Tiers ${edit ? '<span class="sub">- edit prices and take-up, then save</span>' : ''}</h3>
        <div class="tablewrap"><table class="table"><thead><tr><th>Tier</th><th class="num">Price (${esc(cur)})</th><th class="num">% of customers who buy</th></tr></thead>
          <tbody>${tiers.map((t, i) => `<tr data-i="${i}"><td><input class="input" data-f="name" value="${esc(t.name)}" ${edit ? '' : 'disabled'}/><input class="input small" data-f="description" value="${esc(t.description)}" style="margin-top:4px" ${edit ? '' : 'disabled'}/></td>
            <td class="num"><input class="input" data-f="price" type="number" min="0" value="${esc(t.price)}" style="max-width:130px" ${edit ? '' : 'disabled'}/></td>
            <td class="num"><input class="input" data-f="takeRate" type="number" min="0" max="100" value="${Math.round(t.takeRate * 100)}" style="max-width:90px" ${edit ? '' : 'disabled'}/></td></tr>`).join('')}</tbody></table></div>
        <div class="row" style="margin-top:10px"><label class="small">Leads that become customers (%) <input class="input" id="l2c" type="number" min="0" max="100" value="${Math.round((p.leadToCustomerRate || 0.1) * 100)}" style="max-width:90px;display:inline-block" ${edit ? '' : 'disabled'}/></label>
          ${edit ? '<button class="btn btn-primary" id="savePyr">Save pyramid</button>' : ''}</div></div>
    </div>
    ${plan.funnel ? `
    <div class="section-title">Growth plan - the AI lead-generation funnel</div>
    <div class="grid2">${plan.funnel.map((s, i) => `<div class="card"><div class="kicker">Step ${i + 1}</div><h3>${esc(s.label || label(s.key))}</h3><ul class="small" style="margin:6px 0 0;padding-left:18px">${(s.actions || []).map(a => `<li>${esc(a)}</li>`).join('')}</ul></div>`).join('')}</div>
    <div class="grid2" style="margin-top:16px">
      <div class="card"><h3>Ad plan · ${esc((state.playbook.AD_PLATFORMS.find(x => x.key === plan.platform) || {}).label || plan.platform || '')}</h3>
        ${plan.leadMagnet ? `<p class="small"><b>Lead magnet:</b> ${esc(plan.leadMagnet)}</p>` : ''}
        ${plan.adPlan ? `<p class="small"><b>Objective:</b> ${esc(plan.adPlan.objective || '')}</p><p class="small"><b>Audience:</b> ${esc(plan.adPlan.audience || '')}</p>
          <p class="small"><b>Formats:</b> ${esc((plan.adPlan.formats || []).join(' · '))}</p><p class="small muted">${esc(plan.adPlan.budgetNote || '')}</p>` : ''}</div>
      <div class="card"><h3>AI systems to implement</h3>${(plan.aiSystems || []).map(a => `<div style="margin-bottom:8px"><b class="small">${esc(a.name)}</b><div class="small">${esc(a.what)}</div><div class="small muted">${esc(a.impact)}</div></div>`).join('') || '<p class="empty">None yet.</p>'}</div>
    </div>` : ''}`;

  const save = $('#savePyr', root);
  if (save) save.addEventListener('click', () => busy(save, async () => {
    const next = tiers.map((t, i) => {
      const row = $(`tr[data-i="${i}"]`, root);
      return { key: t.key, name: $('[data-f="name"]', row).value, description: $('[data-f="description"]', row).value, price: Number($('[data-f="price"]', row).value) || 0, takeRate: (Number($('[data-f="takeRate"]', row).value) || 0) / 100 };
    });
    await api('/companies/me/value-pyramid', { method: 'PUT', body: { tiers: next, leadToCustomerRate: (Number($('#l2c', root).value) || 0) / 100, currency: cur, notes: p.notes } });
    toast('Value pyramid saved - lead values updated', 'ok');
    await refreshWorkspace();
    await render(root);
  }));
  const regen = $('#regen', root);
  if (regen) regen.addEventListener('click', () => busy(regen, async () => {
    await api('/companies/me/regenerate', { method: 'POST', body: { parts: ['pyramid', 'plan'] } });
    toast('Rebuilt from the business profile', 'ok');
    await refreshWorkspace();
    await render(root);
  }, 'Rebuilding…'));
}
