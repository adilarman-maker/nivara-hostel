# Nivara — Monitoring & Performance Debugging Guide

This is the reference for Phase 7 of the performance plan: what to actually
look at when something's slow or broken in production, instead of guessing.

## 1. Vercel dashboard — your app server

**Deployments → [latest] → Functions tab**
Shows every API invocation: duration, memory, cold starts, errors. If a
particular endpoint is consistently slow here, that's your starting point.

**Deployments → [latest] → Logs (or the standalone "Logs" tab)**
This is where the logging added in Phase 7 shows up:
- `SLOW REQUEST (Xms): GET /api/tenants → 200` — an API call took longer than
  500ms end-to-end.
- `SLOW QUERY (Xms): SELECT * FROM ...` — a single database query took
  longer than 200ms.

**How to read them together:**
| You see | It means |
|---|---|
| SLOW REQUEST with a SLOW QUERY right under it | The database query is the bottleneck — look at that query, check if it needs an index, or if it's fetching more than it needs. |
| SLOW REQUEST with NO slow query near it | The bottleneck is in your app code (JS logic, or several small fast queries adding up) — not the database itself. |
| Neither, but the user says it's slow | Check their network conditions first, or whether it's a large response body over a slow connection, not server-side at all. |

Both thresholds are adjustable without a code change — set `SLOW_REQUEST_MS`
and `SLOW_QUERY_MS` as environment variables in Vercel's project settings if
they're too noisy or not sensitive enough.

**Vercel Analytics / Speed Insights** (optional, paid on some plans): gives
you real-user latency graphs over time without reading raw logs. Worth
turning on once you have real tenant traffic, not essential before that.

## 2. Supabase dashboard — your database

**Database → Query Performance** (or **Reports**, naming varies by Supabase
version): shows your actual slowest queries ranked by total time spent,
straight from Postgres itself — the ground truth, independent of your app's
own logging.

**Database → Roles / Connection Pooling**: watch active connection count
here, especially under load. If you ever see it pinned near your plan's
connection limit, that's a sign to either lower `max` in `db/pool.js` or
upgrade your Supabase plan's connection limit — don't guess, check this
graph first.

**Reports → Database**: general CPU/memory/disk graphs for your Postgres
instance. Spikes here during a known traffic event (e.g. everyone paying
rent on the same day) are expected; sustained high usage with no clear
cause is worth investigating.

## 3. Uptime / availability

You already have a `/health` endpoint that requires no database connection.
Point a free uptime monitor (e.g. UptimeRobot, Better Uptime's free tier) at
`https://your-app.vercel.app/health` checking every 1-5 minutes. This tells
you if the app itself is down before a tenant has to tell you.

## 4. When someone says "Nivara is slow" — the actual workflow

1. Ask what they were doing (which page, which action).
2. Check Vercel's Logs for `SLOW REQUEST` around that time — which endpoint,
   how slow.
3. If there's a `SLOW QUERY` logged right alongside it, that query is your
   answer — go look at it in `db/database.js`.
4. If not, check Supabase's Query Performance report for the same window —
   sometimes a query is slow but under your 200ms logging threshold and
   still worth knowing about at scale.
5. Fix the specific thing you found — not a guess, the thing the logs
   actually pointed at.
6. Re-run `npm run loadtest` against a staging copy (see below) to confirm
   the fix actually helped, with real before/after numbers.

## 5. Running the load test (Phase 6)

```bash
npm run loadtest
```

By default this runs against `http://localhost:3000` with the starter Super
Admin credentials — safe to run any time against your own dev server.

**To test against a real deployment**, use a staging environment if you
have one (a separate Vercel deployment + separate Supabase project, so you
never generate artificial load against your real tenants' data):

```bash
BASE_URL=https://your-staging-app.vercel.app \
ADMIN_UID=00001 ADMIN_PHONE=6302126347 ADMIN_PASSWORD=Super@123 \
CONFIRM_PRODUCTION=yes \
npm run loadtest
```

The script refuses to run against any non-localhost URL unless
`CONFIRM_PRODUCTION=yes` is explicitly set — this is intentional, so you
never accidentally hammer your live site by forgetting to check `BASE_URL`.

**What it does:** logs in once, then hits your busiest real endpoints
(tenants list, search, rooms, dues, dashboard summary) at increasing
concurrency (10 → 50 → 100 → 200 → 500 connections by default), printing
requests/sec, average and p99 latency, and error counts at each level. It
stops ramping an endpoint early if errors/timeouts start appearing, since
that means you've already found its current ceiling.

**Reading the output:**
- Latency climbing steadily but staying error-free → the system is handling
  the load, just getting slower. Note the point where it starts feeling
  unacceptable to you.
- Errors or timeouts appearing → this is your actual current breaking
  point for that endpoint, right now, as built.
- Requests/sec flattening out while latency keeps climbing → the server is
  saturated, not merely slow — this is a real capacity ceiling.

Run this after any performance change to confirm it helped, with numbers —
not before/after guesses.

## 6. When you'd actually need to act on any of this

For a hostel with 600-700 tenants, most of this monitoring will show
"everything's fine" for a long time — the pagination, indexing, and N+1
fixes already done should comfortably handle that scale. The signals worth
setting a mental threshold for:

- p99 latency on the tenants/rooms/dues endpoints consistently above ~1s
  under normal (non-test) traffic
- Supabase connection count regularly near its limit
- Repeated `SLOW QUERY` lines for the same query in production logs

Any of those is a real signal to come back and optimize the specific thing
the logs point at — not a reason to rewrite anything preemptively.
