// ---------- tiny API helper ----------
async function api(path, { method = 'GET', body, auth = true } = {}) {
  const headers = { 'Content-Type': 'application/json' };
  if (auth) {
    const token = localStorage.getItem('getnesty_token');
    if (token) headers.Authorization = `Bearer ${token}`;
  }
  const res = await fetch('/api' + path, {
    method,
    headers,
    body: body ? JSON.stringify(body) : undefined,
  });
  let data = {};
  let rawText = '';
  try {
    rawText = await res.text();
    data = rawText ? JSON.parse(rawText) : {};
  } catch (_) {
    // Response wasn't valid JSON (platform error page, timeout, etc.) —
    // surface a snippet of what actually came back instead of a blank message.
  }
  if (!res.ok) {
    // A 401 from an authenticated call always means "this token is missing,
    // invalid, or expired" (see requireAuth in middleware/auth.js) — never
    // "wrong password", which the login endpoints report separately and
    // always call with auth:false. So this can never fire while someone is
    // just mistyping credentials on the sign-in form; it only fires once a
    // previously-valid session has actually gone bad mid-use, and the right
    // move is the same thing Instagram/Twitter/etc do: drop them back to
    // sign-in instead of leaving a dashboard silently throwing 401s.
    if (res.status === 401 && auth) {
      clearSession();
      if (location.pathname !== '/' && location.pathname !== '/index.html') {
        window.location.replace('/');
      }
    }
    const fallback = rawText
      ? `Unexpected server response (${res.status}): ${rawText.slice(0, 120)}`
      : `Request failed (${res.status})`;
    const err = new Error(data.error || fallback);
    err.status = res.status;
    throw err;
  }
  return data;
}

// ---------- toast ----------
function toast(message, type = 'ok') {
  let stack = document.getElementById('toast-stack');
  if (!stack) {
    stack = document.createElement('div');
    stack.id = 'toast-stack';
    document.body.appendChild(stack);
  }
  const el = document.createElement('div');
  el.className = `toast ${type}`;
  el.textContent = message;
  stack.appendChild(el);
  setTimeout(() => el.remove(), 3600);
}

// ---------- session ----------
function saveSession(token, user) {
  localStorage.setItem('getnesty_token', token);
  localStorage.setItem('getnesty_user', JSON.stringify(user));
}
function getSession() {
  const token = localStorage.getItem('getnesty_token');
  const userRaw = localStorage.getItem('getnesty_user');
  if (!token || !userRaw) return null;
  try { return { token, user: JSON.parse(userRaw) }; } catch (_) { return null; }
}
function clearSession() {
  localStorage.removeItem('getnesty_token');
  localStorage.removeItem('getnesty_user');
  sessionStorage.removeItem('getnesty_org_name'); // don't leak the previous hostel's name into a next login on the same tab
}
function logout() {
  clearSession();
  window.location.href = '/';
}
function guard(requiredType) {
  const s = getSession();
  if (!s || s.user.type !== requiredType) {
    window.location.href = '/';
    return null;
  }
  return s;
}

// ---------- UID helpers (mirrors backend logic for instant client-side feedback) ----------
// Blocks are admin-created now — this cache is populated by loadBlockMeta()
// and refreshed after any block create/edit/delete. A small fixed color
// palette (b1-b9) is assigned by block code so every block still gets a
// consistent, distinct badge color without needing per-block color config.
let BLOCK_META = {};
let _blocksLoading = null;

async function loadBlockMeta(forceRefresh = false) {
  if (Object.keys(BLOCK_META).length > 0 && !forceRefresh) return BLOCK_META;
  if (_blocksLoading && !forceRefresh) return _blocksLoading;
  _blocksLoading = api('/blocks').then((data) => {
    const fresh = {};
    data.blocks.forEach((b) => {
      fresh[b.code] = { name: b.name, address: b.address, owner: b.owner, description: b.description, css: 'b' + b.code };
    });
    BLOCK_META = fresh;
    return BLOCK_META;
  }).finally(() => { _blocksLoading = null; });
  return _blocksLoading;
}

// Format validation only — does NOT check whether this block digit currently
// has a real block behind it (that's what BLOCK_META/loadBlockMeta is for).
// Keeping this independent of the cache avoids a chicken-and-egg load-order problem.
function parseUidClient(uid) {
  if (!/^\d{5}$/.test(uid || '')) return null;
  const block = parseInt(uid[0], 10);
  const floor = parseInt(uid[1], 10);
  const room = parseInt(uid.slice(2, 4), 10);
  const bed = parseInt(uid[4], 10);
  if (block < 1 || block > 9 || room < 1 || bed < 1) return null;
  return { block, floor, room, bed };
}

function renderKeycard(uid, size = '') {
  const parsed = parseUidClient(uid);
  const digits = (uid || '').padEnd(5, '•').split('');
  const labels = ['Block', 'Floor', 'Room', 'Room', 'Bed'];
  const segs = digits
    .map((d, i) => `<div class="seg"><span class="d">${d}</span><span class="l">${labels[i]}</span></div>`)
    .join('');
  return `<div class="keycard ${size}"><div class="chip"></div><div class="segments">${segs}</div></div>`;
}

function blockBadge(block) {
  const meta = BLOCK_META[block];
  const name = meta ? meta.name : `Block ${block}`;
  const css = meta ? meta.css : 'b' + block;
  return `<span class="badge-block ${css}">${name}</span>`;
}

// ---------- shared payment config cache ----------
// Both the "Add Tenant" modal and the bed-click "Add Tenant" flow need this
// to pre-fill fee fields. It rarely changes, so fetch it once per page load
// instead of hitting the API every single time either modal opens.
let _paymentConfigCache = null;
async function getPaymentConfigCached(forceRefresh = false) {
  if (_paymentConfigCache && !forceRefresh) return _paymentConfigCache;
  const data = await api('/payments/config');
  _paymentConfigCache = data.config;
  return _paymentConfigCache;
}
function invalidatePaymentConfigCache() {
  _paymentConfigCache = null;
}

function escapeHtml(s) {
  return (s || '').replace(/[&<>"']/g, (c) => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
}

// Shows a "send login details via WhatsApp" confirmation after a tenant is
// created. Assumes India (+91) — adjust the prefix below if that's wrong.
function openWhatsAppInviteModal(tenant) {
  const backdrop = document.getElementById('waModalBackdrop');
  if (!backdrop) return; // this modal only exists on admin.html
  document.getElementById('waModalSub').textContent = `Send ${tenant.name} their login details.`;
  document.getElementById('waKeycardHolder').innerHTML = renderKeycard(tenant.uid);

  const siteUrl = window.location.origin;
  const message =
    `Welcome to Getnesty Hostel, ${tenant.name}! 🌿\n\n` +
    `Your login details:\nUID: ${tenant.uid}\nPhone: ${tenant.phone}\n\n` +
    `Log in here: ${siteUrl}\n\n` +
    `⚠️ Keep your UID and phone private — don't share them with anyone.`;

  const waPhone = '91' + tenant.phone; // India country code
  document.getElementById('waSendLink').href = `https://wa.me/${waPhone}?text=${encodeURIComponent(message)}`;
  backdrop.classList.add('show');
}

// ---------- Hostel (organization) name badge ----------
// Shown under the "Getnesty" brand in the admin/tenant sidebars — only
// does anything on pages that actually have the #orgNameBadge element, so
// it's harmless to load this on every page (login screen included).
// Cached in sessionStorage — an org's name essentially never changes
// mid-session, so there's no reason to spend a network round trip on it
// every single page load. Clears itself automatically on logout (whole
// localStorage/session is cleared then) and naturally starts fresh on a
// new browser tab/session.
if (document.getElementById('orgNameBadge')) {
  const cached = sessionStorage.getItem('getnesty_org_name');
  if (cached) {
    document.getElementById('orgNameBadge').textContent = cached;
  } else {
    api('/auth/organization').then((res) => {
      const el = document.getElementById('orgNameBadge');
      if (el && res && res.name) {
        el.textContent = res.name;
        sessionStorage.setItem('getnesty_org_name', res.name);
      }
    }).catch(() => {}); // not fatal — the app brand alone still shows fine
  }
}

// ---------- PWA install support ----------
// Registering this here (rather than per-page) means every page that loads
// common.js — sign-in, admin console, tenant "My Stay", hostel info —
// picks up the service worker, which is what makes the browser consider
// Getnesty installable in the first place.
if ('serviceWorker' in navigator) {
  window.addEventListener('load', () => {
    navigator.serviceWorker.register('/sw.js').catch((e) => console.warn('Service worker registration failed:', e));
  });
}
