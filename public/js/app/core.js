// Shared state, API client, formatting and UI primitives for the app.
const AUTH_KEY = 'leadgen_auth';
const WS_KEY = 'chunguza_workspace';

export const state = {
  user: null, home: null, isAgencyUser: false, workspaces: [], workspaceId: null, workspace: null, playbook: null
};

export function getAuth() {
  try { return JSON.parse(localStorage.getItem(AUTH_KEY) || 'null'); } catch { return null; }
}
export function logout() {
  try { localStorage.removeItem(AUTH_KEY); localStorage.removeItem(WS_KEY); } catch { /* storage blocked */ }
  location.href = '/login.html';
}
export function savedWorkspace() {
  try { return localStorage.getItem(WS_KEY); } catch { return null; }
}
export function saveWorkspace(id) {
  try { localStorage.setItem(WS_KEY, id); } catch { /* storage blocked */ }
}

export async function api(path, { method = 'GET', body, workspace } = {}) {
  const headers = { 'Content-Type': 'application/json' };
  const a = getAuth();
  if (a && a.token) headers.Authorization = `Bearer ${a.token}`;
  const ws = workspace === undefined ? state.workspaceId : workspace;
  if (ws) headers['X-Workspace-Id'] = ws;
  const res = await fetch('/api' + path, { method, headers, body: body ? JSON.stringify(body) : undefined });
  let data = null;
  try { data = await res.json(); } catch { /* no body */ }
  if (res.status === 401) { logout(); throw new Error('Session expired'); }
  if (!res.ok) throw new Error((data && data.error) || `Request failed (${res.status})`);
  return data;
}

/** Authenticated file download (e.g. .ics) - plain links can't carry the auth header. */
export async function download(path, filename) {
  const a = getAuth();
  const res = await fetch('/api' + path, { headers: { Authorization: `Bearer ${a.token}`, ...(state.workspaceId ? { 'X-Workspace-Id': state.workspaceId } : {}) } });
  if (!res.ok) throw new Error(`Download failed (${res.status})`);
  const url = URL.createObjectURL(await res.blob());
  const link = document.createElement('a');
  link.href = url; link.download = filename; document.body.appendChild(link); link.click(); link.remove();
  setTimeout(() => URL.revokeObjectURL(url), 2000);
}

// ---------- formatting ----------
export function esc(s) {
  return String(s == null ? '' : s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}
export function label(key) {
  if (!key) return '';
  return String(key).replace(/_/g, ' ').replace(/^\w/, c => c.toUpperCase());
}
export function money(n, currency) {
  if (n == null || isNaN(n)) return '—';
  const cur = currency || (state.workspace && state.workspace.currency) || 'USD';
  try { return new Intl.NumberFormat('en', { style: 'currency', currency: cur, maximumFractionDigits: 0 }).format(n); }
  catch { return `${cur} ${Math.round(n).toLocaleString()}`; }
}
/** Money for stat tiles: auto-compact past 100,000 (KES 354.9K) so it never outgrows the tile. */
export function moneyShort(n, currency) {
  if (n == null || isNaN(n) || Math.abs(n) < 100000) return money(n, currency);
  const cur = currency || (state.workspace && state.workspace.currency) || 'USD';
  try { return new Intl.NumberFormat('en', { style: 'currency', currency: cur, notation: 'compact', maximumFractionDigits: 1 }).format(n); }
  catch { return `${cur} ${compact(n)}`; }
}
export function compact(n) {
  if (n == null || isNaN(n)) return '—';
  return new Intl.NumberFormat('en', { notation: Math.abs(n) >= 10000 ? 'compact' : 'standard', maximumFractionDigits: 1 }).format(n);
}
export function pct(n) { return n == null ? '—' : `${n}%`; }
function toDate(v) { if (!v) return null; const d = new Date(/^\d{4}-\d\d-\d\d \d/.test(v) ? v.replace(' ', 'T') + 'Z' : v); return isNaN(d) ? null : d; }
export function dateTime(v) { const d = toDate(v); return d ? d.toLocaleString([], { dateStyle: 'medium', timeStyle: 'short' }) : '—'; }
export function dateOnly(v) { const d = toDate(v); return d ? d.toLocaleDateString([], { dateStyle: 'medium' }) : '—'; }
export function ago(v) {
  const d = toDate(v); if (!d) return '';
  const s = Math.round((Date.now() - d.getTime()) / 1000);
  const f = Math.abs(s);
  const txt = f < 60 ? `${f}s` : f < 3600 ? `${Math.round(f / 60)}m` : f < 86400 ? `${Math.round(f / 3600)}h` : `${Math.round(f / 86400)}d`;
  return s >= 0 ? `${txt} ago` : `in ${txt}`;
}
export function leadName(l) { return (l && (l.company_name || l.contact_name)) || 'Unnamed lead'; }

// ---------- lookups from the playbook ----------
export function statusLabel(key) {
  const s = state.playbook && state.playbook.LEAD_STATUSES.find(x => x.key === key);
  return s ? s.label : label(key);
}
export function statusTag(key) {
  const cls = { closed_won: 'tag-good', meeting_booked: 'tag-good', replied: 'tag-accent', on_fence: 'tag-warn', closed_lost: 'tag-bad', no_response: 'tag-neutral', unsubscribed: 'tag-bad', bounced: 'tag-bad' }[key] || 'tag-neutral';
  return `<span class="tag ${cls}">${esc(statusLabel(key))}</span>`;
}
export function methodLabel(key) {
  const m = state.playbook && state.playbook.OUTREACH_METHODS.find(x => x.key === key);
  return m ? m.label : label(key);
}
export function channelLabel(key) { return (state.playbook && state.playbook.CHANNEL_LABELS[key]) || label(key); }
export function reasonOptions(selected) {
  return (state.playbook ? state.playbook.LOSS_REASONS : []).map(r => `<option value="${esc(r.key)}" ${r.key === selected ? 'selected' : ''}>${esc(r.label)}</option>`).join('');
}

// ---------- DOM helpers ----------
export const $ = (sel, root = document) => root.querySelector(sel);
export const $$ = (sel, root = document) => Array.from(root.querySelectorAll(sel));

export function toast(message, kind = '') {
  const box = $('#toasts');
  const t = document.createElement('div');
  t.className = `toast ${kind}`;
  t.textContent = message;
  box.appendChild(t);
  while (box.children.length > 3) box.firstElementChild.remove();
  setTimeout(() => t.remove(), kind === 'err' ? 7000 : 4000);
}

/** Run an async action with the button disabled; errors become toasts. */
export async function busy(btn, fn, workingText = 'Working…') {
  const original = btn ? btn.textContent : '';
  if (btn) { btn.disabled = true; btn.textContent = workingText; }
  try { return await fn(); }
  catch (err) { toast(err.message, 'err'); return undefined; }
  finally { if (btn) { btn.disabled = false; btn.textContent = original; } }
}

export function openDialog({ title, body, actions = [] }) {
  const bd = $('#dialogBackdrop');
  $('#dialogTitle').textContent = title;
  $('#dialogBody').innerHTML = body;
  const act = $('#dialogActions');
  act.innerHTML = '';
  const close = () => { bd.hidden = true; };
  for (const a of [...actions, { label: actions.length ? 'Cancel' : 'Close' }]) {
    const b = document.createElement('button');
    b.className = `btn ${a.primary ? 'btn-primary' : 'btn-secondary'}`;
    b.textContent = a.label;
    b.addEventListener('click', async () => {
      if (!a.onClick) return close();
      let failed = false;
      const keep = await busy(b, async () => {
        try { return await a.onClick($('#dialogBody')); } catch (err) { failed = true; throw err; }
      });
      // Stay open on error (keep what was typed) or when the action opened a follow-up dialog.
      if (!failed && keep !== false) close();
    });
    act.appendChild(b);
  }
  bd.hidden = false;
  const first = $('#dialogBody input, #dialogBody select, #dialogBody textarea');
  if (first) first.focus();
  return close;
}

export function openDrawer(html) {
  $('#drawer').innerHTML = html;
  $('#drawerBackdrop').hidden = false;
  $('#drawer').hidden = false;
  $('#drawer').scrollTop = 0;
  return $('#drawer');
}
export function closeDrawer() {
  $('#drawerBackdrop').hidden = true;
  $('#drawer').hidden = true;
  $('#drawer').innerHTML = '';
  if (location.hash.startsWith('#/lead/')) history.replaceState(null, '', '#/leads');
}

/** Read a picked file as { filename, base64 } for JSON upload. */
export function fileToUpload(file) {
  return new Promise((resolve, reject) => {
    if (!file) return reject(new Error('Choose a file first'));
    if (file.size > 12 * 1024 * 1024) return reject(new Error('File is larger than 12 MB'));
    const r = new FileReader();
    r.onload = () => resolve({ filename: file.name, base64: String(r.result).split(',')[1] || '' });
    r.onerror = () => reject(new Error('Could not read the file'));
    r.readAsDataURL(file);
  });
}

export function isAgencyWorkspace() { return state.workspace && state.workspace.kind === 'agency'; }
export function canEdit() { return state.user && ['owner', 'admin'].includes(state.user.role); }

/** Form values by [name] inside a container. Checkbox groups with the same name become arrays. */
export function formValues(root) {
  const out = {};
  for (const input of $$('[name]', root)) {
    const n = input.name;
    if (input.type === 'checkbox') {
      if ($$(`[name="${n}"]`, root).length > 1) { out[n] = out[n] || []; if (input.checked) out[n].push(input.value); }
      else out[n] = input.checked;
    } else if (input.type === 'radio') { if (input.checked) out[n] = input.value; }
    else if (input.type !== 'file') out[n] = input.value;
  }
  return out;
}
