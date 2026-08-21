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
  // connection limit. The Transaction pooler (port 6543) is built to
  // handle many of these small pools concurrently.
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

module.exports = pool;
module.exports.timedQuery = timedQuery;
