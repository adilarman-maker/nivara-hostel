const express = require('express');
const crypto = require('crypto');
const Razorpay = require('razorpay');
const db = require('../db/database');
const { requireAuth, requireAdmin } = require('../middleware/auth');

const router = express.Router();

function requireTenant(req, res, next) {
  if (!req.user || req.user.type !== 'tenant') return res.status(403).json({ error: 'Tenant access required' });
  next();
}
function requireSuper(req, res, next) {
  if (req.user.role !== 'super') return res.status(403).json({ error: 'Super Admin only' });
  next();
}

// GET config — any logged-in tenant or admin can read it. Only the
// sanitized (secret-free) version ever leaves the server.
router.get('/config', requireAuth, async (req, res) => {
  try {
    const config = await db.getPaymentConfig();
    res.json({ config: db.sanitizePaymentConfig(config) });
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: 'Server error, please try again' });
  }
});

// PUT config — Super Admin only. This endpoint is shared by two separate
// settings forms (general payment settings, and Razorpay settings), so
// every field is merged against what's already saved rather than defaulted
// to blank — submitting one form must never wipe out the other's fields.
// Razorpay secret fields specifically are only overwritten if a non-empty
// value was submitted, so the settings screen never needs to display (or
// the admin re-type) a secret that's already configured.
router.put('/config', requireAuth, requireAdmin, requireSuper, async (req, res) => {
  try {
    const { upiId, payeeName, advanceAmount, rentByBedCount, razorpayKeyId, razorpayKeySecret, razorpayWebhookSecret } = req.body;
    if (upiId && !/^[\w.\-]{2,}@[\w.\-]{2,}$/.test(upiId)) {
      return res.status(400).json({ error: 'That doesn\'t look like a valid UPI ID (e.g. yourname@bank)' });
    }
    const existing = await db.getPaymentConfig();
    const config = {
      upiId: upiId !== undefined ? upiId : (existing.upiId || ''),
      payeeName: payeeName !== undefined ? payeeName : (existing.payeeName || 'Nivara Hostel & Stay'),
      advanceAmount: advanceAmount !== undefined ? (Number(advanceAmount) || 0) : (existing.advanceAmount || 0),
      rentByBedCount: rentByBedCount !== undefined ? rentByBedCount : (existing.rentByBedCount || {}),
      razorpayKeyId: razorpayKeyId !== undefined ? razorpayKeyId : (existing.razorpayKeyId || ''),
      razorpayKeySecret: razorpayKeySecret ? razorpayKeySecret : (existing.razorpayKeySecret || ''),
      razorpayWebhookSecret: razorpayWebhookSecret ? razorpayWebhookSecret : (existing.razorpayWebhookSecret || ''),
    };
    await db.setPaymentConfig(config);
    await db.logAction(req.user.name, 'UPDATE_PAYMENT_CONFIG', 'Updated payment settings');
    res.json({ config: db.sanitizePaymentConfig(config) });
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: 'Server error, please try again' });
  }
});

// ---------- tenant self-service ----------

router.get('/me', requireAuth, requireTenant, async (req, res) => {
  try {
    const tenant = await db.getTenantById(req.user.id);
    if (!tenant) return res.status(404).json({ error: 'Tenant record not found' });
    const currentDue = await db.ensureCurrentDue(tenant);
    const history = await db.listPaymentsForTenant(tenant.id);
    res.json({ currentDue, history });
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: 'Server error, please try again' });
  }
});

// Tenant self-declares they've completed a payment (via QR/UPI app, outside this system)
router.post('/:id/pay', requireAuth, requireTenant, async (req, res) => {
  try {
    const payment = await db.getPaymentById(req.params.id);
    if (!payment || payment.tenantId !== req.user.id) {
      return res.status(404).json({ error: 'Payment not found' });
    }
    if (payment.status === 'paid') return res.status(409).json({ error: 'Already marked as paid' });

    const updated = await db.markPaymentPaid(payment.id, 'self_declared');
    const tenant = await db.getTenantById(req.user.id);
    await db.logAction(
      tenant.name,
      'TENANT_SELF_DECLARED_PAYMENT',
      `${tenant.name} (UID ${tenant.uid}) marked ${payment.period} payment of ₹${payment.amount} as paid`
    );
    res.json({ payment: updated });
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: 'Server error, please try again' });
  }
});

// ---------- Razorpay ----------

async function getRazorpayClient() {
  const config = await db.getPaymentConfig();
  if (!config.razorpayKeyId || !config.razorpayKeySecret) {
    const err = new Error('Online payment is not set up yet — the hostel admin needs to add Razorpay keys in Payments → Settings.');
    err.status = 400;
    throw err;
  }
  return { client: new Razorpay({ key_id: config.razorpayKeyId, key_secret: config.razorpayKeySecret }), config };
}

// Tenant starts a Razorpay checkout for one of their own due payments.
router.post('/:id/razorpay/order', requireAuth, requireTenant, async (req, res) => {
  try {
    const payment = await db.getPaymentById(req.params.id);
    if (!payment || payment.tenantId !== req.user.id) {
      return res.status(404).json({ error: 'Payment not found' });
    }
    if (payment.status === 'paid') return res.status(409).json({ error: 'Already paid' });

    const { client, config } = await getRazorpayClient();
    // Razorpay amounts are in the smallest currency unit (paise for INR).
    const order = await client.orders.create({
      amount: Math.round(payment.amount * 100),
      currency: 'INR',
      receipt: payment.id,
      notes: { tenantId: req.user.id, paymentId: payment.id, period: payment.period },
    });

    await db.setPaymentGatewayOrder(payment.id, order.id);
    res.json({
      orderId: order.id,
      amount: order.amount,
      currency: order.currency,
      keyId: config.razorpayKeyId,
      payeeName: config.payeeName,
    });
  } catch (e) {
    if (e.status) return res.status(e.status).json({ error: e.message });
    console.error(e);
    res.status(500).json({ error: 'Could not start payment — please try again' });
  }
});

// Called by the frontend immediately after Razorpay's checkout success
// handler fires — gives a fast UI update. The webhook below is the true
// source of truth and will independently mark this paid even if the
// tenant closes their browser right after paying and this never runs.
router.post('/:id/razorpay/verify', requireAuth, requireTenant, async (req, res) => {
  try {
    const payment = await db.getPaymentById(req.params.id);
    if (!payment || payment.tenantId !== req.user.id) {
      return res.status(404).json({ error: 'Payment not found' });
    }

    const { razorpay_order_id, razorpay_payment_id, razorpay_signature } = req.body;
    if (!razorpay_order_id || !razorpay_payment_id || !razorpay_signature) {
      return res.status(400).json({ error: 'Missing payment confirmation details' });
    }
    if (payment.gatewayOrderId !== razorpay_order_id) {
      return res.status(400).json({ error: 'Order mismatch' });
    }

    const config = await db.getPaymentConfig();
    const expectedSignature = crypto
      .createHmac('sha256', config.razorpayKeySecret)
      .update(`${razorpay_order_id}|${razorpay_payment_id}`)
      .digest('hex');

    if (expectedSignature !== razorpay_signature) {
      return res.status(400).json({ error: 'Payment could not be verified' });
    }

    const { payment: updated } = await db.markPaymentPaidViaGateway(payment.id, razorpay_payment_id);
    const tenant = await db.getTenantById(req.user.id);
    await db.logAction(
      tenant.name,
      'RAZORPAY_PAYMENT_VERIFIED',
      `${tenant.name} (UID ${tenant.uid}) paid ${payment.period} (₹${payment.amount}) via Razorpay`
    );
    res.json({ payment: updated });
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: 'Server error, please try again' });
  }
});

// GET full payment history for one tenant — used by the admin's bed-detail view.
// Block-scoped: sub-admins can only view tenants in their own block.
router.get('/tenant/:tenantId', requireAuth, requireAdmin, async (req, res) => {
  try {
    const tenant = await db.getTenantById(req.params.tenantId);
    if (!tenant) return res.status(404).json({ error: 'Tenant not found' });
    const parsed = db.parseUid(tenant.uid);
    if (req.user.role !== 'super' && req.user.blockCode !== parsed.block) {
      return res.status(403).json({ error: 'You can only view payments in your own block' });
    }
    const history = await db.listPaymentsForTenantAdmin(tenant.id);
    res.json({ history });
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: 'Server error, please try again' });
  }
});

// ---------- admin dues overview ----------

// GET /api/payments/dues?block=1 — sub-admins are forced to their own block
// regardless of what they pass; Super Admin can pass a block or omit it for all.
router.get('/dues', requireAuth, requireAdmin, async (req, res) => {
  try {
    let blockCode = req.query.block ? parseInt(req.query.block, 10) : null;
    if (req.user.role === 'sub') blockCode = req.user.blockCode; // sub-admins can never see other blocks' dues
    if (blockCode && !db.BLOCKS[blockCode]) return res.status(400).json({ error: 'Invalid block' });

    const overview = await db.getDuesOverview(blockCode);
    res.json(overview);
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: 'Server error, please try again' });
  }
});

// Admin marks a payment paid manually (e.g. cash handed over in person)
router.post('/:id/mark-paid', requireAuth, requireAdmin, async (req, res) => {
  try {
    const payment = await db.getPaymentById(req.params.id);
    if (!payment) return res.status(404).json({ error: 'Payment not found' });

    const tenant = await db.getTenantById(payment.tenantId);
    const parsed = db.parseUid(tenant.uid);
    if (req.user.role !== 'super' && req.user.blockCode !== parsed.block) {
      return res.status(403).json({ error: 'You can only manage payments in your own block' });
    }
    if (payment.status === 'paid') return res.status(409).json({ error: 'Already marked as paid' });

    const updated = await db.markPaymentPaid(payment.id, 'admin_marked');
    await db.logAction(
      req.user.name,
      'ADMIN_MARKED_PAYMENT_PAID',
      `Marked ${tenant.name}'s ${payment.period} payment of ₹${payment.amount} as paid`
    );
    res.json({ payment: updated });
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: 'Server error, please try again' });
  }
});

module.exports = router;
