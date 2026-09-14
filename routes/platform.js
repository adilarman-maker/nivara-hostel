const express = require('express');
const bcrypt = require('bcryptjs');
const db = require('../db/database');
const { sign, requireAuth, requirePlatformAdmin } = require('../middleware/auth');
const { loginRateLimit } = require('../middleware/rateLimit');

const router = express.Router();

// No Hostel ID here — a Platform Admin isn't logging into any one hostel,
// they're above all of them. Username + password only.
// Stricter limit than the hostel logins — this one guards every hostel on
// the platform at once, so it's worth being more conservative here.
router.post('/login', loginRateLimit(8, 10 * 60_000), async (req, res) => {
  try {
    const { username, password } = req.body;
    if (!username || !password) return res.status(400).json({ error: 'Username and password are required' });

    const admin = await db.findPlatformAdminByUsername(username.trim());
    if (!admin || !bcrypt.compareSync(password, admin.password_hash)) {
      return res.status(401).json({ error: 'Incorrect username or password' });
    }

    const token = sign({ type: 'platform', id: admin.id, name: admin.name });
    res.json({ token, admin: { id: admin.id, name: admin.name } });
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: 'Server error, please try again' });
  }
});

router.get('/me', requireAuth, requirePlatformAdmin, (req, res) => {
  res.json({ admin: { id: req.user.id, name: req.user.name } });
});

router.get('/organizations', requireAuth, requirePlatformAdmin, async (req, res) => {
  try {
    const organizations = await db.listOrganizationsWithStats();
    res.json({ organizations });
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: 'Server error, please try again' });
  }
});

function validSlug(slug) {
  return /^[a-z0-9][a-z0-9-]{1,30}[a-z0-9]$/.test(slug || '');
}

// Creates the hostel AND its first Super Admin together — see
// db/database.js createOrganizationWithSuperAdmin for why these are one
// transaction, not two separate steps.
router.post('/organizations', requireAuth, requirePlatformAdmin, async (req, res) => {
  try {
    const { name, slug, superAdminName, superAdminUid, superAdminPhone, superAdminPassword } = req.body;

    if (!name || !name.trim()) return res.status(400).json({ error: 'Hostel name is required' });

    const cleanSlug = String(slug || '').trim().toLowerCase();
    if (!validSlug(cleanSlug)) {
      return res.status(400).json({ error: 'Hostel ID must be 3-32 characters: lowercase letters, numbers, and hyphens only (not at the start/end)' });
    }
    if (await db.slugTaken(cleanSlug)) {
      return res.status(409).json({ error: `Hostel ID "${cleanSlug}" is already taken` });
    }

    if (!db.isValidAdminUid(superAdminUid)) {
      return res.status(400).json({ error: 'Super Admin UID must be 5 digits starting with 0 (e.g. 00001)' });
    }
    if (!/^\d{10}$/.test(superAdminPhone || '')) {
      return res.status(400).json({ error: 'Super Admin phone must be a 10-digit number' });
    }
    if (!superAdminPassword || superAdminPassword.length < 6) {
      return res.status(400).json({ error: 'Super Admin password must be at least 6 characters' });
    }
    if (!superAdminName || !superAdminName.trim()) {
      return res.status(400).json({ error: "Super Admin's name is required" });
    }

    const orgId = 'o-' + Date.now().toString(36) + Math.random().toString(36).slice(2, 8);
    const adminId = 'a-' + Date.now().toString(36) + Math.random().toString(36).slice(2, 8);

    const org = await db.createOrganizationWithSuperAdmin({
      orgId, slug: cleanSlug, orgName: name.trim(),
      admin: {
        id: adminId, uid: superAdminUid, phone: superAdminPhone,
        password: superAdminPassword, name: superAdminName.trim(),
      },
    });

    res.status(201).json({ organization: org });
  } catch (e) {
    if (e.code === '23505') { // unique_violation — e.g. that UID or phone already exists somewhere unexpected
      return res.status(409).json({ error: 'That UID or phone is already in use' });
    }
    console.error(e);
    res.status(500).json({ error: 'Server error, please try again' });
  }
});

// Deactivate/reactivate — the default "remove a hostel" action. Data is
// never touched; their Super Admin just can't log in while inactive.
router.patch('/organizations/:id/active', requireAuth, requirePlatformAdmin, async (req, res) => {
  try {
    const { active } = req.body;
    const updated = await db.setOrganizationActive(req.params.id, !!active);
    if (!updated) return res.status(404).json({ error: 'Hostel not found' });
    res.json({ organization: updated });
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: 'Server error, please try again' });
  }
});

// For a locked-out Super Admin — sets new login credentials without ever
// needing to know their old password.
router.post('/organizations/:id/reset-super-admin', requireAuth, requirePlatformAdmin, async (req, res) => {
  try {
    const { uid, phone, password } = req.body;
    if (!db.isValidAdminUid(uid)) return res.status(400).json({ error: 'UID must be 5 digits starting with 0' });
    if (!/^\d{10}$/.test(phone || '')) return res.status(400).json({ error: 'Phone must be a 10-digit number' });
    if (!password || password.length < 6) return res.status(400).json({ error: 'Password must be at least 6 characters' });

    const updated = await db.resetOrgSuperAdmin(req.params.id, { uid, phone, password });
    if (!updated) return res.status(404).json({ error: 'No Super Admin found for this hostel' });
    res.json({ admin: updated });
  } catch (e) {
    if (e.code === '23505') return res.status(409).json({ error: 'That UID or phone is already in use' });
    console.error(e);
    res.status(500).json({ error: 'Server error, please try again' });
  }
});

// Permanent delete — deliberately separate from deactivate above, and
// gated on typing the hostel's exact name, same pattern as GitHub repo
// deletion. Wipes every tenant, room, payment, and message for this org.
router.delete('/organizations/:id', requireAuth, requirePlatformAdmin, async (req, res) => {
  try {
    const org = await db.getOrganizationById(req.params.id);
    if (!org) return res.status(404).json({ error: 'Hostel not found' });

    const { confirmName } = req.body;
    if (confirmName !== org.name) {
      return res.status(400).json({ error: `Type the hostel's exact name ("${org.name}") to confirm permanent deletion` });
    }

    await db.deleteOrganizationHard(req.params.id);
    res.json({ deleted: true });
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: 'Server error, please try again' });
  }
});

module.exports = router;
