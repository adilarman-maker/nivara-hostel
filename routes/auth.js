const express = require('express');
const bcrypt = require('bcryptjs');
const db = require('../db/database');
const { sign, requireAuth } = require('../middleware/auth');

const router = express.Router();

// STEP 1 — Everyone enters their own UID + phone.
// Since every tenant AND every admin now has a unique UID+phone, this alone
// tells us exactly who's trying to log in.
router.post('/check', async (req, res) => {
  try {
    const { uid, phone } = req.body;
    if (!uid || !phone) return res.status(400).json({ error: 'UID and phone are required' });

    const admin = await db.findAdminByUidPhone(uid, phone);
    if (admin) {
      return res.json({ mode: 'admin_verify', name: admin.name });
    }

    const tenant = await db.findTenantByUidPhone(uid, phone);
    if (tenant) {
      const token = sign({ type: 'tenant', id: tenant.id, uid: tenant.uid });
      return res.json({ mode: 'tenant', token, tenant });
    }

    return res.status(401).json({ error: 'UID and phone number do not match our records' });
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: 'Server error, please try again' });
  }
});

// STEP 2 (admins only) — the same UID+phone plus their password.
router.post('/admin-login', async (req, res) => {
  try {
    const { uid, phone, password } = req.body;
    const admin = await db.findAdminByUidPhone(uid, phone);
    if (!admin || !bcrypt.compareSync(password || '', admin.password_hash)) {
      return res.status(401).json({ error: 'Incorrect password' });
    }

    const token = sign({
      type: 'admin',
      id: admin.id,
      role: admin.role,
      blockCode: admin.block_code,
      name: admin.name,
    });
    res.json({
      token,
      admin: { id: admin.id, name: admin.name, role: admin.role, blockCode: admin.block_code },
    });
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: 'Server error, please try again' });
  }
});

router.get('/me', requireAuth, (req, res) => {
  res.json({ user: req.user });
});

module.exports = router;
