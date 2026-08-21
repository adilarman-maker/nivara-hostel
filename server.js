require('dotenv').config();
const express = require('express');
const cors = require('cors');
const path = require('path');

const app = express();
app.use(cors());

// The Razorpay webhook needs the raw request body (as bytes) to verify its
// signature — express.json() below would parse it first, which can subtly
// change the byte representation and break signature verification. So this
// one route is mounted with express.raw() and registered BEFORE the global
// express.json() middleware.
app.post(
  '/api/payments/razorpay/webhook',
  express.raw({ type: 'application/json' }),
  require('./routes/razorpayWebhook')
);

app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

// Per-request timing — logs any API request slower than SLOW_REQUEST_MS
// (default 500ms), so "Nivara is slow" reports become "which endpoint,
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

app.get('/health', (req, res) => res.json({ ok: true }));

// Only start a real listening server for local development. On Vercel,
// this file is required by api/index.js instead, and Vercel itself
// invokes the exported `app` per-request as a serverless function —
// calling app.listen() there would be wrong (and is skipped below).
if (!process.env.VERCEL) {
  const PORT = process.env.PORT || 3000;
  app.listen(PORT, () => {
    console.log(`\nNIVARA Hostel Management running → http://localhost:${PORT}\n`);
    console.log('If this is the first run, make sure you ran: npm run migrate\n');
  });
}

module.exports = app;
