const { Pool } = require('pg');

if (!process.env.DATABASE_URL) {
  console.warn('\n⚠️  DATABASE_URL is not set. Copy .env.example to .env and fill it in.\n');
}

// Supabase (and most hosted Postgres) require SSL, but issue certs that
// Node's default trust store doesn't recognize — rejectUnauthorized:false
// is the standard, safe-enough setting for this (the connection is still
// encrypted; we're just not verifying the CA chain). Local Postgres
// (used only for development/testing) doesn't need SSL at all.
const isLocal = (process.env.DATABASE_URL || '').includes('localhost')
  || (process.env.DATABASE_URL || '').includes('127.0.0.1');

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: isLocal ? false : { rejectUnauthorized: false },
  // Serverless functions can spin up many short-lived instances at once —
  // keep each instance's pool small so we don't exhaust Supabase's
  // connection limit. Using the Session pooler (not Transaction mode) is
  // required here: getOrgClient() below sets a session-level RLS variable
  // on a checked-out client and expects it to stick around for the whole
  // request — under Transaction-mode pooling, a later query in the same
  // request could silently land on a different backend connection that
  // never got that SET, which is a data-isolation risk, not just a
  // performance one. The trade-off: Session mode holds one real backend
  // connection per checked-out client for its whole lifetime, so it has a
  // lower concurrency ceiling than Transaction mode — worth knowing if you
  // ever see connection-exhaustion errors under real concurrent load.
  max: 5,
  idleTimeoutMillis: 10000,
  connectionTimeoutMillis: 10000,
});

// Slow-query logging — supports the "measure → identify → fix" debugging
// workflow directly: if something feels slow, check Vercel's function logs
// for a SLOW QUERY line before guessing at code changes. Threshold is
// configurable via SLOW_QUERY_MS (defaults to 200ms); set it to a very high
// number to effectively disable this if it gets noisy.
const SLOW_QUERY_MS = Number(process.env.SLOW_QUERY_MS) || 200;

function logIfSlow(text, start) {
  const duration = Date.now() - start;
  if (duration > SLOW_QUERY_MS) {
    const preview = typeof text === 'string' ? text.replace(/\s+/g, ' ').slice(0, 150) : '[query object]';
    console.warn(`SLOW QUERY (${duration}ms): ${preview}`);
  }
}

const originalQuery = pool.query.bind(pool);
pool.query = async (text, params) => {
  const start = Date.now();
  try {
    return await originalQuery(text, params);
  } finally {
    logIfSlow(text, start);
  }
};

// NOTE: we deliberately do NOT wrap pool.connect() the same way. pg's own
// internal implementation of pool.query() calls pool.connect() using a
// callback-style signature — overriding it broke that internal call and
// caused every query to hang. If you need slow-query visibility inside a
// transaction (a client from pool.connect()), use timedQuery() below at
// each call site instead of wrapping connect() globally.
async function timedQuery(client, text, params) {
  const start = Date.now();
  try {
    return await client.query(text, params);
  } finally {
    logIfSlow(text, start);
  }
}

// Checks out ONE dedicated client for the lifetime of a single request and
// pins the Postgres session variable app.org_id to it, which every table's
// RLS policy checks (see the DO block at the end of db/schema.sql). This is
// deliberately NOT done via pool.query() — pool.query() grabs a random
// client from the pool per call, so setting a session var there wouldn't
// reliably apply to the next query. See middleware/orgScope.js for how this
// gets attached to req.db and released when the request finishes.
//
// set_config(..., false) — the `false` means session-level (not
// transaction-local), so it stays set for every query run on this client
// until we override it again. Since we ALWAYS re-set it immediately after
// checkout, it's safe even though the underlying physical connection gets
// reused by other requests later.
async function getOrgClient(organizationId) {
  if (!organizationId) {
    throw new Error('getOrgClient called without an organizationId — refusing to hand out an unscoped DB client');
  }
  const client = await pool.connect();
  await client.query(`SELECT set_config('app.org_id', $1, false)`, [String(organizationId)]);
  return client;
}

module.exports = pool;
module.exports.timedQuery = timedQuery;
module.exports.getOrgClient = getOrgClient;
