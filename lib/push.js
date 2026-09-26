// Thin wrapper around the web-push library. Fully self-hosted — no
// Firebase, no third-party push service account needed, just a VAPID key
// pair (a public/private key pair specific to THIS app, generated once).
//
// SETUP REQUIRED (see the README section this ships with):
//   VAPID_PUBLIC_KEY, VAPID_PRIVATE_KEY, VAPID_CONTACT_EMAIL in your .env
//   and Vercel environment variables.
//
// Until those are set, every send silently no-ops (logged once, not per
// call) rather than throwing — a missing notification config should never
// break the actual feature (confirming a payment, resolving a complaint)
// that triggered the notification attempt.

const webpush = require('web-push');

const configured = !!(process.env.VAPID_PUBLIC_KEY && process.env.VAPID_PRIVATE_KEY);
if (configured) {
  webpush.setVapidDetails(
    `mailto:${process.env.VAPID_CONTACT_EMAIL || 'admin@example.com'}`,
    process.env.VAPID_PUBLIC_KEY,
    process.env.VAPID_PRIVATE_KEY
  );
} else {
  console.warn('[push] VAPID_PUBLIC_KEY/VAPID_PRIVATE_KEY not set — push notifications are disabled until they are.');
}

// subscriptions: array of {endpoint, p256dh, auth} rows straight from the
// database. payload: plain object — becomes the JSON the service worker's
// `push` event handler receives (see public/sw.js).
async function sendPush(subscriptions, payload) {
  if (!configured || !subscriptions || subscriptions.length === 0) return;
  const body = JSON.stringify(payload);
  await Promise.allSettled(subscriptions.map((sub) =>
    webpush.sendNotification(
      { endpoint: sub.endpoint, keys: { p256dh: sub.p256dh, auth: sub.auth } },
      body
    ).catch((err) => {
      // A 410/404 means the browser itself has invalidated this
      // subscription (uninstalled, cleared data, expired) — that's
      // expected and routine, not an error worth logging loudly.
      if (err?.statusCode !== 410 && err?.statusCode !== 404) {
        console.warn('[push] send failed:', err?.statusCode, err?.body || err?.message);
      }
    })
  ));
}

module.exports = { sendPush, pushConfigured: configured };
