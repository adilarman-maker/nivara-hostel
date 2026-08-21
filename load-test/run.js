#!/usr/bin/env node
/**
 * Nivara load test — Phase 6 of the performance plan.
 *
 * What this does: logs in once as an admin, then hits a handful of your
 * busiest real endpoints at increasing levels of concurrency (10 → 50 → 100
 * → 200 → 500 connections), and prints latency/throughput/error numbers for
 * each level so you can see exactly where things start to degrade —
 * matching the "10 → 50 → 100 → 200 → 500 users" ramp from the plan.
 *
 * USAGE
 *   node load-test/run.js
 *
 * CONFIG (environment variables, all optional except noted)
 *   BASE_URL          Target server. Default: http://localhost:3000
 *   ADMIN_UID         An admin's login UID.  Default: 00001 (Super Admin starter)
 *   ADMIN_PHONE       That admin's phone.    Default: 6302126347 (starter)
 *   ADMIN_PASSWORD    That admin's password. Default: Super@123 (starter)
 *   DURATION_SECS     How long each concurrency level runs. Default: 10
 *   LEVELS            Comma-separated connection counts. Default: 10,50,100,200,500
 *   CONFIRM_PRODUCTION Must be exactly "yes" to run against a non-localhost BASE_URL.
 *
 * SAFETY
 *   Running this against your LIVE production site will generate real load
 *   against your real Supabase database and count against your Vercel
 *   function invocations. Test against a local server or a separate
 *   staging deployment/database first. If BASE_URL isn't localhost, you
 *   must explicitly set CONFIRM_PRODUCTION=yes or this script refuses to run.
 */

const autocannon = require('autocannon');

const BASE_URL = process.env.BASE_URL || 'http://localhost:3000';
const ADMIN_UID = process.env.ADMIN_UID || '00001';
const ADMIN_PHONE = process.env.ADMIN_PHONE || '6302126347';
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || 'Super@123';
const DURATION_SECS = Number(process.env.DURATION_SECS) || 10;
const LEVELS = (process.env.LEVELS || '10,50,100,200,500').split(',').map(Number);

async function main() {
  const isLocal = BASE_URL.includes('localhost') || BASE_URL.includes('127.0.0.1');
  if (!isLocal && process.env.CONFIRM_PRODUCTION !== 'yes') {
    console.error(`\n⚠️  BASE_URL is "${BASE_URL}" — this doesn't look like localhost.`);
    console.error('This will generate real load against a real database.');
    console.error('If you\'re sure, re-run with CONFIRM_PRODUCTION=yes set.\n');
    process.exit(1);
  }

  console.log(`\nLogging in to ${BASE_URL} as ${ADMIN_UID}…`);
  const loginRes = await fetch(`${BASE_URL}/api/auth/admin-login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ uid: ADMIN_UID, phone: ADMIN_PHONE, password: ADMIN_PASSWORD }),
  });
  if (!loginRes.ok) {
    console.error(`Login failed (${loginRes.status}). Check ADMIN_UID/ADMIN_PHONE/ADMIN_PASSWORD.`);
    process.exit(1);
  }
  const { token } = await loginRes.json();
  console.log('Logged in ✓\n');

  const authHeader = { authorization: `Bearer ${token}` };

  // The endpoints your dashboard actually calls most — this is deliberately
  // NOT exhaustive (per the plan's "don't over-engineer" principle). If you
  // add a new heavy endpoint later, add it to this list.
  const targets = [
    { name: 'Health check (baseline, no DB)', path: '/health', auth: false },
    { name: 'Tenants list (paginated)', path: '/api/tenants?page=1&limit=50', auth: true },
    { name: 'Tenants search', path: '/api/tenants?search=a&limit=50', auth: true },
    { name: 'Rooms browser (block 1)', path: '/api/rooms?block=1', auth: true },
    { name: 'Payments dues overview', path: '/api/payments/dues', auth: true },
    { name: 'Dashboard summary', path: '/api/admin/summary', auth: true },
  ];

  const results = [];

  for (const target of targets) {
    console.log(`\n━━━ ${target.name} (${target.path}) ━━━`);
    for (const connections of LEVELS) {
      const result = await autocannon({
        url: BASE_URL + target.path,
        connections,
        duration: DURATION_SECS,
        headers: target.auth ? authHeader : {},
      });

      const row = {
        endpoint: target.name,
        connections,
        reqPerSec: result.requests.average,
        latencyMs: result.latency.average,
        p99Ms: result.latency.p99,
        errors: result.errors,
        timeouts: result.timeouts,
        non2xx: result['2xx'] !== undefined ? (result.non2xx || 0) : 0,
      };
      results.push(row);

      console.log(
        `  ${String(connections).padStart(3)} conns → ` +
        `${row.reqPerSec.toFixed(0).padStart(5)} req/s | ` +
        `avg ${row.latencyMs.toFixed(0).padStart(4)}ms | ` +
        `p99 ${String(row.p99Ms).padStart(5)}ms | ` +
        `errors: ${row.errors}, timeouts: ${row.timeouts}, non-2xx: ${row.non2xx}`
      );

      // If something's already failing badly at this level, no point grinding
      // through higher levels for THIS endpoint — move to the next one.
      if (row.errors > 0 || row.timeouts > 0 || row.non2xx > result.requests.total * 0.05) {
        console.log(`  ⚠️  Errors/timeouts appearing at ${connections} connections — stopping this endpoint's ramp here.`);
        break;
      }
    }
  }

  console.log('\n\n━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
  console.log('SUMMARY — what to look at');
  console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
  console.log('• avg/p99 latency climbing steeply as connections increase → bottleneck found, check Vercel/DB logs for SLOW REQUEST or SLOW QUERY lines at that point in time.');
  console.log('• errors/timeouts appearing → you found your actual current ceiling for that endpoint.');
  console.log('• req/s flattening while latency keeps climbing → the server is saturated, not just slow.');
  console.log('\nRe-run after any fix to confirm it actually helped — don\'t guess, measure.\n');
}

main().catch((e) => {
  console.error('Load test failed:', e.message);
  process.exit(1);
});
