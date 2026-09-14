const express = require('express');
const db = require('../db/database');
const { withOrgScope } = require('../middleware/orgScope');
const { requireAuth, requireAdmin, requireSuperAdmin } = require('../middleware/auth');

const router = express.Router();

// blockCode from a JWT/DB row may be a string ('1') or number (1) depending
// on where it came from — always compare as strings to avoid a subtle bug.
function canManageBlock(user, blockCode) {
  return user.role === 'super' || String(user.blockCode) === String(blockCode);
}

function requireTenant(req, res, next) {
  if (!req.user || req.user.type !== 'tenant') return res.status(403).json({ error: 'Tenant access required' });
  next();
}

function validProfileFields(body) {
  const fields = {};
  if (body.college !== undefined) fields.college = String(body.college).trim();
  if (body.hometown !== undefined) fields.hometown = String(body.hometown).trim();
  if (body.parentPhone !== undefined) {
    const pp = String(body.parentPhone).trim();
    if (pp && !/^\d{10}$/.test(pp)) throw Object.assign(new Error("Parent's phone must be a 10-digit number"), { status: 400 });
    fields.parentPhone = pp;
  }
  if (body.age !== undefined) {
    const age = body.age === '' || body.age === null ? null : parseInt(body.age, 10);
    if (age !== null && (isNaN(age) || age < 14 || age > 100)) {
      throw Object.assign(new Error('Age must be a reasonable number'), { status: 400 });
    }
    fields.age = age;
  }
  if (body.gender !== undefined) fields.gender = String(body.gender).trim();
  return fields;
}

// TENANT SELF-SERVICE — a tenant can view/edit their own optional profile
// fields only. UID, phone, and name stay admin-controlled.
router.get('/me', requireAuth, withOrgScope, requireTenant, async (req, res) => {
  try {
    const tenant = await db.getTenantById(req.db, req.user.organizationId, req.user.id);
    if (!tenant) return res.status(404).json({ error: 'Tenant record not found' });
    res.json({ tenant });
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: 'Server error, please try again' });
  }
});

router.put('/me', requireAuth, withOrgScope, requireTenant, async (req, res) => {
  try {
    const fields = validProfileFields(req.body);
    const updated = await db.updateTenant(req.db, req.user.organizationId, req.user.id, fields);
    if (!updated) return res.status(404).json({ error: 'Tenant record not found' });
    res.json({ tenant: updated });
  } catch (e) {
    if (e.status) return res.status(e.status).json({ error: e.message });
    console.error(e);
    res.status(500).json({ error: 'Server error, please try again' });
  }
});

// LIST — any admin (super or sub) can READ every tenant across every block.
// Write actions (create/update/delete) stay block-scoped, enforced below.
// Paginated + optionally searched (?search=) + optionally block-filtered (?block=).
// limit is capped server-side regardless of what's requested — a client
// asking for ?limit=1000000 still only gets 100 back.
router.get('/', requireAuth, withOrgScope, requireAdmin, async (req, res) => {
  try {
    const page = Math.max(parseInt(req.query.page, 10) || 1, 1);
    const limit = Math.min(parseInt(req.query.limit, 10) || 50, 100);
    const search = (req.query.search || '').trim();
    const blockCode = req.query.block ? parseInt(req.query.block, 10) : null;
    if (blockCode && !(await db.blockExists(req.db, req.user.organizationId, blockCode))) {
      return res.status(400).json({ error: 'Invalid block' });
    }

    const statusFilter = ['all', 'active', 'booked', 'moved_out'].includes(req.query.status) ? req.query.status : 'active';
    const result = await db.listTenantsPage(req.db, req.user.organizationId, { blockCode, search, page, limit, statusFilter });
    const blocks = await db.listBlocks(req.db, req.user.organizationId);
    res.json({ ...result, blocks });
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: 'Server error, please try again' });
  }
});

// GET single tenant (admin) — read access open to any admin, same as the list above
router.get('/:id', requireAuth, withOrgScope, requireAdmin, async (req, res) => {
  try {
    const tenant = await db.getTenantById(req.db, req.user.organizationId, req.params.id);
    if (!tenant) return res.status(404).json({ error: 'Tenant not found' });
    const payments = await db.listPaymentsForTenant(req.db, req.user.organizationId, tenant.id);
    res.json({ tenant, description: await db.describeUid(req.db, req.user.organizationId, tenant.uid), payments });
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: 'Server error, please try again' });
  }
});

// CREATE
router.post('/', requireAuth, withOrgScope, requireAdmin, async (req, res) => {
  try {
    const { uid, phone, name, email, notes } = req.body;
    if (!uid || !phone || !name) {
      return res.status(400).json({ error: 'UID, phone and name are required' });
    }

    const parsed = db.parseUid(uid);
    if (!parsed) {
      return res.status(400).json({
        error: 'Invalid UID. Must be exactly 5 digits: [Block 1-9][Floor][Room 01-99][Bed 1-9]',
      });
    }
    if (!(await db.blockExists(req.db, req.user.organizationId, parsed.block))) {
      return res.status(400).json({ error: `Block ${parsed.block} doesn't exist` });
    }
    if (!canManageBlock(req.user, parsed.block)) {
      const myBlock = req.user.blockCode ? await db.getBlock(req.db, req.user.organizationId, req.user.blockCode) : null;
      return res.status(403).json({ error: `You can only manage the ${myBlock?.name || 'your'} block` });
    }
    if (!/^\d{10}$/.test(phone)) {
      return res.status(400).json({ error: 'Phone must be a 10-digit number' });
    }

    const advanceAmount = Number(req.body.advanceAmount);
    const monthlyRent = Number(req.body.monthlyRent);
    if (!req.body.advanceAmount || isNaN(advanceAmount) || advanceAmount <= 0) {
      return res.status(400).json({ error: 'Advance amount is required and must be a positive number' });
    }
    if (!req.body.monthlyRent || isNaN(monthlyRent) || monthlyRent <= 0) {
      return res.status(400).json({ error: 'Monthly rent is required and must be a positive number' });
    }

    if (await db.uidTakenAnywhere(req.db, req.user.organizationId, uid)) {
      return res.status(409).json({ error: `UID ${uid} is already in use` });
    }
    if (await db.phoneTakenAnywhere(req.db, req.user.organizationId, phone)) {
      return res.status(409).json({ error: `Phone number ${phone} is already registered to someone else` });
    }

    // Join date defaults to today (moving in now). A future date books the
    // bed without marking it occupied yet — see createTenantWithAdvance and
    // syncTenantLifecycle for how the booked -> active flip happens.
    const today = new Date().toISOString().slice(0, 10);
    const joinDate = req.body.joinDate || today;
    if (!/^\d{4}-\d{2}-\d{2}$/.test(joinDate)) {
      return res.status(400).json({ error: 'Join date must be a valid date' });
    }
    let vacateDate = req.body.vacateDate || null;
    if (vacateDate) {
      if (!/^\d{4}-\d{2}-\d{2}$/.test(vacateDate)) {
        return res.status(400).json({ error: 'Vacate date must be a valid date' });
      }
      if (vacateDate <= joinDate) {
        return res.status(400).json({ error: 'Vacate date must be after the join date' });
      }
    }

    let profileFields = {};
    try { profileFields = validProfileFields(req.body); } catch (e) { return res.status(e.status || 400).json({ error: e.message }); }

    // Tenant row + their first (advance) payment row are created together in
    // one transaction — either both succeed or neither does, so we never end
    // up with a tenant that has no payment record or vice versa.
    const tenant = await db.createTenantWithAdvance(req.db, req.user.organizationId, 
      {
        id: 't-' + Date.now().toString(36) + Math.random().toString(36).slice(2, 6),
        uid, phone, name, email, notes, advanceAmount, monthlyRent, joinDate, vacateDate, ...profileFields,
      },
      db.currentPeriod(),
      advanceAmount
    );
    await db.logAction(req.db, req.user.organizationId, 
      req.user.name || req.user.id,
      'CREATE_TENANT',
      `Added ${name} (UID ${uid})` + (tenant.status === 'booked' ? ` — booked, moves in ${joinDate}` : '')
    );

    res.status(201).json({ tenant, description: await db.describeUid(req.db, req.user.organizationId, uid) });
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: 'Server error, please try again' });
  }
});

// UPDATE
router.put('/:id', requireAuth, withOrgScope, requireAdmin, async (req, res) => {
  try {
    const tenant = await db.getTenantById(req.db, req.user.organizationId, req.params.id);
    if (!tenant) return res.status(404).json({ error: 'Tenant not found' });

    const currentParsed = db.parseUid(tenant.uid);
    if (!canManageBlock(req.user, currentParsed.block)) {
      return res.status(403).json({ error: 'You do not have permission to edit this tenant' });
    }

    const { uid, phone, name, email, notes } = req.body;
    let profileFields = {};
    try { profileFields = validProfileFields(req.body); } catch (e) { return res.status(e.status || 400).json({ error: e.message }); }
    const fields = { name: name || null, email, notes, ...profileFields };

    if (req.body.monthlyRent !== undefined) {
      const monthlyRent = Number(req.body.monthlyRent);
      if (isNaN(monthlyRent) || monthlyRent <= 0) return res.status(400).json({ error: 'Monthly rent must be a positive number' });
      fields.monthlyRent = monthlyRent;
    }
    if (req.body.advanceAmount !== undefined) {
      const advanceAmount = Number(req.body.advanceAmount);
      if (isNaN(advanceAmount) || advanceAmount <= 0) return res.status(400).json({ error: 'Advance amount must be a positive number' });
      fields.advanceAmount = advanceAmount;
    }
    if (req.body.joinDate !== undefined && req.body.joinDate) {
      if (!/^\d{4}-\d{2}-\d{2}$/.test(req.body.joinDate)) return res.status(400).json({ error: 'Join date must be a valid date' });
      fields.joinDate = req.body.joinDate;
    }
    if (req.body.vacateDate !== undefined) {
      // Explicit null/empty string clears the vacate date (tenant is staying indefinitely again).
      if (req.body.vacateDate === null || req.body.vacateDate === '') {
        fields.vacateDate = null;
      } else {
        if (!/^\d{4}-\d{2}-\d{2}$/.test(req.body.vacateDate)) return res.status(400).json({ error: 'Vacate date must be a valid date' });
        fields.vacateDate = req.body.vacateDate;
      }
    }
    if (req.body.joinDate !== undefined) {
      if (!/^\d{4}-\d{2}-\d{2}$/.test(req.body.joinDate)) return res.status(400).json({ error: 'Join date must be a valid date' });
      fields.joinDate = req.body.joinDate;
    }
    if (req.body.vacateDate !== undefined) {
      // Explicit null clears an existing vacate date (tenant is staying after all).
      if (req.body.vacateDate !== null && !/^\d{4}-\d{2}-\d{2}$/.test(req.body.vacateDate)) {
        return res.status(400).json({ error: 'Vacate date must be a valid date' });
      }
      fields.vacateDate = req.body.vacateDate;
    }

    if (uid && uid !== tenant.uid) {
      const parsed = db.parseUid(uid);
      if (!parsed) return res.status(400).json({ error: 'Invalid UID format' });
      if (!(await db.blockExists(req.db, req.user.organizationId, parsed.block))) {
        return res.status(400).json({ error: `Block ${parsed.block} doesn't exist` });
      }
      if (!canManageBlock(req.user, parsed.block)) {
        const myBlock = req.user.blockCode ? await db.getBlock(req.db, req.user.organizationId, req.user.blockCode) : null;
        return res.status(403).json({ error: `You can only manage the ${myBlock?.name || 'your'} block` });
      }
      if (await db.uidTakenAnywhere(req.db, req.user.organizationId, uid, { tenantId: tenant.id })) {
        return res.status(409).json({ error: `UID ${uid} is already in use` });
      }
      fields.uid = uid;
    }

    if (phone && phone !== tenant.phone) {
      if (!/^\d{10}$/.test(phone)) return res.status(400).json({ error: 'Phone must be a 10-digit number' });
      if (await db.phoneTakenAnywhere(req.db, req.user.organizationId, phone, { tenantId: tenant.id })) {
        return res.status(409).json({ error: `Phone number ${phone} is already registered to someone else` });
      }
      fields.phone = phone;
    }

    // Move-in/move-out date changes — e.g. pushing back a booking, or
    // setting a vacate date on an already-active tenant so their bed frees
    // up automatically later. Sending vacateDate: null explicitly clears it
    // (cancels a scheduled move-out); omitting it leaves it untouched.
    if (req.body.joinDate !== undefined) {
      if (!/^\d{4}-\d{2}-\d{2}$/.test(req.body.joinDate)) return res.status(400).json({ error: 'Join date must be a valid date' });
      fields.joinDate = req.body.joinDate;
    }
    if (req.body.vacateDate !== undefined) {
      if (req.body.vacateDate !== null && !/^\d{4}-\d{2}-\d{2}$/.test(req.body.vacateDate)) {
        return res.status(400).json({ error: 'Vacate date must be a valid date' });
      }
      fields.vacateDate = req.body.vacateDate;
    }

    const updated = await db.updateTenant(req.db, req.user.organizationId, tenant.id, fields);
    await db.logAction(req.db, req.user.organizationId, req.user.name || req.user.id, 'UPDATE_TENANT', `Updated ${updated.name} (UID ${updated.uid})`);
    res.json({ tenant: updated, description: await db.describeUid(req.db, req.user.organizationId, updated.uid) });
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: 'Server error, please try again' });
  }
});

// DELETE
router.delete('/:id', requireAuth, withOrgScope, requireAdmin, async (req, res) => {
  try {
    const tenant = await db.getTenantById(req.db, req.user.organizationId, req.params.id);
    if (!tenant) return res.status(404).json({ error: 'Tenant not found' });

    const parsed = db.parseUid(tenant.uid);
    if (!canManageBlock(req.user, parsed.block)) {
      return res.status(403).json({ error: 'You do not have permission to delete this tenant' });
    }

    // A booking that never happened has nothing worth keeping — hard delete.
    // Someone who actually lived there keeps their history; they're just
    // moved to 'moved_out' so the bed frees up immediately.
    if (tenant.status === 'booked') {
      await db.deleteTenant(req.db, req.user.organizationId, tenant.id);
      await db.logAction(req.db, req.user.organizationId, req.user.name || req.user.id, 'CANCEL_BOOKING', `Cancelled booking for ${tenant.name} (UID ${tenant.uid})`);
    } else {
      await db.moveOutTenant(req.db, req.user.organizationId, tenant.id);
      await db.logAction(req.db, req.user.organizationId, req.user.name || req.user.id, 'MOVE_OUT_TENANT', `Moved out ${tenant.name} (UID ${tenant.uid}) — history kept, bed freed`);
    }
    res.json({ ok: true });
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: 'Server error, please try again' });
  }
});

// Live UID validation for the add/edit form
router.get('/validate/:uid', requireAuth, withOrgScope, requireAdmin, async (req, res) => {
  try {
    const { uid } = req.params;
    const parsed = db.parseUid(uid);
    if (!parsed) return res.json({ valid: false, reason: 'Format must be 5 digits: Block-Floor-RoomRoom-Bed' });
    const block = await db.getBlock(req.db, req.user.organizationId, parsed.block);
    if (!block) return res.json({ valid: false, reason: `Block ${parsed.block} doesn't exist` });
    const taken = await db.uidTakenAnywhere(req.db, req.user.organizationId, uid);
    res.json({
      valid: !taken,
      reason: taken ? 'UID already in use' : null,
      description: await db.describeUid(req.db, req.user.organizationId, uid),
      block,
    });
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: 'Server error, please try again' });
  }
});

module.exports = router;
