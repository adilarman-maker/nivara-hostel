const express = require('express');
const bcrypt = require('bcryptjs');
const db = require('../db/database');
const { sign, requireAuth } = require('../middleware/auth');
const { withOrgScope } = require('../middleware/orgScope');
const { loginRateLimit } = require('../middleware/rateLimit');

const router = express.Router();

// STEP 1 — Hostel ID + UID + phone.
// organizations.slug (the "Hostel ID") resolves which organization before
// UID/phone are even checked — UID and phone are only unique WITHIN an
// organization, not across the platform, so the Hostel ID has to come
// first. This lookup (and the org lookup itself) is the only place in the
// app that queries the database without an org already known — that's
// intentional, not a gap.
router.post('/check', loginRateLimit(20, 5 * 60_000), async (req, res) => {
  try {
    const { hostelId, uid, phone } = req.body;
    if (!hostelId || !uid || !phone) return res.status(400).json({ error: 'Hostel ID, UID, and phone are required' });

    const org = await db.findOrgBySlug(hostelId);
    if (!org) return res.status(401).json({ error: 'Hostel ID not recognised' });

    const admin = await db.findAdminByUidPhone(org.id, uid, phone);
    if (admin) {
      return res.json({ mode: 'admin_verify', name: admin.name });
    }

    const tenant = await db.findTenantByUidPhone(org.id, uid, phone);
    if (tenant) {
      const token = sign({ type: 'tenant', id: tenant.id, uid: tenant.uid, organizationId: tenant.organizationId });
      return res.json({ mode: 'tenant', token, tenant });
    }

    return res.status(401).json({ error: 'UID and phone number do not match our records' });
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: 'Server error, please try again' });
  }
});

// STEP 2 (admins only) — the same Hostel ID + UID + phone plus their password.
router.post('/admin-login', loginRateLimit(10, 5 * 60_000), async (req, res) => {
  try {
    const { hostelId, uid, phone, password } = req.body;
    const org = await db.findOrgBySlug(hostelId);
    if (!org) return res.status(401).json({ error: 'Hostel ID not recognised' });

    const admin = await db.findAdminByUidPhone(org.id, uid, phone);
    if (!admin || !bcrypt.compareSync(password || '', admin.password_hash)) {
      return res.status(401).json({ error: 'Incorrect password' });
    }

    const token = sign({
      type: 'admin',
      id: admin.id,
      role: admin.role,
      blockCode: admin.block_code,
      name: admin.name,
      organizationId: admin.organization_id,
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

// The hostel's own name (set by the Platform Admin when the org was
// created) — shown under the "Getnesty" brand in the admin/tenant sidebars
// so people using several hostels on the same platform can tell which one
// they're in. A dedicated endpoint rather than baking it into the JWT
// because the name can change after login without forcing a re-login.
router.get('/organization', requireAuth, withOrgScope, async (req, res) => {
  try {
    const org = await db.getOwnOrganization(req.db, req.user.organizationId);
    if (!org) return res.status(404).json({ error: 'Organization not found' });
    res.json({ name: org.name, slug: org.slug });
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: 'Server error, please try again' });
  }
});

module.exports = router;
