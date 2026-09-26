const express = require('express');
const db = require('../db/database');
const { withOrgScope } = require('../middleware/orgScope');
const { requireAuth } = require('../middleware/auth');
const { pushConfigured } = require('../lib/push');

const router = express.Router();

// Public VAPID key is, by design, not secret — it's meant to be embedded
// in frontend code (that's how the browser's Push API verifies messages
// really came from this server). Only the PRIVATE key needs protecting,
// and that never leaves lib/push.js.
router.get('/config', (req, res) => {
  res.json({ enabled: pushConfigured, publicKey: pushConfigured ? process.env.VAPID_PUBLIC_KEY : null });
});

router.post('/subscribe', requireAuth, withOrgScope, async (req, res) => {
  try {
    const { subscription } = req.body;
    if (!subscription?.endpoint || !subscription?.keys?.p256dh || !subscription?.keys?.auth) {
      return res.status(400).json({ error: 'Malformed subscription' });
    }
    await db.savePushSubscription(req.db, req.user.organizationId, {
      userType: req.user.type,
      userId: req.user.id,
      blockCode: req.user.type === 'admin' ? req.user.blockCode : null,
      endpoint: subscription.endpoint,
      p256dh: subscription.keys.p256dh,
      auth: subscription.keys.auth,
    });
    res.status(201).json({ ok: true });
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: 'Server error, please try again' });
  }
});

router.post('/unsubscribe', requireAuth, withOrgScope, async (req, res) => {
  try {
    const { endpoint } = req.body;
    if (endpoint) await db.removePushSubscription(req.db, req.user.organizationId, endpoint);
    res.json({ ok: true });
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: 'Server error, please try again' });
  }
});

module.exports = router;
