const express = require('express');
const bcrypt = require('bcryptjs');
const db = require('../db/database');
const { requireAuth, requireAdmin } = require('../middleware/auth');

const router = express.Router();

function requireSuper(req, res, next) {
  if (req.user.role !== 'super') return res.status(403).json({ error: 'Super Admin only' });
  next();
}

// Dashboard summary stats, scoped to the admin's permission
router.get('/summary', requireAuth, requireAdmin, async (req, res) => {
  try {
    const counts = await db.tenantCountsByBlock();
    const perBlock = {};
    Object.entries(db.BLOCKS).forEach(([code, b]) => {
      perBlock[code] = { ...b, count: counts[code] || 0 };
    });

    const totalTenants = req.user.role === 'super'
      ? Object.values(counts).reduce((a, b) => a + b, 0)
      : (counts[req.user.blockCode] || 0);

    const recentActivity = await db.recentAuditLog(10);

    res.json({ totalTenants, perBlock, recentActivity, role: req.user.role, scopeBlock: req.user.blockCode });
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: 'Server error, please try again' });
  }
});

// SUPER ADMIN ONLY — list all 5 admins with their individual UID/phone
router.get('/admins', requireAuth, requireAdmin, requireSuper, async (req, res) => {
  try {
    const admins = await db.listAdmins();
    res.json({ admins });
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: 'Server error, please try again' });
  }
});

// SUPER ADMIN ONLY — change any admin's UID and/or phone
router.put('/admins/:id/credentials', requireAuth, requireAdmin, requireSuper, async (req, res) => {
  try {
    const { uid, phone } = req.body;
    const admin = await db.findAdminById(req.params.id);
    if (!admin) return res.status(404).json({ error: 'Admin not found' });

    if (uid !== undefined) {
      if (!db.isValidAdminUid(uid)) {
        return res.status(400).json({ error: 'Admin UID must be 5 digits and cannot start with 1-4 (reserved for tenant blocks)' });
      }
      if (await db.uidTakenAnywhere(uid, { adminId: admin.id })) {
        return res.status(409).json({ error: `UID ${uid} is already in use` });
      }
    }
    if (phone !== undefined) {
      if (!/^\d{10}$/.test(phone)) {
        return res.status(400).json({ error: 'Phone must be a 10-digit number' });
      }
      if (await db.phoneTakenAnywhere(phone, { adminId: admin.id })) {
        return res.status(409).json({ error: `Phone number ${phone} is already registered to someone else` });
      }
    }

    const updated = await db.updateAdminUidPhone(admin.id, { uid, phone });
    await db.logAction(req.user.name, 'UPDATE_ADMIN_CREDENTIALS', `Updated login UID/phone for ${admin.name}`);
    res.json({ admin: updated });
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: 'Server error, please try again' });
  }
});

router.put('/admins/:id/password', requireAuth, requireAdmin, requireSuper, async (req, res) => {
  try {
    const { password } = req.body;
    if (!password || password.length < 6) {
      return res.status(400).json({ error: 'Password must be at least 6 characters' });
    }
    const admin = await db.findAdminById(req.params.id);
    if (!admin) return res.status(404).json({ error: 'Admin not found' });
    const hash = bcrypt.hashSync(password, 10);
    await db.updateAdminPasswordHash(admin.id, hash);
    await db.logAction(req.user.name, 'RESET_ADMIN_PASSWORD', `Reset password for ${admin.name}`);
    res.json({ ok: true });
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: 'Server error, please try again' });
  }
});

module.exports = router;
