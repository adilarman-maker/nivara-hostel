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

// Any authenticated user (admin OR tenant) can read the list of blocks —
// block names aren't sensitive, and the tenant dashboard needs to show
// which block a tenant lives in.
router.get('/', requireAuth, withOrgScope, async (req, res) => {
  try {
    const blocks = await db.listBlocks(req.db, req.user.organizationId);
    res.json({ blocks });
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: 'Server error, please try again' });
  }
});

// SUPER ADMIN ONLY — create a block, optionally creating its sub-admin in
// the same step (this is the "set up the block and its admin together" flow).
router.post('/', requireAuth, withOrgScope, requireAdmin, requireSuper, async (req, res) => {
  try {
    const { name, address, owner, description, subAdmin } = req.body;
    if (!name || !name.trim()) return res.status(400).json({ error: 'Block name is required' });

    const block = await db.createBlock(req.db, req.user.organizationId, { name: name.trim(), address, owner, description });
    await db.logAction(req.db, req.user.organizationId, req.user.name, 'CREATE_BLOCK', `Created block "${block.name}" (code ${block.code})`);

    let createdAdmin = null;
    if (subAdmin && subAdmin.uid) {
      if (!db.isValidAdminUid(subAdmin.uid)) {
        return res.status(201).json({
          block,
          subAdminError: 'Block created, but the sub-admin UID must be 5 digits starting with 0 — add the sub-admin separately from Admin Accounts.',
        });
      }
      if (!/^\d{10}$/.test(subAdmin.phone || '')) {
        return res.status(201).json({
          block,
          subAdminError: 'Block created, but the sub-admin phone must be a 10-digit number — add the sub-admin separately from Admin Accounts.',
        });
      }
      if (!subAdmin.password || subAdmin.password.length < 6) {
        return res.status(201).json({
          block,
          subAdminError: 'Block created, but the sub-admin password must be at least 6 characters — add the sub-admin separately from Admin Accounts.',
        });
      }
      if (await db.uidTakenAnywhere(req.db, req.user.organizationId, subAdmin.uid)) {
        return res.status(201).json({ block, subAdminError: `Block created, but UID ${subAdmin.uid} is already in use — add the sub-admin separately.` });
      }
      if (await db.phoneTakenAnywhere(req.db, req.user.organizationId, subAdmin.phone)) {
        return res.status(201).json({ block, subAdminError: `Block created, but phone ${subAdmin.phone} is already in use — add the sub-admin separately.` });
      }

      const adminRow = {
        id: 'a-' + Date.now().toString(36) + Math.random().toString(36).slice(2, 6),
        uid: subAdmin.uid, phone: subAdmin.phone, username: subAdmin.uid,
        passwordHash: bcrypt.hashSync(subAdmin.password, 10),
        role: 'sub', blockCode: block.code, name: subAdmin.name || `${block.name} Admin`,
      };
      await db.insertAdmin(req.db, req.user.organizationId, adminRow);
      await db.logAction(req.db, req.user.organizationId, req.user.name, 'CREATE_SUB_ADMIN', `Created sub-admin ${adminRow.name} for block ${block.name}`);
      createdAdmin = { id: adminRow.id, uid: adminRow.uid, phone: adminRow.phone, name: adminRow.name };
    }

    res.status(201).json({ block, subAdmin: createdAdmin });
  } catch (e) {
    if (e.status) return res.status(e.status).json({ error: e.message });
    console.error(e);
    res.status(500).json({ error: 'Server error, please try again' });
  }
});

router.put('/:code', requireAuth, withOrgScope, requireAdmin, requireSuper, async (req, res) => {
  try {
    const { name, address, owner, description } = req.body;
    const block = await db.updateBlock(req.db, req.user.organizationId, req.params.code, { name, address, owner, description });
    if (!block) return res.status(404).json({ error: 'Block not found' });
    await db.logAction(req.db, req.user.organizationId, req.user.name, 'UPDATE_BLOCK', `Updated block "${block.name}" (code ${block.code})`);
    res.json({ block });
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: 'Server error, please try again' });
  }
});

router.delete('/:code', requireAuth, withOrgScope, requireAdmin, requireSuper, async (req, res) => {
  try {
    const block = await db.getBlock(req.db, req.user.organizationId, req.params.code);
    if (!block) return res.status(404).json({ error: 'Block not found' });
    await db.deleteBlock(req.db, req.user.organizationId, req.params.code);
    await db.logAction(req.db, req.user.organizationId, req.user.name, 'DELETE_BLOCK', `Deleted block "${block.name}" (code ${block.code})`);
    res.json({ ok: true });
  } catch (e) {
    if (e.status) return res.status(e.status).json({ error: e.message });
    console.error(e);
    res.status(500).json({ error: 'Server error, please try again' });
  }
});

// SUPER ADMIN ONLY — irreversible: wipes all rooms/tenants/payments/
// complaints for this block, but keeps the block and its sub-admin so the
// org can start fresh without recreating them. Requires the block's exact
// current name typed back, so this can't be triggered by an accidental click.
router.post('/:code/clear-data', requireAuth, withOrgScope, requireAdmin, requireSuper, async (req, res) => {
  try {
    const block = await db.getBlock(req.db, req.user.organizationId, req.params.code);
    if (!block) return res.status(404).json({ error: 'Block not found' });

    const confirmName = (req.body.confirmName || '').trim();
    if (confirmName !== block.name) {
      return res.status(400).json({ error: `Type the block's exact name ("${block.name}") to confirm this can't be undone.` });
    }

    const result = await db.clearBlockData(req.db, req.user.organizationId, block.code);
    await db.logAction(req.db, req.user.organizationId, 
      req.user.name,
      'CLEAR_BLOCK_DATA',
      `Cleared all data from block "${block.name}" (code ${block.code}) — removed ${result.tenantsRemoved} tenant(s) and ${result.roomsRemoved} room(s)`
    );
    res.json({ ok: true, ...result });
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: 'Server error, please try again' });
  }
});

module.exports = router;
