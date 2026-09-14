// Zero-dependency HTTP helper for the smoke tests. Uses Node's built-in
// fetch (Node 18+), so there's nothing new to `npm install` to run these.

const BASE_URL = process.env.TEST_BASE_URL || 'http://localhost:3000';

async function req(path, { method = 'GET', token, body } = {}) {
  const res = await fetch(`${BASE_URL}/api${path}`, {
    method,
    headers: {
      'Content-Type': 'application/json',
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
    },
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
  let data = null;
  try { data = await res.json(); } catch { /* empty/non-JSON body — fine for some endpoints */ }
  return { status: res.status, ok: res.ok, data };
}

// Same 5-digit UID scheme as db/database.js's buildUid — duplicated here
// deliberately rather than imported, since these tests exercise the app
// purely as an outside HTTP client, the same way a real browser would.
function buildUid(block, floor, room, bed) {
  return `${block}${floor}${String(room).padStart(2, '0')}${bed}`;
}

// A tiny 1x1 transparent PNG, base64-encoded — enough to satisfy "please
// attach a screenshot" without needing a real image file on disk.
const TINY_PNG_BASE64 =
  'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=';

module.exports = { req, buildUid, TINY_PNG_BASE64, BASE_URL };
