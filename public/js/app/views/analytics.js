import { state, api, esc, $, $$, label, money, moneyShort, pct, dateTime, busy, toast, isAgencyWorkspace } from '../core.js';
import { statTiles, barChart, lineChart, columnChart } from '../charts.js';

let days = 30;
let granularity = 'day';
let period = 'month';

export async function render(root) {
  root.innerHTML = `
    <div class="page-head"><div><div class="kicker">Analytics</div><h1>Lead & sales analytics</h1>
      <p>Everything below follows the range you pick here.</p></div></div>
    <div class="toolbar"><div class="chips" id="range">${[7, 30, 90].map(d => `<button class="chip ${d === days ? 'on' : ''}" data-d="${d}">Last ${d} days</button>`).join('')}</div>
      <div class="chips" id="gran"><button class="chip ${granularity === 'day' ? 'on' : ''}" data-g="day">Daily trend</button><button class="chip ${granularity === 'month' ? 'on' : ''}" data-g="month">Monthly trend</button></div></div>
    <div id="body"><p class="empty">Loading…</p></div>`;
  $('#range', root).addEventListener('click', e => { const b = e.target.closest('[data-d]'); if (!b) return; days = Number(b.dataset.d); $$('#range .chip', root).forEach(c => c.classList.toggle('on', c === b)); draw(root); });
  $('#gran', root).addEventListener('click', e => { const b = e.target.closest('[data-g]'); if (!b) return; granularity = b.dataset.g; $$('#gran .chip', root).forEach(c => c.classList.toggle('on', c === b)); draw(root); });
  await draw(root);
}

async function draw(root) {
  const body = $('#body', root);
  body.style.opacity = body.children.length > 1 ? '0.55' : '1';
  const agency = isAgencyWorkspace();
  const points = granularity === 'month' ? 6 : Math.min(days, 90);
  const [o, ts, learning, ag] = await Promise.all([
    api(`/analytics/overview?days=${days}`), api(`/analytics/timeseries?granularity=${granularity}&points=${points}`), api('/analytics/learning'),
    agency ? api(`/analytics/agency?days=${days}`) : Promise.resolve(null)
  ]);
  body.style.opacity = '1';
  const cur = o.value.currency;
  body.innerHTML = `
    <div id="tiles"></div>
    <div class="card" style="margin-top:16px" id="summary"></div>
    <div id="trend" style="margin-top:16px"></div>
    <div class="grid2" style="margin-top:16px"><div id="funnel"></div><div id="methods"></div></div>
    <div class="grid2" style="margin-top:16px"><div id="standards"></div><div id="loss"></div></div>
    ${agency ? '<div class="section-title">Agency · clients</div><div id="agTiles"></div><div class="grid2" style="margin-top:16px"><div id="clientChurn"></div><div id="clientReasons"></div></div>'
      : '<div class="grid2" style="margin-top:16px"><div id="custChurn"></div><div id="custReasons"></div></div>'}
    <div class="card" style="margin-top:16px" id="learning"></div>`;

  statTiles($('#tiles', body), [
    { label: 'Leads generated', value: o.funnel[0].n },
    { label: 'Contacted', value: o.funnel[1].n, sub: `${o.activity.attempts} attempts` },
    { label: 'Response rate', value: pct(o.rates.responseRate) },
    { label: 'Meetings booked', value: o.funnel[3].n, sub: `${pct(o.rates.meetingRate)} of contacted` },
    { label: 'Converted', value: o.funnel[4].n, sub: `${money(o.value.wonValue, cur)} won` },
    { label: 'Email reply rate', value: pct(o.activity.emailReplyRate), sub: `${o.activity.emailReplies} replies / ${o.activity.emailsSent} sent` },
    { label: 'Pipeline value', value: moneyShort(o.value.pipelineValue, cur), sub: `${money(o.value.valuePerLead, cur)} per lead` },
    { label: 'Follow-ups due', value: o.followUpsDue }
  ]);
  await drawSummary($('#summary', body));

  const tsLabels = ts.series.map(s => granularity === 'month' ? s.bucket : s.bucket.slice(5));
  lineChart($('#trend', body), {
    title: granularity === 'month' ? 'Monthly trend' : 'Daily trend', subtitle: 'Counts per ' + granularity, x: tsLabels,
    series: [{ name: 'Leads', values: ts.series.map(s => s.generated) }, { name: 'Attempts', values: ts.series.map(s => s.attempts) },
      { name: 'Meetings', values: ts.series.map(s => s.meetings) }, { name: 'Converted', values: ts.series.map(s => s.converted) }]
  });
  barChart($('#funnel', body), { title: 'Funnel', subtitle: `Last ${days} days`, valueHeader: 'Leads', rows: o.funnel.map(f => ({ label: f.label, value: f.n })) });
  barChart($('#methods', body), {
    title: 'Which method works', subtitle: 'Positive responses per attempt, by method (strongest first in the playbook)', valueHeader: 'Success rate', format: v => `${v}%`,
    rows: o.methods.map(m => ({ label: m.label, value: m.successRate || 0, display: m.attempts ? `${m.successRate}%` : 'no attempts', detail: [{ name: 'Attempts', value: String(m.attempts) }, { name: 'Meetings', value: String(m.meetings) }, { name: 'Decision maker reached', value: m.decisionMakerRate == null ? '—' : `${m.decisionMakerRate}%` }] }))
  });
  barChart($('#standards', body), {
    title: 'Meeting-setting standards followed', subtitle: `${o.standards.logged} attempts logged by the team`, valueHeader: 'Followed', format: v => `${v}%`,
    rows: o.standards.standards.map(s => ({ label: s.label, value: s.rate || 0, display: s.rate == null ? '—' : `${s.rate}%` }))
  });
  const reasonName = (k) => (state.playbook.LOSS_REASONS.find(x => x.key === k) || { label: label(k) }).label;
  barChart($('#loss', body), { title: 'Why leads said no', valueHeader: 'Leads', rows: o.lossReasons.map(r => ({ label: reasonName(r.reason), value: r.n })) });

  if (agency && ag) {
    statTiles($('#agTiles', body), [
      { label: 'Live clients', value: ag.clients.active }, { label: 'Monthly retainers', value: moneyShort(ag.clients.mrr, ag.currency) },
      { label: 'Client churn this month', value: pct(ag.clients.churnRateThisMonth) },
      { label: 'Meetings delivered', value: ag.delivered.totals.meetings, sub: `${ag.delivered.totals.leads} leads, ${ag.delivered.totals.conversions} conversions` }
    ]);
    columnChart($('#clientChurn', body), { title: 'Client churn by month', subtitle: 'Clients lost ÷ clients at the start of the month', x: ag.clients.churnSeries.map(s => s.month), values: ag.clients.churnSeries.map(s => s.churnRate), format: v => `${v}%`, valueHeader: 'Churn',
      detail: ag.clients.churnSeries.map(s => [{ name: 'Lost', value: String(s.lost) }, { name: 'Signed', value: String(s.signed) }]) });
    barChart($('#clientReasons', body), { title: 'Why clients left', valueHeader: 'Clients', rows: ag.clients.churnReasons.map(r => ({ label: reasonName(r.reason), value: r.n })) });
  } else {
    const c = o.customers;
    columnChart($('#custChurn', body), { title: 'Customer churn by month', subtitle: `${c.totalActive} active customers`, x: c.series.map(s => s.month), values: c.series.map(s => s.churnRate), format: v => `${v}%`, valueHeader: 'Churn',
      detail: c.series.map(s => [{ name: 'Lost', value: String(s.lost) }, { name: 'New', value: String(s.acquired) }]) });
    barChart($('#custReasons', body), { title: 'Why customers left', valueHeader: 'Customers', rows: c.reasons.map(r => ({ label: reasonName(r.reason), value: r.n })) });
  }
  drawLearning($('#learning', body), learning);
}

async function drawSummary(el) {
  el.innerHTML = '<p class="empty">Writing the summary…</p>';
  const s = await api(`/analytics/summary?period=${period}`);
  const prevName = period === 'day' ? 'yesterday' : 'last month';
  el.innerHTML = `<div class="row" style="justify-content:space-between"><div><h3>${period === 'day' ? 'Today' : 'This month'} at a glance</h3><p class="sub">${esc(s.key)} · compared with ${prevName}</p></div>
      <div class="row"><div class="chips"><button class="chip ${period === 'day' ? 'on' : ''}" data-p="day">Daily</button><button class="chip ${period === 'month' ? 'on' : ''}" data-p="month">Monthly</button></div>
      <button class="btn btn-ghost btn-sm" id="refreshSum">Refresh</button></div></div>
    <div id="sumTiles" style="margin:12px 0"></div>
    <p>${esc(s.narrative || '')}</p>
    <div class="grid2"><div><b class="small">Highlights</b><ul class="small" style="padding-left:18px">${(s.highlights || []).map(h => `<li>${esc(h)}</li>`).join('')}</ul></div>
      <div><b class="small">What to do next</b><ul class="small" style="padding-left:18px">${(s.recommendations || []).map(h => `<li>${esc(h)}</li>`).join('')}</ul></div></div>`;
  const c = s.current; const d = s.deltas;
  statTiles($('#sumTiles', el), [
    { label: 'New leads', value: c.generated, delta: d.generated, sub: `vs ${prevName}` }, { label: 'Attempts', value: c.attempts, delta: d.attempts, sub: `vs ${prevName}` },
    { label: 'Responded', value: c.replied, delta: d.replied, sub: `vs ${prevName}` }, { label: 'Meetings', value: c.meetings, delta: d.meetings, sub: `vs ${prevName}` },
    { label: 'Converted', value: c.converted, delta: d.converted, sub: `vs ${prevName}` }, { label: 'Said no', value: c.saidNo, delta: d.saidNo, upIsGood: false, sub: `vs ${prevName}` }
  ]);
  $$('[data-p]', el).forEach(b => b.addEventListener('click', () => { period = b.dataset.p; drawSummary(el); }));
  $('#refreshSum', el).addEventListener('click', e => busy(e.target, async () => { await api(`/analytics/summary?period=${period}&refresh=true`); await drawSummary(el); }));
}

function drawLearning(el, l) {
  el.innerHTML = `<div class="row" style="justify-content:space-between"><div><h3>Learning from losses</h3><p class="sub">Every lost lead, customer${isAgencyWorkspace() ? ' and client' : ''} is logged with a reason. The AI looks for patterns and suggests better methods.</p></div>
      <button class="btn btn-primary btn-sm" id="learnBtn">Analyse now</button></div>
    ${l ? `<p style="margin-top:10px">${esc(l.summary || '')}</p><ul class="small" style="padding-left:18px">${(l.recommendations || []).map(r => `<li><b>${esc(r.title)}</b> - ${esc(r.detail)}</li>`).join('')}</ul>
      ${(l.scriptTweaks || []).length ? `<p class="small"><b>Script tweaks:</b> ${esc(l.scriptTweaks.join(' · '))}</p>` : ''}<p class="hint">Last analysed ${esc(dateTime(l.createdAt))}</p>` : '<p class="empty">Not analysed yet.</p>'}`;
  $('#learnBtn', el).addEventListener('click', e => busy(e.target, async () => { const r = await api('/analytics/learning', { method: 'POST' }); drawLearning(el, r); toast('Analysis updated', 'ok'); }, 'Analysing…'));
}
