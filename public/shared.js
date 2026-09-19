// Shared auth/session helpers for every page in this app.
// Plain localStorage is fine here: this is a real deployed multi-tenant
// app (not an in-conversation preview), and the token is scoped to one
// browser/company session the same way any SPA's session token would be.
const AUTH_KEY = 'leadgen_auth';

function getAuth() {
  try { return JSON.parse(localStorage.getItem(AUTH_KEY) || 'null'); } catch { return null; }
}
function setAuth(auth) { localStorage.setItem(AUTH_KEY, JSON.stringify(auth)); }
function clearAuth() { localStorage.removeItem(AUTH_KEY); }

function requireAuthOrRedirect() {
  const auth = getAuth();
  if (!auth || !auth.token) { window.location.href = '/login.html'; return null; }
  return auth;
}

async function api(path, { method = 'GET', body, auth = true } = {}) {
  const headers = { 'Content-Type': 'application/json' };
  if (auth) {
    const a = getAuth();
    if (a && a.token) headers.Authorization = `Bearer ${a.token}`;
  }
  const res = await fetch('/api' + path, { method, headers, body: body ? JSON.stringify(body) : undefined });
  let data = null;
  try { data = await res.json(); } catch { /* no body */ }
  if (!res.ok) {
    if (res.status === 401 && auth) { clearAuth(); window.location.href = '/login.html'; }
    throw new Error((data && data.error) || `Request failed (${res.status})`);
  }
  return data;
}

function logout() { clearAuth(); window.location.href = '/login.html'; }

function escHtml(s) {
  return String(s == null ? '' : s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}
