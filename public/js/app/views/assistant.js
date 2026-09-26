import { api, esc, $, busy, label } from '../core.js';

export async function render(root) {
  root.innerHTML = `
    <div class="page-head"><div><div class="kicker">AI assistant</div><h1>Ask or delegate</h1>
      <p>It can search leads, log attempts and outcomes, create tasks, book meetings, draft emails, check follow-ups and analytics - in this workspace. It never sends email by itself.</p></div>
      <button class="btn btn-secondary" id="auto">Run autonomously now</button></div>
    <div class="card"><div class="chat" id="chat"></div>
      <div class="row"><input class="input grow" id="msg" placeholder="e.g. Which leads are on the fence? · What follow-ups are due? · How are we doing?"/><button class="btn btn-primary" id="send">Send</button></div></div>`;
  const chat = $('#chat', root);
  const add = (text, mine, actions = []) => {
    chat.insertAdjacentHTML('beforeend', `<div class="bubble ${mine ? 'mine' : 'theirs'}">${esc(text)}${actions.map(a => `<div class="toolcall">→ ${esc(label(a.tool))}</div>`).join('')}</div>`);
    chat.scrollTop = chat.scrollHeight;
  };
  const hist = await api('/assistant/history');
  hist.filter(r => r.role !== 'tool' && r.content).forEach(r => add(r.content, r.role === 'user'));
  const send = async () => {
    const m = $('#msg', root).value.trim(); if (!m) return;
    $('#msg', root).value = ''; add(m, true);
    await busy($('#send', root), async () => { const r = await api('/assistant/chat', { method: 'POST', body: { message: m } }); add(r.reply, false, r.actions); }, 'Thinking…');
  };
  $('#send', root).addEventListener('click', send);
  $('#msg', root).addEventListener('keydown', e => { if (e.key === 'Enter') send(); });
  $('#auto', root).addEventListener('click', e => busy(e.target, async () => { const r = await api('/assistant/run-autonomous', { method: 'POST' }); add(`Autonomous run: ${r.reply}`, false, r.actions); }, 'Running…'));
}
