// Small, dependency-free charts. Every chart has a hover/focus tooltip and a
// table view, so no value is only reachable by hovering or by colour.
import { esc } from './core.js';

const SERIES = ['var(--series-1)', 'var(--series-2)', 'var(--series-3)', 'var(--series-4)'];

let tip = null;
function tooltip() {
  if (!tip) { tip = document.createElement('div'); tip.className = 'viz-tooltip'; tip.hidden = true; document.body.appendChild(tip); }
  return tip;
}
/** rows: [{ name, value, color? }] - built with textContent (labels are data). */
function showTip(x, y, title, rows) {
  const t = tooltip();
  t.replaceChildren();
  const h = document.createElement('div'); h.className = 'tt-title'; h.textContent = title; t.appendChild(h);
  for (const r of rows) {
    const row = document.createElement('div'); row.className = 'tt-row';
    if (r.color) { const k = document.createElement('span'); k.className = 'tt-key'; k.style.background = r.color; row.appendChild(k); }
    const n = document.createElement('span'); n.textContent = r.name; row.appendChild(n);
    const v = document.createElement('span'); v.className = 'tt-val'; v.textContent = r.value; row.appendChild(v);
    t.appendChild(row);
  }
  t.hidden = false;
  const w = t.offsetWidth; const hgt = t.offsetHeight;
  t.style.left = `${Math.min(window.innerWidth - w - 8, x + 14)}px`;
  t.style.top = `${Math.max(8, Math.min(window.innerHeight - hgt - 8, y - hgt - 10))}px`;
}
function hideTip() { if (tip) tip.hidden = true; }

function tableHtml(headers, rows) {
  return `<div class="tablewrap"><table class="table"><thead><tr>${headers.map((h, i) => `<th class="${i ? 'num' : ''}">${esc(h)}</th>`).join('')}</tr></thead>
    <tbody>${rows.map(r => `<tr>${r.map((c, i) => `<td class="${i ? 'num' : ''}">${esc(c)}</td>`).join('')}</tr>`).join('')}</tbody></table></div>`;
}

/** Card with a title and a "Table" toggle; returns the plot element. */
function frame(el, title, subtitle, table) {
  el.classList.add('card', 'chart-card');
  el.innerHTML = `<div class="chart-head"><div><h3>${esc(title)}</h3>${subtitle ? `<p class="sub">${esc(subtitle)}</p>` : ''}</div>
    <button class="btn btn-ghost chart-toggle" type="button">Table</button></div><div class="plot"></div><div class="tview" hidden>${table}</div>`;
  const plot = el.querySelector('.plot'); const tv = el.querySelector('.tview'); const btn = el.querySelector('.chart-toggle');
  btn.addEventListener('click', () => { const showTable = tv.hidden; tv.hidden = !showTable; plot.hidden = showTable; btn.textContent = showTable ? 'Chart' : 'Table'; });
  return plot;
}

/**
 * Stat tiles. tiles: [{ label, value, sub?, delta?, upIsGood? }]
 * delta is a signed number vs a named period (put the period in `sub`).
 */
export function statTiles(el, tiles) {
  el.className = 'tiles';
  el.innerHTML = tiles.map(t => {
    let d = '';
    if (t.delta != null && !isNaN(t.delta)) {
      const good = t.upIsGood === false ? t.delta < 0 : t.delta > 0;
      const cls = t.delta === 0 ? 'delta-flat' : good ? 'delta-up' : 'delta-down';
      d = ` <span class="${cls}">${t.delta > 0 ? '▲ +' : t.delta < 0 ? '▼ ' : ''}${esc(t.delta === 0 ? 'no change' : t.delta)}</span>`;
    }
    return `<div class="tile ${t.hero ? 'hero' : ''}"><div class="t-label">${esc(t.label)}</div><div class="t-value ${String(t.value).length > 7 ? 'long' : ''}">${esc(t.value)}</div>${t.sub || d ? `<div class="t-sub">${esc(t.sub || '')}${d}</div>` : ''}</div>`;
  }).join('');
}

/**
 * Horizontal bars for ONE series (one colour). rows: [{ label, value, display? , detail? }]
 */
export function barChart(el, { title, subtitle, rows, format = (v) => String(v), valueHeader = 'Value' }) {
  const plot = frame(el, title, subtitle, tableHtml(['', valueHeader], rows.map(r => [r.label, r.display ?? format(r.value)])));
  if (!rows.length || rows.every(r => !r.value)) { plot.innerHTML = '<p class="empty">No data yet for this period.</p>'; return; }
  const max = Math.max(...rows.map(r => r.value || 0), 1);
  plot.innerHTML = `<div class="bars">${rows.map((r, i) => `
    <div class="bar-row" tabindex="0" data-i="${i}">
      <div class="bar-label" title="${esc(r.label)}">${esc(r.label)}</div>
      <div class="bar-track"><div class="bar-fill" style="width:calc(${Math.max(0, (r.value || 0) / max) * 100}% - 70px)"></div><span class="bar-value">${esc(r.display ?? format(r.value))}</span></div>
    </div>`).join('')}</div>`;
  plot.querySelectorAll('.bar-row').forEach(row => {
    const r = rows[Number(row.dataset.i)];
    const show = (x, y) => showTip(x, y, r.label, [{ name: valueHeader, value: r.display ?? format(r.value) }, ...(r.detail || [])]);
    row.addEventListener('pointermove', e => show(e.clientX, e.clientY));
    row.addEventListener('pointerleave', hideTip);
    row.addEventListener('focus', () => { const b = row.getBoundingClientRect(); show(b.left + b.width / 2, b.top); });
    row.addEventListener('blur', hideTip);
  });
}

function niceMax(v) {
  if (v <= 5) return 5;
  const p = Math.pow(10, Math.floor(Math.log10(v)));
  const n = v / p;
  return (n <= 1 ? 1 : n <= 2 ? 2 : n <= 5 ? 5 : 10) * p;
}

/**
 * Line chart, one shared y-axis (same unit). series: [{ name, values }], x: labels.
 * Legend for 2+ series; end labels only when they don't collide; crosshair tooltip lists every series.
 */
export function lineChart(el, { title, subtitle, x, series, format = (v) => String(v) }) {
  const table = tableHtml(['', ...series.map(s => s.name)], x.map((lbl, i) => [lbl, ...series.map(s => format(s.values[i] || 0))]));
  const plot = frame(el, title, subtitle, table);
  const all = series.flatMap(s => s.values);
  if (!all.some(v => v)) { plot.innerHTML = '<p class="empty">No activity yet for this period.</p>'; return; }
  const W = 720; const H = 240; const L = 40; const R = 110; const T = 12; const B = 28;
  const pw = W - L - R; const ph = H - T - B;
  const ymax = niceMax(Math.max(...all));
  const X = (i) => L + (x.length === 1 ? pw / 2 : (i / (x.length - 1)) * pw);
  const Y = (v) => T + ph - (v / ymax) * ph;
  const ticks = [0, 0.25, 0.5, 0.75, 1].map(f => Math.round(ymax * f));
  const every = Math.ceil(x.length / 8);
  let svg = `<svg class="line-chart" viewBox="0 0 ${W} ${H}" role="img" aria-label="${esc(title)}">`;
  for (const t of ticks) svg += `<line x1="${L}" x2="${W - R}" y1="${Y(t)}" y2="${Y(t)}" stroke="${t === 0 ? 'var(--axis)' : 'var(--grid)'}" stroke-width="1"/><text x="${L - 8}" y="${Y(t) + 4}" text-anchor="end">${t.toLocaleString()}</text>`;
  x.forEach((lbl, i) => { if (i % every === 0 || i === x.length - 1) svg += `<text x="${X(i)}" y="${H - 8}" text-anchor="middle">${esc(lbl)}</text>`; });
  series.forEach((s, si) => {
    const pts = s.values.map((v, i) => `${X(i)},${Y(v || 0)}`).join(' ');
    svg += `<polyline points="${pts}" fill="none" stroke="${SERIES[si]}" stroke-width="2" stroke-linejoin="round" stroke-linecap="round"/>`;
  });
  // End labels: only when the end values are at least 14px apart (else legend + tooltip carry identity).
  const ends = series.map((s, si) => ({ si, y: Y(s.values[s.values.length - 1] || 0) })).sort((a, b) => a.y - b.y);
  const collide = ends.some((e, i) => i && e.y - ends[i - 1].y < 14);
  series.forEach((s, si) => {
    const last = s.values.length - 1;
    svg += `<circle cx="${X(last)}" cy="${Y(s.values[last] || 0)}" r="4" fill="${SERIES[si]}" stroke="var(--color-surface)" stroke-width="2"/>`;
    if (!collide && series.length <= 4) svg += `<text class="end-label" x="${X(last) + 10}" y="${Y(s.values[last] || 0) + 4}">${esc(s.name)} ${esc(format(s.values[last] || 0))}</text>`;
  });
  svg += `<line class="xhair" x1="0" x2="0" y1="${T}" y2="${T + ph}" stroke="var(--ink-3)" stroke-width="1" visibility="hidden"/>`;
  svg += `<rect class="hit" x="${L}" y="${T}" width="${pw}" height="${ph}" fill="transparent" tabindex="0"/></svg>`;
  plot.innerHTML = svg + (series.length > 1 ? `<div class="legend">${series.map((s, si) => `<span><span class="lk" style="background:${SERIES[si]}"></span>${esc(s.name)}</span>`).join('')}</div>` : '');
  const svgEl = plot.querySelector('svg'); const hair = plot.querySelector('.xhair'); const hit = plot.querySelector('.hit');
  const at = (i, cx, cy) => {
    hair.setAttribute('x1', X(i)); hair.setAttribute('x2', X(i)); hair.setAttribute('visibility', 'visible');
    showTip(cx, cy, x[i], series.map((s, si) => ({ name: s.name, value: format(s.values[i] || 0), color: SERIES[si] })));
  };
  let focusIdx = x.length - 1;
  hit.addEventListener('pointermove', e => {
    const b = svgEl.getBoundingClientRect();
    const sx = ((e.clientX - b.left) / b.width) * W;
    const i = Math.max(0, Math.min(x.length - 1, Math.round(((sx - L) / pw) * (x.length - 1))));
    at(i, e.clientX, e.clientY);
  });
  hit.addEventListener('pointerleave', () => { hair.setAttribute('visibility', 'hidden'); hideTip(); });
  hit.addEventListener('focus', () => { const b = svgEl.getBoundingClientRect(); at(focusIdx, b.left + b.width / 2, b.top + 20); });
  hit.addEventListener('keydown', e => {
    if (e.key !== 'ArrowLeft' && e.key !== 'ArrowRight') return;
    focusIdx = Math.max(0, Math.min(x.length - 1, focusIdx + (e.key === 'ArrowRight' ? 1 : -1)));
    const b = svgEl.getBoundingClientRect(); at(focusIdx, b.left + (X(focusIdx) / W) * b.width, b.top + 20);
  });
  hit.addEventListener('blur', () => { hair.setAttribute('visibility', 'hidden'); hideTip(); });
}

/** Vertical columns for ONE series (e.g. churn % per month). */
export function columnChart(el, { title, subtitle, x, values, format = (v) => String(v), valueHeader = 'Value', detail = [] }) {
  const plot = frame(el, title, subtitle, tableHtml(['', valueHeader], x.map((l, i) => [l, values[i] == null ? '—' : format(values[i])])));
  if (!values.some(v => v)) { plot.innerHTML = '<p class="empty">Nothing recorded yet.</p>'; return; }
  const W = 560; const H = 200; const L = 36; const T = 18; const B = 26; const pw = W - L - 8; const ph = H - T - B;
  const ymax = niceMax(Math.max(...values.map(v => v || 0)));
  const band = pw / x.length; const bw = Math.min(24, band * 0.6);
  let svg = `<svg class="line-chart" viewBox="0 0 ${W} ${H}" role="img" aria-label="${esc(title)}">`;
  for (const f of [0, 0.5, 1]) { const t = ymax * f; const y = T + ph - (t / ymax) * ph; svg += `<line x1="${L}" x2="${W - 8}" y1="${y}" y2="${y}" stroke="${f === 0 ? 'var(--axis)' : 'var(--grid)'}"/><text x="${L - 6}" y="${y + 4}" text-anchor="end">${esc(format(Math.round(t * 10) / 10))}</text>`; }
  x.forEach((lbl, i) => {
    const v = values[i] || 0; const h = (v / ymax) * ph; const cx = L + band * i + band / 2; const y = T + ph - h;
    if (v > 0) svg += `<path d="M${cx - bw / 2},${T + ph} V${y + Math.min(4, h)} Q${cx - bw / 2},${y} ${cx - bw / 2 + Math.min(4, h)},${y} H${cx + bw / 2 - Math.min(4, h)} Q${cx + bw / 2},${y} ${cx + bw / 2},${y + Math.min(4, h)} V${T + ph} Z" fill="var(--series-1)"/>`;
    svg += `<text x="${cx}" y="${H - 8}" text-anchor="middle">${esc(lbl)}</text>`;
    if (v > 0 && i === values.length - 1) svg += `<text class="end-label" x="${cx}" y="${y - 6}" text-anchor="middle">${esc(format(v))}</text>`;
    svg += `<rect class="col-hit" data-i="${i}" x="${cx - band / 2}" y="${T}" width="${band}" height="${ph}" fill="transparent" tabindex="0"/>`;
  });
  plot.innerHTML = svg + '</svg>';
  plot.querySelectorAll('.col-hit').forEach(r => {
    const i = Number(r.dataset.i);
    const show = (cx, cy) => showTip(cx, cy, x[i], [{ name: valueHeader, value: values[i] == null ? '—' : format(values[i]) }, ...(detail[i] || [])]);
    r.addEventListener('pointermove', e => show(e.clientX, e.clientY));
    r.addEventListener('pointerleave', hideTip);
    r.addEventListener('focus', () => { const b = r.getBoundingClientRect(); show(b.left + b.width / 2, b.top + 30); });
    r.addEventListener('blur', hideTip);
  });
}

/** Health meter: status colour + text band, never colour alone. */
export function healthMeter(h) {
  if (!h) return '<span class="muted">—</span>';
  const color = { healthy: 'var(--status-good)', watch: 'var(--status-warning)', ramping_up: 'var(--color-accent)' }[h.band] || 'var(--status-critical)';
  const icon = { healthy: '✓', watch: '!', ramping_up: '↗' }[h.band] || '✕';
  return `<div class="row" style="gap:8px;flex-wrap:nowrap"><div class="meter" style="flex:1;min-width:48px"><span style="width:${h.score}%;background:${color}"></span></div>
    <span class="small" style="white-space:nowrap">${icon} ${h.score} · ${esc(h.band.replace('_', ' '))}</span></div>`;
}
