import { state, api, esc, money, moneyShort, pct, leadName, methodLabel, ago, label } from '../core.js';
import { statTiles, barChart, healthMeter } from '../charts.js';
import { switchWorkspace } from '../main.js';

export async function render(root) {
  return state.workspace.kind === 'agency' ? renderAgency(root) : renderClient(root);
}

async function renderAgency(root) {
  const [ag, due] = await Promise.all([api('/analytics/agency?days=30'), api('/followups/due?limit=6')]);
  const c = ag.clients;
  root.innerHTML = `
    <div class="page-head"><div><div class="kicker">Agency overview · last 30 days</div><h1>${esc(state.workspace.name)}</h1>
      <p>Three stages to success: find clients, sign them, then get them results - and keep them.</p></div>
      <div class="row"><a class="btn btn-primary" href="#/leads">Find clients</a><a class="btn btn-secondary" href="#/clients">Add a client</a></div></div>
    <div class="stage-strip">${ag.stages.map((s, i) => `
      <a class="stage" href="${['#/leads', '#/meetings', '#/clients'][i]}"><div class="s-step">Stage ${i + 1}</div><div class="card-title">${esc(s.label)}</div>
        <div class="s-n">${esc(s.n)}</div><div class="small muted">${esc(s.detail)}</div></a>`).join('')}</div>
    <div class="section-title">Clients</div>
    <div id="tiles"></div>
    <div class="grid2" style="margin-top:16px">
      <div class="card"><div class="row" style="justify-content:space-between"><h3>Client health</h3><a class="small" href="#/clients">All clients →</a></div>
        <div class="tablewrap"><table class="table"><thead><tr><th>Client</th><th>Health</th><th class="num">Leads</th><th class="num">Meetings</th></tr></thead>
        <tbody>${ag.delivered.perClient.map(p => {
          const h = (state.clientsHealth || {})[p.clientId];
          return `<tr><td><a href="#" data-open="${esc(p.clientId)}">${esc(p.name)}</a><div class="cell-meta">${esc(label(p.status))}</div></td><td style="min-width:130px" data-health="${esc(p.clientId)}">${h ? healthMeter(h) : '…'}</td>
            <td class="num">${esc(p.leads)}</td><td class="num">${esc(p.meetings)}</td></tr>`;
        }).join('') || '<tr><td colspan="4" class="empty">No clients yet - sign your first one from Prospects.</td></tr>'}</tbody></table></div></div>
      <div class="card"><div class="row" style="justify-content:space-between"><h3>Prospect follow-ups due</h3><a class="small" href="#/outreach">Follow-up queue →</a></div>
        ${due.length ? `<div class="timeline">${due.map(d => `<a class="tl-item" href="#/lead/${esc(d.lead.id)}"><span class="dot"></span><div>${esc(leadName(d.lead))}
          <div class="when">${esc(d.suggestedMethod ? methodLabel(d.suggestedMethod) : 'needs a contact')} · due ${esc(ago(d.dueAt))}</div></div></a>`).join('')}</div>`
          : '<p class="empty">Nothing due - every prospect is on schedule.</p>'}</div>
    </div>
    <div class="grid2" style="margin-top:16px"><div id="churnReasons"></div><div id="delivered"></div></div>`;

  statTiles(root.querySelector('#tiles'), [
    { label: 'Live clients', value: c.active, sub: `${c.total} signed in total` },
    { label: 'Monthly retainers', value: moneyShort(c.mrr, ag.currency) },
    { label: 'Client churn this month', value: pct(c.churnRateThisMonth), sub: `${c.churnSeries[c.churnSeries.length - 1].lost} lost this month` },
    { label: 'Leads delivered', value: ag.delivered.totals.leads, sub: 'all clients, 30 days' },
    { label: 'Meetings delivered', value: ag.delivered.totals.meetings },
    { label: 'Conversions delivered', value: ag.delivered.totals.conversions }
  ]);
  barChart(root.querySelector('#churnReasons'), {
    title: 'Why clients left', subtitle: 'Reasons recorded when a client churned', valueHeader: 'Clients',
    rows: c.churnReasons.map(r => ({ label: reasonLabel(r.reason), value: r.n }))
  });
  barChart(root.querySelector('#delivered'), {
    title: 'Meetings delivered per client', subtitle: 'Last 30 days', valueHeader: 'Meetings',
    rows: ag.delivered.perClient.map(p => ({ label: p.name, value: p.meetings, detail: [{ name: 'Leads', value: String(p.leads) }, { name: 'Conversions', value: String(p.conversions) }] }))
  });
  root.querySelectorAll('[data-open]').forEach(b => b.addEventListener('click', (e) => { e.preventDefault(); switchWorkspace(b.dataset.open); }));
  // Health scores come with the clients list; fill them in once it arrives.
  api('/workspaces/clients').then(list => {
    state.clientsHealth = Object.fromEntries(list.map(x => [x.id, x.health]));
    root.querySelectorAll('[data-health]').forEach(td => { td.innerHTML = healthMeter(state.clientsHealth[td.dataset.health]); });
  }).catch(() => {});
}

function reasonLabel(key) {
  const r = state.playbook.LOSS_REASONS.find(x => x.key === key);
  return r ? r.label : label(key);
}

async function renderClient(root) {
  const [o, due] = await Promise.all([api('/analytics/overview?days=30'), api('/followups/due?limit=6')]);
  const ws = state.workspace;
  const services = (ws.services || []).map(k => (state.playbook.SERVICES.find(s => s.key === k) || { label: k }).label);
  const platform = state.playbook.AD_PLATFORMS.find(p => p.key === ws.ad_platform);
  root.innerHTML = `
    <div class="page-head"><div><div class="kicker">${state.isAgencyUser ? 'Client workspace' : 'Your workspace'} · last 30 days</div><h1>${esc(ws.name)}</h1>
      <p>${esc([ws.industry, ws.home_city, ws.target_market === 'b2c' ? 'Leads are people (B2C)' : 'Leads are businesses (B2B)'].filter(Boolean).join(' · '))}</p>
      <div class="chips" style="margin-top:8px">${services.map(s => `<span class="tag tag-accent">${esc(s)}</span>`).join('')}${platform ? `<span class="tag tag-outline">Ads: ${esc(platform.label)}</span>` : ''}</div></div>
      <div class="row"><a class="btn btn-primary" href="#/leads">Find leads</a><a class="btn btn-secondary" href="#/outreach">Email leads</a></div></div>
    <div id="tiles"></div>
    <div class="grid2" style="margin-top:16px"><div id="funnel"></div>
      <div class="card"><div class="row" style="justify-content:space-between"><h3>Follow-ups due</h3><a class="small" href="#/outreach">Queue →</a></div>
        ${due.length ? `<div class="timeline">${due.map(d => `<a class="tl-item" href="#/lead/${esc(d.lead.id)}"><span class="dot"></span><div>${esc(leadName(d.lead))}
          <div class="when">${esc(d.suggestedMethod ? methodLabel(d.suggestedMethod) : 'needs a contact')} · ${esc(d.reason)}</div></div></a>`).join('')}</div>`
          : '<p class="empty">Nothing due right now.</p>'}</div></div>
    <div class="grid2" style="margin-top:16px"><div id="outcomes"></div><div id="methods"></div></div>`;
  statTiles(root.querySelector('#tiles'), [
    { label: 'Leads generated', value: o.funnel[0].n, sub: `${o.leads.total} in total` },
    { label: 'Response rate', value: pct(o.rates.responseRate), sub: `${o.funnel[2].n} of ${o.funnel[1].n} contacted` },
    { label: 'Meetings booked', value: o.funnel[3].n },
    { label: 'Converted', value: o.funnel[4].n, sub: money(o.value.wonValue, o.value.currency) + ' won' },
    { label: 'Pipeline value', value: moneyShort(o.value.pipelineValue, o.value.currency), sub: `${money(o.value.valuePerLead, o.value.currency)} per lead` },
    { label: 'Active customers', value: o.customers.totalActive, sub: `churn ${pct(o.customers.churnRateThisMonth)} this month` }
  ]);
  barChart(root.querySelector('#funnel'), { title: 'Lead funnel', subtitle: 'Last 30 days', valueHeader: 'Leads', rows: o.funnel.map(f => ({ label: f.label, value: f.n })) });
  barChart(root.querySelector('#outcomes'), { title: 'Where contacted leads ended up', subtitle: 'All time', valueHeader: 'Leads', rows: o.leads.outcomes.map(x => ({ label: x.label, value: x.n })) });
  barChart(root.querySelector('#methods'), {
    title: 'Positive responses by method', subtitle: 'Share of attempts that got a reply, interest, meeting or yes', valueHeader: 'Success rate', format: v => `${v}%`,
    rows: o.methods.map(m => ({ label: m.label, value: m.successRate || 0, display: m.attempts ? `${m.successRate}%` : 'no attempts', detail: [{ name: 'Attempts', value: String(m.attempts) }, { name: 'Meetings', value: String(m.meetings) }] }))
  });
}
