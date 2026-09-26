import { api, esc, $, $$, label, dateTime, busy } from '../core.js';

export async function render(root) {
  root.innerHTML = `
    <div class="page-head"><div><div class="kicker">Content studio</div><h1>Pitches, ads & social</h1><p>Generated from this workspace's brand voice and sales narrative.</p></div></div>
    <div class="toolbar"><button class="btn btn-secondary" data-gen="sales-pitch">Sales pitch</button><button class="btn btn-secondary" data-gen="ad-copy">Ad ideas & copy</button><button class="btn btn-secondary" data-gen="social-plan">14-day social plan</button></div>
    <div class="grid2"><div class="card"><h3>Graphic</h3><textarea class="input" id="gPrompt" rows="2" placeholder="Describe the graphic…"></textarea><button class="btn btn-secondary" id="gBtn">Generate graphic</button></div>
      <div class="card"><h3>Video ad</h3><textarea class="input" id="vPrompt" rows="2" placeholder="Describe the video ad…"></textarea><button class="btn btn-secondary" id="vBtn">Generate video ad</button></div></div>
    <div id="out" style="margin-top:16px"></div><div class="section-title">History</div><div id="hist" class="stack"></div>`;
  const show = (a) => {
    const body = a.type === 'graphic' && a.result_url ? `<img src="${esc(a.result_url)}" alt="" style="max-width:320px;border-radius:8px"/>`
      : a.result_url ? `<a href="${esc(a.result_url)}" target="_blank" rel="noopener">Open result</a>` : `<pre class="pre">${esc(JSON.stringify(a.result_text, null, 2))}</pre>`;
    $('#out', root).innerHTML = `<div class="card"><div class="kicker">${esc(label(a.type))} · ${esc(a.provider)}</div>${body}</div>`;
  };
  $$('[data-gen]', root).forEach(b => b.addEventListener('click', () => busy(b, async () => { show(await api('/content/' + b.dataset.gen, { method: 'POST', body: {} })); await hist(); }, 'Generating…')));
  $('#gBtn', root).addEventListener('click', e => busy(e.target, async () => { show(await api('/content/graphic', { method: 'POST', body: { prompt: $('#gPrompt', root).value || 'Brand graphic' } })); await hist(); }));
  $('#vBtn', root).addEventListener('click', e => busy(e.target, async () => { show(await api('/content/video-ad', { method: 'POST', body: { prompt: $('#vPrompt', root).value || 'Short brand video ad' } })); await hist(); }));
  async function hist() {
    const items = await api('/content');
    $('#hist', root).innerHTML = items.slice(0, 20).map(a => `<div class="card"><div class="kicker">${esc(label(a.type))} · ${esc(dateTime(a.created_at))}</div>
      <div class="small">${a.result_url ? `<a href="${esc(a.result_url)}" target="_blank" rel="noopener">Open</a>` : esc(JSON.stringify(a.result_text).slice(0, 220)) + '…'}</div></div>`).join('') || '<p class="empty">Nothing generated yet.</p>';
  }
  await hist();
}
