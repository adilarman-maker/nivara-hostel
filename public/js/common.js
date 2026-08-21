// ---------- tiny API helper ----------
async function api(path, { method = 'GET', body, auth = true } = {}) {
  const headers = { 'Content-Type': 'application/json' };
  if (auth) {
    const token = localStorage.getItem('nivara_token');
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
  localStorage.setItem('nivara_token', token);
  localStorage.setItem('nivara_user', JSON.stringify(user));
}
function getSession() {
  const token = localStorage.getItem('nivara_token');
  const userRaw = localStorage.getItem('nivara_user');
  if (!token || !userRaw) return null;
  try { return { token, user: JSON.parse(userRaw) }; } catch (_) { return null; }
}
function clearSession() {
  localStorage.removeItem('nivara_token');
  localStorage.removeItem('nivara_user');
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
const BLOCK_META = {
  1: { name: 'Veera', type: 'Boys Hostel', css: 'b1' },
  2: { name: 'Dheera', type: 'Boys Premium', css: 'b2' },
  3: { name: 'Shakthi', type: 'Girls Hostel', css: 'b3' },
  4: { name: 'Karuna', type: 'Hotel / Lodge', css: 'b4' },
};

function parseUidClient(uid) {
  if (!/^\d{5}$/.test(uid || '')) return null;
  const block = parseInt(uid[0], 10);
  const floor = parseInt(uid[1], 10);
  const room = parseInt(uid.slice(2, 4), 10);
  const bed = parseInt(uid[4], 10);
  if (!BLOCK_META[block] || room < 1 || bed < 1) return null;
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
  if (!meta) return '';
  return `<span class="badge-block ${meta.css}">${meta.name}</span>`;
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
    `Welcome to Nivara Hostel, ${tenant.name}! 🌿\n\n` +
    `Your login details:\nUID: ${tenant.uid}\nPhone: ${tenant.phone}\n\n` +
    `Log in here: ${siteUrl}\n\n` +
    `⚠️ Keep your UID and phone private — don't share them with anyone.`;

  const waPhone = '91' + tenant.phone; // India country code
  document.getElementById('waSendLink').href = `https://wa.me/${waPhone}?text=${encodeURIComponent(message)}`;
  backdrop.classList.add('show');
}
