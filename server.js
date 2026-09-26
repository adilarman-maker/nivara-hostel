require('dotenv').config();
const express = require('express');
const cors = require('cors');
const compression = require('compression');
const path = require('path');
const pool = require('./db/pool');

const app = express();
app.use(cors());
// Gzips every response over ~1KB (its default threshold) — the Info page
// and Messages board in particular can carry sizeable embedded-image JSON
// payloads, and this typically cuts that transfer size by 60-80% for free.
app.use(compression());

// Default express.json() limit is 100kb — far too small for the base64
// image messages in the Messages board (capped at ~900KB client-side, see
// public/js/messages.js). 3mb gives headroom above that plus JSON overhead,
// while staying comfortably under Vercel's own ~4.5MB serverless request
// body ceiling.
app.use(express.json({ limit: '3mb' }));
// Lets the browser skip re-downloading CSS/JS/icons entirely (not just
// re-validating them) for repeat requests within this window — this app
// is multi-page (navigating to Hostel Info, for example, is a full page
// load, not an SPA route change), so this genuinely saves a full round
// trip per shared asset on every such navigation. Kept short (5 min)
// rather than the usual "cache forever" pattern, since this app is still
// under active, frequent development — a long cache would mean people
// keep seeing an old bug fix for hours after it's deployed.
app.use(express.static(path.join(__dirname, 'public'), {
  maxAge: '5m',
  setHeaders: (res, filePath) => {
    // The service worker script itself must never be cached — every check
    // for it needs to see the real current version immediately, or the
    // installed app's auto-update (see common.js) is stuck waiting out
    // whatever cache window everything else gets.
    if (filePath.endsWith('sw.js')) res.setHeader('Cache-Control', 'no-cache');
  },
}));

// Per-request timing — logs any API request slower than SLOW_REQUEST_MS
// (default 500ms), so "Getnesty is slow" reports become "which endpoint,
// how slow, when" instead of guesswork. Pairs with the slow-query logging
// in db/pool.js: a slow request + no slow query below it usually means the
// bottleneck is in application code, not the database.
const SLOW_REQUEST_MS = Number(process.env.SLOW_REQUEST_MS) || 500;
app.use((req, res, next) => {
  const start = Date.now();
  res.on('finish', () => {
    const duration = Date.now() - start;
    if (duration > SLOW_REQUEST_MS) {
      console.warn(`SLOW REQUEST (${duration}ms): ${req.method} ${req.originalUrl} → ${res.statusCode}`);
    }
  });
  next();
});

app.use('/api/auth', require('./routes/auth'));
app.use('/api/tenants', require('./routes/tenants'));
app.use('/api/admin', require('./routes/admin'));
app.use('/api/rooms', require('./routes/rooms'));
app.use('/api/payments', require('./routes/payments'));
app.use('/api/complaints', require('./routes/complaints'));
app.use('/api/blocks', require('./routes/blocks'));
app.use('/api/messages', require('./routes/messages'));
app.use('/api/platform', require('./routes/platform'));
app.use('/api/info', require('./routes/info'));
app.use('/api/push', require('./routes/push'));

// Deliberately touches the database (a trivial SELECT 1) rather than just
// returning JSON — a cold Node process is only half of what makes the
// first request after a lull slow; the other half is a fresh TLS
// handshake + auth to Postgres. Pinged automatically by the Vercel Cron
// job in vercel.json every 5 minutes, so the app rarely goes fully cold
// during hours real people might actually open it.
app.get('/health', async (req, res) => {
  try {
    await pool.query('SELECT 1');
    res.json({ ok: true, db: true });
  } catch (e) {
    res.json({ ok: true, db: false }); // app itself is up even if this one DB ping failed
  }
});

// Only start a real listening server for local development. On Vercel,
// this file is required by api/index.js instead, and Vercel itself
// invokes the exported `app` per-request as a serverless function —
// calling app.listen() there would be wrong (and is skipped below).
if (!process.env.VERCEL) {
  const PORT = process.env.PORT || 3000;
  app.listen(PORT, () => {
    console.log(`\nGETNESTY Hostel Management running → http://localhost:${PORT}\n`);
    console.log('If this is the first run, make sure you ran: npm run migrate\n');
  });
}

module.exports = app;
