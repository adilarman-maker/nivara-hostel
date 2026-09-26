const express = require('express');
const db = require('../db/database');
const { withOrgScope } = require('../middleware/orgScope');
const { requireAuth, requireAdmin, requireSuperAdmin } = require('../middleware/auth');
const { sendPush } = require('../lib/push');

const router = express.Router();

function requireTenant(req, res, next) {
  if (!req.user || req.user.type !== 'tenant') return res.status(403).json({ error: 'Tenant access required' });
  next();
}
function requireSuper(req, res, next) {
  if (req.user.role !== 'super') return res.status(403).json({ error: 'Super Admin only' });
  next();
}

const MAX_SCREENSHOT_BYTES = 1200000; // ~1.2MB after base64 overhead — mirrors the image cap elsewhere in this app

function newId(prefix) { return `${prefix}-${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`; }

// GET config — any logged-in tenant or admin can read it. Only the
// sanitized version ever leaves the server.
router.get('/config', requireAuth, withOrgScope, async (req, res) => {
  try {
    const config = await db.getPaymentConfig(req.db, req.user.organizationId);
    res.json({ config: db.sanitizePaymentConfig(config) });
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: 'Server error, please try again' });
  }
});

router.put('/config', requireAuth, withOrgScope, requireAdmin, requireSuper, async (req, res) => {
  try {
    const { advanceAmount, rentByBedCount } = req.body;
    const existing = await db.getPaymentConfig(req.db, req.user.organizationId);
    const config = {
      advanceAmount: advanceAmount !== undefined ? (Number(advanceAmount) || 0) : (existing.advanceAmount || 0),
      rentByBedCount: rentByBedCount !== undefined ? rentByBedCount : (existing.rentByBedCount || {}),
    };
    await db.setPaymentConfig(req.db, req.user.organizationId, config);
    await db.logAction(req.db, req.user.organizationId, req.user.name, 'UPDATE_PAYMENT_CONFIG', 'Updated payment settings');
    res.json({ config: db.sanitizePaymentConfig(config) });
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: 'Server error, please try again' });
  }
});

// ---------- scanners (Super Admin manages, everyone can read their own) ----------

router.get('/scanners', requireAuth, withOrgScope, requireAdmin, requireSuper, async (req, res) => {
  try {
    const scanners = await db.listScanners(req.db, req.user.organizationId);
    res.json({ scanners });
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: 'Server error, please try again' });
  }
});

// The tenant-facing lookup — resolves to their own block's scanner, falling
// back to the whole-hostel one.
router.get('/scanner', requireAuth, withOrgScope, requireTenant, async (req, res) => {
  try {
    const tenant = await db.getTenantById(req.db, req.user.organizationId, req.user.id);
    if (!tenant) return res.status(404).json({ error: 'Tenant record not found' });
    const parsed = db.parseUid(tenant.uid);
    const scanner = await db.getScannerForBlock(req.db, req.user.organizationId, parsed.block);
    res.json({ scanner });
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: 'Server error, please try again' });
  }
});

function validateScannerBody(body) {
  if (!body.accountName || !body.accountName.trim()) return 'Account holder name is required';
  if (body.qrImage && Buffer.byteLength(body.qrImage, 'utf8') > MAX_SCREENSHOT_BYTES) return 'QR image is too large';
  return null;
}

router.post('/scanners', requireAuth, withOrgScope, requireAdmin, requireSuper, async (req, res) => {
  try {
    const err = validateScannerBody(req.body);
    if (err) return res.status(400).json({ error: err });
    const { scopeBlock, accountName, accountDetails, qrImage, contactPhone } = req.body;
    if (scopeBlock && !(await db.blockExists(req.db, req.user.organizationId, scopeBlock))) {
      return res.status(400).json({ error: 'Invalid block' });
    }
    const scanner = await db.createScanner(req.db, req.user.organizationId, {
      id: newId('sc'), scopeBlock: scopeBlock || null, accountName: accountName.trim(), accountDetails, qrImage, contactPhone,
    });
    await db.logAction(req.db, req.user.organizationId, req.user.name, 'SCANNER_CREATED',
      `Added a payment scanner (${scopeBlock ? 'Block ' + scopeBlock : 'whole hostel'}) — ${accountName.trim()}`);
    res.status(201).json({ scanner });
  } catch (e) {
    if (e.code === '23505') return res.status(409).json({ error: 'A scanner already exists for that scope — edit or delete it first' });
    console.error(e);
    res.status(500).json({ error: 'Server error, please try again' });
  }
});

router.put('/scanners/:id', requireAuth, withOrgScope, requireAdmin, requireSuper, async (req, res) => {
  try {
    const err = validateScannerBody(req.body);
    if (err) return res.status(400).json({ error: err });
    const { accountName, accountDetails, qrImage, contactPhone } = req.body;
    const scanner = await db.updateScanner(req.db, req.user.organizationId, req.params.id, {
      accountName: accountName ? accountName.trim() : accountName, accountDetails, qrImage, contactPhone,
    });
    if (!scanner) return res.status(404).json({ error: 'Scanner not found' });
    res.json({ scanner });
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: 'Server error, please try again' });
  }
});

router.delete('/scanners/:id', requireAuth, withOrgScope, requireAdmin, requireSuper, async (req, res) => {
  try {
    const ok = await db.deleteScanner(req.db, req.user.organizationId, req.params.id);
    if (!ok) return res.status(404).json({ error: 'Scanner not found' });
    res.json({ deleted: true });
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: 'Server error, please try again' });
  }
});

// ---------- tenant self-service ----------

router.get('/me', requireAuth, withOrgScope, requireTenant, async (req, res) => {
  try {
    const tenant = await db.getTenantById(req.db, req.user.organizationId, req.user.id);
    if (!tenant) return res.status(404).json({ error: 'Tenant record not found' });
    await db.ensureCurrentDue(req.db, req.user.organizationId, tenant); // creates this month's rent row if it's due and doesn't exist yet
    const dues = await db.listUnpaidPaymentsForTenant(req.db, req.user.organizationId, tenant.id);
    const history = await db.listPaymentsForTenant(req.db, req.user.organizationId, tenant.id);
    const reminder = db.reminderTone(new Date().getDate());
    res.json({ dues, history, reminder });
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: 'Server error, please try again' });
  }
});

// A tenant's own proof submissions — the tenant dashboard polls this while
// one is pending, so a Super/Sub Admin confirming it shows up live without
// the tenant needing to refresh.
router.get('/proofs/mine', requireAuth, withOrgScope, requireTenant, async (req, res) => {
  try {
    const proofs = await db.listProofsForTenant(req.db, req.user.organizationId, req.user.id);
    res.json({ proofs });
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: 'Server error, please try again' });
  }
});

// Tenant uploads proof of a payment they made via the hostel's scanner —
// this does NOT mark anything paid yet. It sits as 'pending' until an admin
// reviews and confirms it (see /proofs/:id/approve below).
router.post('/:id/submit-proof', requireAuth, withOrgScope, requireTenant, async (req, res) => {
  try {
    const payment = await db.getPaymentById(req.db, req.user.organizationId, req.params.id);
    if (!payment || payment.tenantId !== req.user.id) {
      return res.status(404).json({ error: 'Payment not found' });
    }
    if (payment.status === 'paid') return res.status(409).json({ error: 'This is already fully paid' });
    if (await db.hasPendingProofForPayment(req.db, req.user.organizationId, payment.id)) {
      return res.status(409).json({ error: 'You already have a submission pending review for this payment' });
    }

    const { screenshot, utrReference, paidDate, claimedAmount } = req.body;
    if (!screenshot) return res.status(400).json({ error: 'Please attach a screenshot of the payment' });
    if (Buffer.byteLength(screenshot, 'utf8') > MAX_SCREENSHOT_BYTES) {
      return res.status(400).json({ error: 'That screenshot is too large — please use a smaller image' });
    }
    const amount = Number(claimedAmount);
    if (isNaN(amount) || amount <= 0) return res.status(400).json({ error: 'Enter a valid amount' });
    if (amount > payment.remaining + 0.5) {
      return res.status(400).json({ error: `That's more than the ₹${payment.remaining} remaining on this payment — check the amount and try again` });
    }

    const proof = await db.createPaymentProof(req.db, req.user.organizationId, {
      id: newId('pp'), paymentId: payment.id, tenantId: req.user.id,
      screenshot, utrReference, paidDate, claimedAmount: amount,
    });

    const tenant = await db.getTenantById(req.db, req.user.organizationId, req.user.id);
    await db.logAction(req.db, req.user.organizationId, tenant.name, 'PAYMENT_PROOF_SUBMITTED',
      `${tenant.name} (UID ${tenant.uid}) submitted payment proof for ${payment.period} — claimed ₹${amount}`);

    // Fire-and-forget — a slow/failed push send should never delay or break
    // the actual submission response.
    const blockCode = db.parseUid(tenant.uid).block;
    db.getPushSubscriptionsForAdmins(req.db, req.user.organizationId, blockCode)
      .then((subs) => sendPush(subs, {
        title: 'New payment submitted',
        body: `${tenant.name} submitted ₹${amount} for ${payment.period} — needs confirmation`,
        url: '/admin.html',
      }))
      .catch(() => {});

    res.status(201).json({ proof });
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: 'Server error, please try again' });
  }
});

// ---------- admin: reviewing submitted proofs ----------

router.get('/proofs/pending', requireAuth, withOrgScope, requireAdmin, async (req, res) => {
  try {
    let blockFilter = null;
    if (req.user.role === 'sub') {
      const admin = await db.findAdminById(req.db, req.user.organizationId, req.user.id);
      const scope = (admin && admin.payment_confirm_blocks) || [];
      blockFilter = scope.includes('*') ? null : scope; // '*' → see everything, else the granted array (possibly empty)
    }
    const proofs = await db.listPendingProofsForAdmin(req.db, req.user.organizationId, blockFilter);
    res.json({ proofs });
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: 'Server error, please try again' });
  }
});

// A sub-admin can only confirm payments here if the Super Admin has
// explicitly granted them access (see routes/admin.js PUT
// /admins/:id/payment-scope) — by default sub-admins have none, even for
// their own block. Super Admin always passes.
async function assertProofInAdminScope(req, proof) {
  if (!proof) return false;
  if (req.user.role === 'super') return true;
  const tenant = await db.getTenantById(req.db, req.user.organizationId, proof.tenantId);
  const parsed = db.parseUid(tenant.uid);
  const admin = await db.findAdminById(req.db, req.user.organizationId, req.user.id);
  return db.canConfirmPaymentsForBlock(admin, parsed.block);
}

// Approving confirms the payment — the admin can adjust the amount first
// (e.g. the screenshot shows a different amount than what was typed). This
// is what actually updates the tenant's due AND the dues/collection totals.
router.post('/proofs/:id/approve', requireAuth, withOrgScope, requireAdmin, async (req, res) => {
  try {
    const proof = await db.getProofById(req.db, req.user.organizationId, req.params.id);
    if (!proof) return res.status(404).json({ error: 'Submission not found' });
    if (proof.status !== 'pending') return res.status(409).json({ error: 'This submission has already been reviewed' });
    if (!(await assertProofInAdminScope(req, proof))) {
      return res.status(403).json({ error: 'You do not have permission to confirm payments — ask your Super Admin to grant access' });
    }

    const finalAmount = req.body.amount !== undefined ? Number(req.body.amount) : proof.claimedAmount;
    if (isNaN(finalAmount) || finalAmount <= 0) return res.status(400).json({ error: 'Enter a valid amount' });

    const result = await db.approveProof(req.db, req.user.organizationId, proof.id, finalAmount, req.user.name);
    await db.logAction(req.db, req.user.organizationId, req.user.name, 'PAYMENT_PROOF_APPROVED',
      `Confirmed ${proof.tenantName}'s ${proof.period} payment — ₹${finalAmount}${finalAmount !== proof.claimedAmount ? ` (adjusted from ₹${proof.claimedAmount} claimed)` : ''}`);

    db.getPushSubscriptionsForUser(req.db, req.user.organizationId, 'tenant', proof.tenantId)
      .then((subs) => sendPush(subs, {
        title: 'Payment confirmed ✅',
        body: `Your ₹${finalAmount} payment for ${proof.period} has been confirmed.`,
        url: '/tenant.html',
      }))
      .catch(() => {});

    res.json(result);
  } catch (e) {
    if (e.status) return res.status(e.status).json({ error: e.message });
    console.error(e);
    res.status(500).json({ error: 'Server error, please try again' });
  }
});

router.post('/proofs/:id/reject', requireAuth, withOrgScope, requireAdmin, async (req, res) => {
  try {
    const proof = await db.getProofById(req.db, req.user.organizationId, req.params.id);
    if (!proof) return res.status(404).json({ error: 'Submission not found' });
    if (proof.status !== 'pending') return res.status(409).json({ error: 'This submission has already been reviewed' });
    if (!(await assertProofInAdminScope(req, proof))) {
      return res.status(403).json({ error: 'You do not have permission to confirm payments — ask your Super Admin to grant access' });
    }

    const updated = await db.rejectProof(req.db, req.user.organizationId, proof.id, req.user.name, req.body.note || '');
    await db.logAction(req.db, req.user.organizationId, req.user.name, 'PAYMENT_PROOF_REJECTED',
      `Rejected ${proof.tenantName}'s ${proof.period} payment submission${req.body.note ? ' — ' + req.body.note : ''}`);
    res.json({ proof: updated });
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: 'Server error, please try again' });
  }
});

// GET full payment history for one tenant — used by the admin's bed-detail view.
router.get('/tenant/:tenantId', requireAuth, withOrgScope, requireAdmin, async (req, res) => {
  try {
    const tenant = await db.getTenantById(req.db, req.user.organizationId, req.params.tenantId);
    if (!tenant) return res.status(404).json({ error: 'Tenant not found' });
    const parsed = db.parseUid(tenant.uid);
    if (req.user.role !== 'super' && String(req.user.blockCode) !== String(parsed.block)) {
      return res.status(403).json({ error: 'You can only view payments in your own block' });
    }
    const history = await db.listPaymentsForTenantAdmin(req.db, req.user.organizationId, tenant.id);
    res.json({ history });
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: 'Server error, please try again' });
  }
});

// ---------- admin dues overview ----------

// Everything the Payments tab needs, in ONE request. Before this, opening
// that tab as a Super Admin fired SIX separate calls (/config, /scanners,
// /dues, /monthly-summary, /admin/summary for occupancy, /proofs/pending) —
// six separate round trips and six separate database connection checkouts
// for one screen. This is the single biggest fix for the "every page takes
// several seconds" problem, since network round-trip time (not query
// speed) is almost always the real bottleneck, and this cuts it from 6
// round trips to 1.
router.get('/dashboard', requireAuth, withOrgScope, requireAdmin, async (req, res) => {
  try {
    let blockCode = req.query.block ? parseInt(req.query.block, 10) : null;
    if (req.user.role === 'sub') blockCode = req.user.blockCode;
    if (blockCode && !(await db.blockExists(req.db, req.user.organizationId, blockCode))) {
      return res.status(400).json({ error: 'Invalid block' });
    }

    const [dues, monthly, occupancy] = await Promise.all([
      db.getDuesOverview(req.db, req.user.organizationId, blockCode),
      db.getMonthlyRentSummary(req.db, req.user.organizationId, blockCode, 6),
      db.getOccupancySummary(req.db, req.user.organizationId, blockCode),
    ]);

    let pendingFilter = null;
    if (req.user.role === 'sub') {
      const admin = await db.findAdminById(req.db, req.user.organizationId, req.user.id);
      const scope = (admin && admin.payment_confirm_blocks) || [];
      pendingFilter = scope.includes('*') ? null : scope;
    }
    const proofs = await db.listPendingProofsForAdmin(req.db, req.user.organizationId, pendingFilter);

    const result = { dues, monthly: { months: monthly }, occupancy, proofs };
    // Scanners are included here (Super Admin only) since the Payments tab
    // displays them; payment CONFIG is deliberately NOT included — the
    // settings form always wants a guaranteed-fresh, uncached read when
    // it's actually opened for editing (see loadPaymentConfig's own call),
    // not a value that might be milliseconds stale from this batched read.
    if (req.user.role === 'super') {
      result.scanners = await db.listScanners(req.db, req.user.organizationId);
    }
    res.json(result);
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: 'Server error, please try again' });
  }
});

router.get('/dues', requireAuth, withOrgScope, requireAdmin, async (req, res) => {
  try {
    let blockCode = req.query.block ? parseInt(req.query.block, 10) : null;
    if (req.user.role === 'sub') blockCode = req.user.blockCode;
    if (blockCode && !(await db.blockExists(req.db, req.user.organizationId, blockCode))) return res.status(400).json({ error: 'Invalid block' });

    const overview = await db.getDuesOverview(req.db, req.user.organizationId, blockCode);
    res.json(overview);
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: 'Server error, please try again' });
  }
});

router.get('/monthly-summary', requireAuth, withOrgScope, requireAdmin, async (req, res) => {
  try {
    let blockCode = req.query.block ? parseInt(req.query.block, 10) : null;
    if (req.user.role === 'sub') blockCode = req.user.blockCode;
    if (blockCode && !(await db.blockExists(req.db, req.user.organizationId, blockCode))) return res.status(400).json({ error: 'Invalid block' });

    const months = Math.min(Math.max(parseInt(req.query.months, 10) || 6, 1), 24);
    const data = await db.getMonthlyRentSummary(req.db, req.user.organizationId, blockCode, months);
    res.json({ months: data });
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: 'Server error, please try again' });
  }
});

router.post('/:id/mark-paid', requireAuth, withOrgScope, requireAdmin, async (req, res) => {
  try {
    const payment = await db.getPaymentById(req.db, req.user.organizationId, req.params.id);
    if (!payment) return res.status(404).json({ error: 'Payment not found' });

    const tenant = await db.getTenantById(req.db, req.user.organizationId, payment.tenantId);
    const parsed = db.parseUid(tenant.uid);
    if (req.user.role !== 'super' && String(req.user.blockCode) !== String(parsed.block)) {
      return res.status(403).json({ error: 'You can only manage payments in your own block' });
    }
    if (payment.status === 'paid') return res.status(409).json({ error: 'Already marked as paid' });

    const updated = await db.markPaymentPaid(req.db, req.user.organizationId, payment.id, 'admin_marked');
    await db.logAction(req.db, req.user.organizationId, req.user.name, 'ADMIN_MARKED_PAYMENT_PAID',
      `Marked ${tenant.name}'s ${payment.period} payment of ₹${payment.amount} as paid`);
    res.json({ payment: updated });
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: 'Server error, please try again' });
  }
});

const MANUAL_PAYMENT_METHODS = {
  cash: 'cash',
  upi: 'UPI (received directly)',
  bank_transfer: 'bank transfer (received directly)',
  other: 'other (received directly)',
};
router.post('/:id/cash', requireAuth, withOrgScope, requireAdmin, async (req, res) => {
  try {
    const payment = await db.getPaymentById(req.db, req.user.organizationId, req.params.id);
    if (!payment) return res.status(404).json({ error: 'Payment not found' });

    const tenant = await db.getTenantById(req.db, req.user.organizationId, payment.tenantId);
    const parsed = db.parseUid(tenant.uid);
    if (req.user.role !== 'super' && String(req.user.blockCode) !== String(parsed.block)) {
      return res.status(403).json({ error: 'You can only manage payments in your own block' });
    }

    const amountReceived = Number(req.body.amount);
    if (isNaN(amountReceived) || amountReceived <= 0) {
      return res.status(400).json({ error: 'Enter a valid amount received' });
    }
    const methodKey = MANUAL_PAYMENT_METHODS[req.body.method] ? req.body.method : 'cash';

    const updated = await db.recordCashPayment(req.db, req.user.organizationId, payment.id, amountReceived, methodKey);
    await db.logAction(req.db, req.user.organizationId, req.user.name, 'MANUAL_PAYMENT_RECORDED',
      `Recorded ₹${amountReceived} (${MANUAL_PAYMENT_METHODS[methodKey]}) from ${tenant.name} for ${payment.period}` +
        (updated.status === 'paid' ? ' (fully paid)' : ` (₹${updated.remaining} still remaining)`));
    res.json({ payment: updated });
  } catch (e) {
    if (e.status) return res.status(e.status).json({ error: e.message });
    console.error(e);
    res.status(500).json({ error: 'Server error, please try again' });
  }
});

module.exports = router;
