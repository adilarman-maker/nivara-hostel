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

// ---------- Shared "instant paint from cache, refresh silently" helper ----------
// Same trick used on Overview/Payments, generalized: render whatever we
// last saw for this device immediately (zero network wait), then fetch
// the real current data in the background and re-render when it arrives.
// This is what makes switching between tabs feel instant on the second
// visit onward, instead of a blank/skeleton pause every single time.
async function swrLoad(cacheKey, fetchFn, renderFn) {
  try {
    const cached = sessionStorage.getItem(cacheKey);
    if (cached) renderFn(JSON.parse(cached));
  } catch (_) { /* corrupt cache entry — ignore, the fetch below still runs */ }

  const data = await fetchFn();
  renderFn(data);
  try { sessionStorage.setItem(cacheKey, JSON.stringify(data)); } catch (_) { /* storage full/disabled — not fatal */ }
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
  if (!confirm('Log out of Getnesty?')) return;
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

// ---------- Back button should close an open modal/sheet, not exit the app ----------
// Every modal and sheet in this app already follows the same convention:
// open = add the "show" class, close = remove it. Rather than retrofit
// every individual modal's open/close code, this watches for that class
// change generically and does the right thing with browser history:
//   - opening a modal/sheet pushes a throwaway history entry
//   - the Android/gesture back button then naturally lands on that entry
//     first (closing the modal) instead of leaving the app entirely
//   - closing a modal normally (Cancel/X/backdrop tap) consumes that same
//     entry by itself, so back-button behavior stays correct afterward too
(function () {
  let depth = 0;
  let respondingToPopstate = false;
  let backPending = false;

  function isOverlay(el) {
    return el.nodeType === 1 && el.classList && (el.classList.contains('modal-backdrop') || el.classList.contains('sheet-backdrop'));
  }

  const observer = new MutationObserver((mutations) => {
    for (const m of mutations) {
      if (m.attributeName !== 'class' || !isOverlay(m.target)) continue;
      const wasShown = (m.oldValue || '').split(/\s+/).includes('show');
      const isShown = m.target.classList.contains('show');
      if (isShown && !wasShown) {
        history.pushState({ getnestyOverlay: true }, '');
        depth++;
      } else if (!isShown && wasShown && !respondingToPopstate && !backPending && depth > 0) {
        backPending = true;
        history.back();
      }
    }
  });
  observer.observe(document.body, { attributes: true, attributeFilter: ['class'], attributeOldValue: true, subtree: true });

  window.addEventListener('popstate', () => {
    if (depth <= 0) return; // nothing of ours open — let the browser do its normal thing (exit/navigate)
    respondingToPopstate = true;
    depth--;
    backPending = false;
    document.querySelectorAll('.modal-backdrop.show, .sheet-backdrop.show').forEach((el) => el.classList.remove('show'));
    respondingToPopstate = false;
  });
})();


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
// Includes all FOUR things a tenant now needs in one message — Hostel ID,
// UID, phone, and the app link to install Getnesty — not split across
// separate messages or left implicit.
//
// This runs as a fire-and-forget call right after "tenant created" at both
// call sites (admin.js and rooms.js) — neither awaits it or catches a
// rejection. That means any unhandled error in here would otherwise fail
// completely silently: the tenant still saved, the "Tenant added" toast
// still showed, and the WhatsApp modal just... never appeared, with nothing
// in the UI to explain why. Wrapping the whole thing turns that into a
// visible, debuggable failure instead of a silent no-op.
async function openWhatsAppInviteModal(tenant) {
  try {
    const backdrop = document.getElementById('waModalBackdrop');
    if (!backdrop) { console.warn('[Getnesty] #waModalBackdrop not found on this page — modal skipped.'); return; }
    document.getElementById('waModalSub').textContent = `Send ${tenant.name} their login details.`;
    document.getElementById('waKeycardHolder').innerHTML = renderKeycard(tenant.uid);

    const siteUrl = window.location.origin;
    const hostelId = await getCachedOrgSlug();
    const message =
      `Welcome to Getnesty Hostel, ${tenant.name}! 🌿\n\n` +
      `Your login details:\n` +
      `Hostel ID: ${hostelId || '(ask the hostel office)'}\n` +
      `UID: ${tenant.uid}\n` +
      `Phone: ${tenant.phone}\n\n` +
      `📲 Install the Getnesty app: ${siteUrl}\n` +
      `(Open the link, then use "Add to Home Screen" / "Install" — no app store needed.)\n\n` +
      `Sign in with the details above.\n\n` +
      `⚠️ Keep these details private — don't share them with anyone.`;
    // On localhost this link will literally read "http://localhost:3000",
    // which only works on THIS machine — that's expected while developing,
    // not a bug. Once deployed, siteUrl becomes the real public address and
    // the same link works for the tenant on their own phone.

    const waPhone = '91' + tenant.phone; // India country code — the chat opens addressed to the tenant
    const waUrl = `https://wa.me/${waPhone}?text=${encodeURIComponent(message)}`;

    const sendBtn = document.getElementById('waSendLink');
    // waSendLink is a real <a target="_blank"> in the markup, not a button
    // with a scripted window.open(). A script-initiated window.open() is
    // exactly what Chrome's pop-up blocker sometimes intercepts — and the
    // old fallback for that case (window.location.href = waUrl) then
    // navigated the CURRENT tab to wa.me instead, which is what was closing
    // the whole Getnesty admin tab out from under the admin. A genuine
    // <a href target="_blank"> click is treated as normal navigation, not a
    // popup, so browsers never block or hijack it this way — this always
    // sends FROM whatever WhatsApp account is on the admin's own device,
    // since wa.me has no separate "from" identity to configure.
    sendBtn.href = waUrl;
    // Close the modal once they've actually tapped Send — on a standalone
    // installed app there's no separate browser tab to glance back from, so
    // leaving the "Tenant added" modal sitting open after the WhatsApp share
    // sheet opens can look like nothing happened. Runs after the link's own
    // navigation has already been dispatched, so it never affects where the
    // click actually goes.
    sendBtn.onclick = () => { backdrop.classList.remove('show'); };

    // Guaranteed fallback that works regardless of whether WhatsApp is
    // reachable/installed on this machine (very often NOT the case on a
    // localhost dev box) — copies the exact message text so it can be
    // pasted anywhere (WhatsApp, SMS, email) by hand as a last resort.
    const copyBtn = document.getElementById('waCopyLink');
    if (copyBtn) {
      copyBtn.onclick = async () => {
        try {
          await navigator.clipboard.writeText(message);
          toast('Message copied — paste it anywhere', 'ok');
        } catch (_) {
          toast('Could not copy automatically — select and copy the text manually', 'err');
        }
      };
    }

    backdrop.classList.add('show');
  } catch (e) {
    console.error('WhatsApp invite modal failed:', e);
    toast('Tenant was saved, but the WhatsApp message could not be prepared. Open the tenant\'s profile to send it manually.', 'err');
  }
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
      if (res && res.slug) sessionStorage.setItem('getnesty_org_slug', res.slug);
    }).catch(() => {}); // not fatal — the app brand alone still shows fine
  }
}

// Used wherever we need the Hostel ID itself (not just the display name) —
// e.g. composing the WhatsApp invite message below, since a tenant can't
// actually log in without it. Same sessionStorage cache as the name badge.
async function getCachedOrgSlug() {
  const cached = sessionStorage.getItem('getnesty_org_slug');
  if (cached) return cached;
  try {
    const res = await api('/auth/organization');
    if (res && res.slug) sessionStorage.setItem('getnesty_org_slug', res.slug);
    if (res && res.name) sessionStorage.setItem('getnesty_org_name', res.name);
    return res?.slug || '';
  } catch (_) { return ''; }
}

// ---------- Unread-messages badge ----------
// Reuses the existing GET /messages?after=... (already scoped correctly
// per admin/sub-admin/tenant visibility) rather than a separate endpoint —
// asking "is there anything newer than the last thing I saw" is exactly
// what that endpoint already answers when given a timestamp and limit=1.
const LAST_SEEN_KEY = 'getnesty_messages_last_seen';

function showMessagesBadge(show) {
  document.querySelectorAll('[data-icon="messageCircle"]').forEach((iconEl) => {
    const host = iconEl.closest('.nav-item, .mtab, .sheet-item') || iconEl.parentElement;
    if (!host) return;
    host.classList.toggle('has-unread', !!show);
  });
}

async function checkUnreadMessages() {
  try {
    const after = localStorage.getItem(LAST_SEEN_KEY) || new Date(0).toISOString();
    const res = await api(`/messages?after=${encodeURIComponent(after)}&limit=1`);
    showMessagesBadge(res.messages && res.messages.length > 0);
  } catch (_) { /* not fatal — badge just stays as it was */ }
}

// Call this when the person actually opens Messages — clears the badge and
// resets the "last seen" marker to now.
function markMessagesSeen() {
  localStorage.setItem(LAST_SEEN_KEY, new Date().toISOString());
  showMessagesBadge(false);
}
window.markMessagesSeen = markMessagesSeen;

if (getSession()) {
  checkUnreadMessages();
  // Reopening/refocusing the app re-checks for new messages, not just on
  // a hard page load — same trigger the PWA update check below uses.
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible') checkUnreadMessages();
  });
}

// ---------- Push notification subscription ----------
// Runs once per login session (effectively once per device — the browser
// only ever asks for notification permission the first time; after that
// it silently remembers the answer, so calling this on every page load is
// safe and just re-confirms the subscription rather than re-prompting).
function urlBase64ToUint8Array(base64String) {
  const padding = '='.repeat((4 - (base64String.length % 4)) % 4);
  const base64 = (base64String + padding).replace(/-/g, '+').replace(/_/g, '/');
  const rawData = atob(base64);
  return Uint8Array.from([...rawData].map((c) => c.charCodeAt(0)));
}

async function setupPushSubscription() {
  if (!('serviceWorker' in navigator) || !('PushManager' in window)) return; // browser doesn't support it — nothing to do
  try {
    const config = await api('/push/config', { auth: false });
    if (!config.enabled) return; // VAPID keys not set up on the server yet
    if (Notification.permission === 'denied') return; // respect a past "no"

    const reg = await navigator.serviceWorker.ready;
    let sub = await reg.pushManager.getSubscription();
    if (!sub) {
      if (Notification.permission !== 'granted') {
        const perm = await Notification.requestPermission();
        if (perm !== 'granted') return;
      }
      sub = await reg.pushManager.subscribe({
        userVisibleOnly: true,
        applicationServerKey: urlBase64ToUint8Array(config.publicKey),
      });
    }
    await api('/push/subscribe', { method: 'POST', body: { subscription: sub.toJSON() } });
  } catch (e) {
    console.warn('Push subscription setup failed:', e); // never block the app over this
  }
}
if (getSession()) setupPushSubscription();

// ---------- PWA install support + auto-updating ----------
// Registering this here (rather than per-page) means every page that loads
// common.js — sign-in, admin console, tenant "My Stay", hostel info —
// picks up the service worker, which is what makes the browser consider
// Getnesty installable in the first place.
//
// By default, an installed PWA does NOT update itself the moment you ship
// a new version — the browser only checks for a new service worker
// occasionally, and even once it finds one, it normally waits until every
// open tab/window of the app is fully closed before switching over. For
// someone who installed this once and just keeps reopening it, that could
// mean running a stale, already-fixed-elsewhere version for a long time.
// This makes it behave like a normal website instead: check for updates
// every time the app is opened or brought to the foreground, and the
// moment a new version takes over, silently reload once to pick it up.
if ('serviceWorker' in navigator) {
  let hasReloadedForUpdate = false;
  navigator.serviceWorker.addEventListener('controllerchange', () => {
    if (hasReloadedForUpdate) return; // guard against a reload loop
    hasReloadedForUpdate = true;
    window.location.reload();
  });

  window.addEventListener('load', () => {
    navigator.serviceWorker.register('/sw.js').then((reg) => {
      // Don't just wait for the browser's own (slow, infrequent) update
      // check — actively ask right away, and again whenever the app
      // regains focus (covers "reopening the installed app" specifically).
      reg.update();
      document.addEventListener('visibilitychange', () => {
        if (document.visibilityState === 'visible') reg.update();
      });
    }).catch((e) => console.warn('Service worker registration failed:', e));
  });
}

// ---------- shared UI polish helpers (count-up, sparkline) ----------
// Used by every dashboard (admin Overview/Payments, tenant My Stay) so the
// "numbers come alive" and "tiny trend line" treatment looks and behaves
// identically everywhere instead of being reimplemented per page.
//
// Animates a number up to `target`. Cheap on purpose — no easing library,
// just a requestAnimationFrame tween — and safe to call repeatedly (each
// call cancels/replaces its own previous run via a per-element flag so a
// fast refresh never leaves two loops fighting over the same element).
function countUpEl(el, target, opts) {
  if (!el) return;
  const duration = (opts && opts.duration) || 700;
  const prefix = (opts && opts.prefix) || '';
  const suffix = (opts && opts.suffix) || '';
  const decimals = (opts && opts.decimals) || 0;
  target = Number(target) || 0;
  const runId = (el._countUpRun = (el._countUpRun || 0) + 1);
  // Continue from whatever's currently on screen (parsed back out of the
  // text) instead of always restarting at zero. This app paints instantly
  // from a cached snapshot and then quietly repaints with fresh data a
  // moment later (see swrLoad) — if every repaint reset to zero, that
  // second paint would visibly "double-glitch": the number would drop
  // back to 0 and count up all over again. Continuing from the current
  // value turns that into a smooth correction instead.
  const currentText = (el.textContent || '').replace(/[^0-9.-]/g, '');
  const start = currentText ? parseFloat(currentText) : 0;
  const t0 = performance.now();
  function frame(now) {
    if (el._countUpRun !== runId) return; // a newer call superseded this one
    const p = Math.min(1, (now - t0) / duration);
    const eased = 1 - Math.pow(1 - p, 3); // ease-out cubic
    const val = start + (target - start) * eased;
    el.textContent = prefix + val.toLocaleString('en-IN', { maximumFractionDigits: decimals, minimumFractionDigits: decimals }) + suffix;
    if (p < 1) requestAnimationFrame(frame);
  }
  requestAnimationFrame(frame);
}

// Builds a tiny inline SVG sparkline (no library) from an array of numbers.
function buildSparklineSvg(values, opts) {
  const w = (opts && opts.width) || 96;
  const h = (opts && opts.height) || 28;
  const stroke = (opts && opts.stroke) || '#E4CE83';
  if (!values || values.length < 2) return '';
  const max = Math.max(...values, 1);
  const min = Math.min(...values, 0);
  const range = max - min || 1;
  const step = w / (values.length - 1);
  const pts = values.map((v, i) => [i * step, h - ((v - min) / range) * (h - 4) - 2]);
  const path = pts.map((p, i) => (i === 0 ? 'M' : 'L') + p[0].toFixed(1) + ',' + p[1].toFixed(1)).join(' ');
  const areaPath = path + ` L${w},${h} L0,${h} Z`;
  const gid = 'sparkGrad' + Math.random().toString(36).slice(2, 8);
  return `<svg class="stat-sparkline" width="${w}" height="${h}" viewBox="0 0 ${w} ${h}">
    <defs><linearGradient id="${gid}" x1="0" y1="0" x2="0" y2="1">
      <stop offset="0%" stop-color="${stroke}" stop-opacity="0.55"/>
      <stop offset="100%" stop-color="${stroke}" stop-opacity="0"/>
    </linearGradient></defs>
    <path d="${areaPath}" fill="url(#${gid})" stroke="none"/>
    <path d="${path}" fill="none" stroke="${stroke}" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/>
  </svg>`;
}
