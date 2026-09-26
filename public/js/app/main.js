import { state, api, getAuth, logout, savedWorkspace, saveWorkspace, esc, $, ago, toast, closeDrawer } from './core.js';
import * as overview from './views/overview.js';
import * as leads from './views/leads.js';
import * as outreach from './views/outreach.js';
import * as meetings from './views/meetings.js';
import * as clients from './views/clients.js';
import * as customers from './views/customers.js';
import * as value from './views/value.js';
import * as analytics from './views/analytics.js';
import * as playbook from './views/playbook.js';
import * as content from './views/content.js';
import * as assistant from './views/assistant.js';
import * as settings from './views/settings.js';

const VIEWS = { overview, leads, outreach, meetings, clients, customers, value, analytics, playbook, content, assistant, settings };

function navItems() {
  const agency = state.workspace.kind === 'agency';
  const groups = agency
    ? [
      ['Agency', [['overview', 'Overview'], ['analytics', 'Analytics']]],
      ['1 · Find clients', [['leads', 'Prospects'], ['outreach', 'Outreach']]],
      ['2 · Sign clients', [['meetings', 'Meetings & tasks']]],
      ['3 · Get results', [['clients', 'Clients'], ['value', 'Our value pyramid']]],
      ['Tools', [['playbook', 'Playbook'], ['content', 'Content studio'], ['assistant', 'AI assistant'], ['settings', 'Settings']]]
    ]
    : [
      ['Workspace', [['overview', 'Overview'], ['analytics', 'Analytics']]],
      ['Leads & outreach', [['leads', 'Leads'], ['outreach', 'Outreach'], ['meetings', 'Meetings & tasks']]],
      ['Growth', [['customers', 'Customers & churn'], ['value', 'Value pyramid & plan']]],
      ['Tools', [['playbook', 'Playbook'], ['content', 'Content studio'], ['assistant', 'AI assistant'], ['settings', 'Settings']]]
    ];
  return groups;
}

function renderNav(active) {
  $('#sidebar').innerHTML = navItems().map(([group, items]) =>
    `<div class="nav-group">${esc(group)}</div>` + items.map(([key, lbl]) =>
      `<a class="nav-link ${key === active ? 'active' : ''}" href="#/${key}">${esc(lbl)}</a>`).join('')).join('');
}

function renderSwitcher() {
  const sel = $('#wsSwitch');
  sel.innerHTML = state.workspaces.map(w => `<option value="${esc(w.id)}" ${w.id === state.workspaceId ? 'selected' : ''}>${w.kind === 'agency' ? '🏢 ' : '👤 '}${esc(w.name)}${w.kind === 'agency' ? ' (agency)' : w.client_status === 'churned' ? ' (churned)' : ''}</option>`).join('');
  sel.disabled = state.workspaces.length < 2;
  const k = $('#wsKind');
  k.hidden = false;
  k.textContent = state.workspace.kind === 'agency' ? 'Agency workspace' : `Client · ${state.workspace.target_market === 'b2c' ? 'B2C' : 'B2B'} · ${state.workspace.currency}`;
}

async function loadWorkspace(id) {
  state.workspaceId = id;
  saveWorkspace(id);
  state.workspace = await api('/workspaces/current');
}

export async function switchWorkspace(id) {
  closeDrawer();
  await loadWorkspace(id);
  renderSwitcher();
  if (location.hash === '#/overview') route(); else location.hash = '#/overview';
}

export async function refreshWorkspace() {
  state.workspace = await api('/workspaces/current');
  const me = await api('/auth/me');
  state.workspaces = me.workspaces;
  renderSwitcher();
}

async function route() {
  const [, name = 'overview', param] = (location.hash || '#/overview').split('/');
  if (name === 'lead' && param) {
    if (!$('#view').dataset.view) await render('leads');
    return leads.openLead(param);
  }
  const key = VIEWS[name] ? name : 'overview';
  if (key === 'clients' && state.workspace.kind !== 'agency') { location.hash = '#/overview'; return; }
  if (key === 'customers' && state.workspace.kind === 'agency') { location.hash = '#/clients'; return; }
  closeDrawer();
  await render(key);
}

async function render(key) {
  renderNav(key);
  const root = $('#view');
  root.dataset.view = key;
  root.innerHTML = '<p class="empty">Loading…</p>';
  try { await VIEWS[key].render(root); }
  catch (err) { root.innerHTML = `<p class="empty">Could not load this page: ${esc(err.message)}</p>`; }
}

// ---------- notifications ----------
let unread = 0;
function setUnread(n) { unread = n; const c = $('#bellCount'); c.hidden = !n; c.textContent = n > 99 ? '99+' : String(n); }

async function openNotifications() {
  const panel = $('#notifPanel');
  if (!panel.hidden) { panel.hidden = true; $('#bellBtn').setAttribute('aria-expanded', 'false'); return; }
  panel.hidden = false; $('#bellBtn').setAttribute('aria-expanded', 'true');
  panel.innerHTML = '<p class="empty" style="padding:10px">Loading…</p>';
  const data = await api('/notifications?limit=40', { workspace: null });
  setUnread(data.unread);
  panel.innerHTML = `<div class="row" style="justify-content:space-between;padding:4px 8px 8px"><b>Notifications</b><button class="btn btn-ghost btn-sm" id="markAll">Mark all read</button></div>` +
    (data.items.map(n => `<div class="notif ${n.read_at ? '' : 'unread'}" data-id="${esc(n.id)}" data-ws="${esc(n.company_id)}" data-lead="${esc(n.lead_id || '')}">
      <div class="n-title">${esc(n.title)}</div>${n.body ? `<div class="small muted">${esc(n.body)}</div>` : ''}
      <div class="n-meta">${esc(n.workspace_name || '')} · ${esc(ago(n.created_at))}</div></div>`).join('') || '<p class="empty" style="padding:10px">Nothing yet.</p>');
  $('#markAll').addEventListener('click', async () => { const r = await api('/notifications/read', { method: 'POST', body: {}, workspace: null }); setUnread(r.unread); panel.hidden = true; });
  panel.querySelectorAll('.notif').forEach(n => n.addEventListener('click', async () => {
    const r = await api('/notifications/read', { method: 'POST', body: { ids: [n.dataset.id] }, workspace: null });
    setUnread(r.unread);
    panel.hidden = true;
    if (n.dataset.ws !== state.workspaceId && state.workspaces.some(w => w.id === n.dataset.ws)) await switchWorkspace(n.dataset.ws);
    if (n.dataset.lead) location.hash = `#/lead/${n.dataset.lead}`;
  }));
}

function connectStream() {
  const a = getAuth();
  const es = new EventSource(`/api/notifications/stream?token=${encodeURIComponent(a.token)}`);
  es.addEventListener('ready', e => setUnread(JSON.parse(e.data).unread));
  // Pop a toast only for things that happened elsewhere (replies, inbound leads,
  // risk alerts); outcomes the user just clicked are already confirmed on screen.
  const LIVE = new Set(['email_reply', 'auto_reply_draft', 'inbound_lead', 'client_at_risk', 'follow_up_due', 'customer_lost']);
  es.addEventListener('notification', e => {
    const n = JSON.parse(e.data);
    setUnread(unread + 1);
    if (LIVE.has(n.type)) toast(`${n.title}${n.workspace_name && n.company_id !== state.workspaceId ? ' · ' + n.workspace_name : ''}`);
  });
  es.onerror = () => { es.close(); setTimeout(connectStream, 15000); };
}

// ---------- boot ----------
(async function boot() {
  if (!getAuth()) { location.href = '/login.html'; return; }
  $('#logoutBtn').addEventListener('click', logout);
  $('#bellBtn').addEventListener('click', () => openNotifications().catch(err => toast(err.message, 'err')));
  document.addEventListener('click', e => { if (!e.target.closest('.bell')) $('#notifPanel').hidden = true; });
  $('#drawerBackdrop').addEventListener('click', closeDrawer);
  document.addEventListener('keydown', e => {
    if (e.key !== 'Escape') return;
    if (!$('#dialogBackdrop').hidden) $('#dialogBackdrop').hidden = true;
    else if (!$('#drawer').hidden) closeDrawer();
  });
  $('#wsSwitch').addEventListener('change', e => switchWorkspace(e.target.value).catch(err => toast(err.message, 'err')));
  try {
    const me = await api('/auth/me', { workspace: null });
    Object.assign(state, { user: me.user, home: me.company, isAgencyUser: me.isAgencyUser, workspaces: me.workspaces });
    state.playbook = await api('/playbook', { workspace: null });
    const saved = savedWorkspace();
    await loadWorkspace(me.workspaces.some(w => w.id === saved) ? saved : me.company.id);
    $('#userTag').textContent = `${me.user.name} · ${me.user.role}`;
    renderSwitcher();
    window.addEventListener('hashchange', route);
    if (!location.hash) history.replaceState(null, '', '#/overview');
    await route();
    connectStream();
  } catch (err) {
    $('#view').innerHTML = `<p class="empty">${esc(err.message)}</p>`;
  }
})();
