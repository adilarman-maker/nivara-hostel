// A small, dependency-free rate limiter for login endpoints.
//
// Honest limitation: this state lives in the memory of ONE serverless
// function instance. Vercel can run several instances of your app at once
// under real traffic, and each has its OWN counters — so this is not a
// single global limit, more like "a limit per warm instance". That's still
// real protection (it makes brute-forcing meaningfully slower and noisier),
// just not a mathematically exact one. If that ever matters more than it
// does today (e.g. you're seeing coordinated abuse), the fix is a shared
// store like Upstash Redis — a genuinely different piece of infrastructure,
// not a tweak to this file.
//
// Keyed by IP + route, fixed window: N attempts per windowMs, then blocked
// until the window rolls over.

const buckets = new Map(); // key -> { count, resetAt }

// Prevent unbounded memory growth on a long-lived warm instance — sweep
// expired entries occasionally rather than on every request.
let lastSweep = Date.now();
function sweep() {
  const now = Date.now();
  if (now - lastSweep < 60_000) return;
  lastSweep = now;
  for (const [key, bucket] of buckets) {
    if (bucket.resetAt < now) buckets.delete(key);
  }
}

function clientIp(req) {
  // Vercel/most proxies set this; fall back to the raw socket address.
  const fwd = req.headers['x-forwarded-for'];
  if (fwd) return fwd.split(',')[0].trim();
  return req.socket?.remoteAddress || 'unknown';
}

// maxAttempts per windowMs, per (IP + route). Call as a route-level
// middleware: router.post('/check', loginRateLimit(20, 5*60_000), handler)
function loginRateLimit(maxAttempts, windowMs) {
  return (req, res, next) => {
    sweep();
    const key = `${req.baseUrl}${req.path}:${clientIp(req)}`;
    const now = Date.now();
    let bucket = buckets.get(key);
    if (!bucket || bucket.resetAt < now) {
      bucket = { count: 0, resetAt: now + windowMs };
      buckets.set(key, bucket);
    }
    bucket.count += 1;
    if (bucket.count > maxAttempts) {
      const retryAfterSec = Math.ceil((bucket.resetAt - now) / 1000);
      res.set('Retry-After', String(retryAfterSec));
      return res.status(429).json({ error: 'Too many attempts — please wait a few minutes and try again.' });
    }
    next();
  };
}

module.exports = { loginRateLimit };
