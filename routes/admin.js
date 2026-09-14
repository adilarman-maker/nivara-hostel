const express = require('express');
const bcrypt = require('bcryptjs');
const db = require('../db/database');
const { withOrgScope } = require('../middleware/orgScope');
const { requireAuth, requireAdmin } = require('../middleware/auth');

const router = express.Router();

function requireSuper(req, res, next) {
  if (req.user.role !== 'super') return res.status(403).json({ error: 'Super Admin only' });
  next();
}

// Dashboard summary stats, scoped to the admin's permission
router.get('/summary', requireAuth, withOrgScope, requireAdmin, async (req, res) => {
  try {
    const counts = await db.tenantCountsByBlock(req.db, req.user.organizationId);
    const blocks = await db.listBlocks(req.db, req.user.organizationId);
    const perBlock = {};
    blocks.forEach((b) => {
      perBlock[b.code] = { ...b, count: counts[b.code] || 0 };
    });

    const totalTenants = req.user.role === 'super'
      ? Object.values(counts).reduce((a, b) => a + b, 0)
      : (counts[req.user.blockCode] || 0);

    const recentActivity = await db.recentAuditLog(req.db, req.user.organizationId, 10);

    // Sub-admins are always scoped to their own block. Super Admin can
    // optionally filter to one block via ?block=, or see everything if omitted.
    let occupancyScope = null;
    if (req.user.role === 'sub') occupancyScope = req.user.blockCode;
    else if (req.query.block) occupancyScope = parseInt(req.query.block, 10);
    const occupancy = await db.getOccupancySummary(req.db, req.user.organizationId, occupancyScope);

    res.json({ totalTenants, perBlock, recentActivity, occupancy, role: req.user.role, scopeBlock: req.user.blockCode });
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: 'Server error, please try again' });
  }
});

// Everything the Overview tab needs, in ONE request instead of the three
// separate ones (/summary, /blocks, /payments/monthly-summary — plus a
// fourth, /admin/admins, for Super Admins) it used to take. Each of those
// was a fully separate HTTP round trip AND a separate database connection
// checkout; on a database that isn't in the same region as your users
// (or on a cold serverless instance), that overhead is the single biggest
// reason a page can feel like it's taking several seconds even though no
// individual query is slow. This runs all of it on the one connection
// already checked out for this request.
router.get('/dashboard', requireAuth, withOrgScope, requireAdmin, async (req, res) => {
  try {
    const counts = await db.tenantCountsByBlock(req.db, req.user.organizationId);
    const blocks = await db.listBlocks(req.db, req.user.organizationId);
    const perBlock = {};
    blocks.forEach((b) => { perBlock[b.code] = { ...b, count: counts[b.code] || 0 }; });

    const totalTenants = req.user.role === 'super'
      ? Object.values(counts).reduce((a, b) => a + b, 0)
      : (counts[req.user.blockCode] || 0);

    let occupancyScope = null;
    if (req.user.role === 'sub') occupancyScope = req.user.blockCode;
    else if (req.query.block) occupancyScope = parseInt(req.query.block, 10);

    const [recentActivity, occupancy, monthly] = await Promise.all([
      db.recentAuditLog(req.db, req.user.organizationId, 10),
      db.getOccupancySummary(req.db, req.user.organizationId, occupancyScope),
      db.getMonthlyRentSummary(req.db, req.user.organizationId, occupancyScope, 6),
    ]);

    let subAdminCount = null;
    if (req.user.role === 'super') {
      const admins = await db.listAdmins(req.db, req.user.organizationId);
      subAdminCount = admins.filter((a) => a.role === 'sub').length;
    }

    res.json({ totalTenants, perBlock, blocks, recentActivity, occupancy, monthly: { months: monthly }, subAdminCount, role: req.user.role, scopeBlock: req.user.blockCode });
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: 'Server error, please try again' });
  }
});

// SUPER ADMIN ONLY — list all admins with their individual UID/phone
router.get('/admins', requireAuth, withOrgScope, requireAdmin, requireSuper, async (req, res) => {
  try {
    const admins = await db.listAdmins(req.db, req.user.organizationId);
    res.json({ admins });
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: 'Server error, please try again' });
  }
});

// SUPER ADMIN ONLY — create a new sub-admin for a block (also usable to add
// a spare/backup admin later, outside the block-creation flow).
router.post('/admins', requireAuth, withOrgScope, requireAdmin, requireSuper, async (req, res) => {
  try {
    const { uid, phone, password, name, blockCode } = req.body;
    if (!uid || !phone || !password || !name || !blockCode) {
      return res.status(400).json({ error: 'UID, phone, password, name, and block are all required' });
    }
    if (!db.isValidAdminUid(uid)) {
      return res.status(400).json({ error: 'Admin UID must be 5 digits starting with 0 (digits 1-9 are reserved for blocks)' });
    }
    if (!/^\d{10}$/.test(phone)) return res.status(400).json({ error: 'Phone must be a 10-digit number' });
    if (password.length < 6) return res.status(400).json({ error: 'Password must be at least 6 characters' });
    if (!(await db.blockExists(req.db, req.user.organizationId, blockCode))) return res.status(400).json({ error: 'That block does not exist' });
    if (await db.uidTakenAnywhere(req.db, req.user.organizationId, uid)) return res.status(409).json({ error: `UID ${uid} is already in use` });
    if (await db.phoneTakenAnywhere(req.db, req.user.organizationId, phone)) return res.status(409).json({ error: `Phone ${phone} is already in use` });

    const admin = {
      id: 'a-' + Date.now().toString(36) + Math.random().toString(36).slice(2, 6),
      uid, phone, username: uid, // username isn't used for login anymore, kept only because the column is NOT NULL
      passwordHash: bcrypt.hashSync(password, 10),
      role: 'sub', blockCode: String(blockCode), name,
    };
    await db.insertAdmin(req.db, req.user.organizationId, admin);
    await db.logAction(req.db, req.user.organizationId, req.user.name, 'CREATE_SUB_ADMIN', `Created sub-admin ${name} for block ${blockCode}`);
    res.status(201).json({ admin: { id: admin.id, uid, phone, name, role: 'sub', blockCode: String(blockCode) } });
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: 'Server error, please try again' });
  }
});

// SUPER ADMIN ONLY — remove a sub-admin (e.g. when deleting their block, or just replacing them)
router.delete('/admins/:id', requireAuth, withOrgScope, requireAdmin, requireSuper, async (req, res) => {
  try {
    const admin = await db.findAdminById(req.db, req.user.organizationId, req.params.id);
    if (!admin) return res.status(404).json({ error: 'Admin not found' });
    if (admin.role === 'super') return res.status(400).json({ error: "Can't delete the Super Admin account" });
    await db.deleteAdmin(req.db, req.user.organizationId, admin.id);
    await db.logAction(req.db, req.user.organizationId, req.user.name, 'DELETE_ADMIN', `Removed admin ${admin.name}`);
    res.json({ ok: true });
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: 'Server error, please try again' });
  }
});

// SUPER ADMIN ONLY — change any admin's UID and/or phone
router.put('/admins/:id/credentials', requireAuth, withOrgScope, requireAdmin, requireSuper, async (req, res) => {
  try {
    const { uid, phone } = req.body;
    const admin = await db.findAdminById(req.db, req.user.organizationId, req.params.id);
    if (!admin) return res.status(404).json({ error: 'Admin not found' });

    if (uid !== undefined) {
      if (!db.isValidAdminUid(uid)) {
        return res.status(400).json({ error: 'Admin UID must be 5 digits starting with 0 (digits 1-9 are reserved for blocks)' });
      }
      if (await db.uidTakenAnywhere(req.db, req.user.organizationId, uid, { adminId: admin.id })) {
        return res.status(409).json({ error: `UID ${uid} is already in use` });
      }
    }
    if (phone !== undefined) {
      if (!/^\d{10}$/.test(phone)) {
        return res.status(400).json({ error: 'Phone must be a 10-digit number' });
      }
      if (await db.phoneTakenAnywhere(req.db, req.user.organizationId, phone, { adminId: admin.id })) {
        return res.status(409).json({ error: `Phone number ${phone} is already registered to someone else` });
      }
    }

    const updated = await db.updateAdminUidPhone(req.db, req.user.organizationId, admin.id, { uid, phone });
    await db.logAction(req.db, req.user.organizationId, req.user.name, 'UPDATE_ADMIN_CREDENTIALS', `Updated login UID/phone for ${admin.name}`);
    res.json({ admin: updated });
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: 'Server error, please try again' });
  }
});

// SUPER ADMIN ONLY — grant/revoke a sub-admin's payment-confirmation access.
// Body: { scope: 'none' | 'all' | ['1','3'] } — 'all' lets them confirm
// payments for every block, an array limits them to those specific blocks
// (not necessarily just their own assigned one), 'none' revokes it entirely.
router.put('/admins/:id/payment-scope', requireAuth, withOrgScope, requireAdmin, requireSuper, async (req, res) => {
  try {
    const admin = await db.findAdminById(req.db, req.user.organizationId, req.params.id);
    if (!admin) return res.status(404).json({ error: 'Admin not found' });
    if (admin.role !== 'sub') return res.status(400).json({ error: 'Only sub-admins can be granted this — the Super Admin already has full access' });

    let scope = req.body.scope;
    if (scope === 'all') scope = ['*'];
    else if (scope === 'none' || scope === null || scope === undefined) scope = null;
    else if (Array.isArray(scope)) {
      for (const code of scope) {
        if (!(await db.blockExists(req.db, req.user.organizationId, code))) {
          return res.status(400).json({ error: `Block "${code}" does not exist` });
        }
      }
    } else {
      return res.status(400).json({ error: "scope must be 'all', 'none', or an array of block codes" });
    }

    const updated = await db.setAdminPaymentConfirmScope(req.db, req.user.organizationId, admin.id, scope);
    const label = !scope ? 'no access' : scope.includes('*') ? 'all blocks' : `block(s) ${scope.join(', ')}`;
    await db.logAction(req.db, req.user.organizationId, req.user.name, 'UPDATE_PAYMENT_CONFIRM_SCOPE',
      `Set ${admin.name}'s payment confirmation access to ${label}`);
    res.json({ admin: updated });
  } catch (e) {
    if (e.status) return res.status(e.status).json({ error: e.message });
    console.error(e);
    res.status(500).json({ error: 'Server error, please try again' });
  }
});

router.put('/admins/:id/password', requireAuth, withOrgScope, requireAdmin, requireSuper, async (req, res) => {
  try {
    const { password } = req.body;
    if (!password || password.length < 6) {
      return res.status(400).json({ error: 'Password must be at least 6 characters' });
    }
    const admin = await db.findAdminById(req.db, req.user.organizationId, req.params.id);
    if (!admin) return res.status(404).json({ error: 'Admin not found' });
    const hash = bcrypt.hashSync(password, 10);
    await db.updateAdminPasswordHash(req.db, req.user.organizationId, admin.id, hash);
    await db.logAction(req.db, req.user.organizationId, req.user.name, 'RESET_ADMIN_PASSWORD', `Reset password for ${admin.name}`);
    res.json({ ok: true });
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: 'Server error, please try again' });
  }
});

module.exports = router;
