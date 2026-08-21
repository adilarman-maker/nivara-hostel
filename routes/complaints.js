const express = require('express');
const db = require('../db/database');
const { requireAuth, requireAdmin } = require('../middleware/auth');

const router = express.Router();

function requireTenant(req, res, next) {
  if (!req.user || req.user.type !== 'tenant') return res.status(403).json({ error: 'Tenant access required' });
  next();
}

// Tenant submits a complaint — room/person/date are implicit from their own account
router.post('/', requireAuth, requireTenant, async (req, res) => {
  try {
    const message = (req.body.message || '').trim();
    if (!message) return res.status(400).json({ error: 'Please describe the issue' });
    if (message.length > 2000) return res.status(400).json({ error: 'Please keep it under 2000 characters' });

    const complaint = await db.createComplaint(req.user.id, message);
    const tenant = await db.getTenantById(req.user.id);
    await db.logAction(
      tenant.name,
      'TENANT_COMPLAINT',
      `${tenant.name} (UID ${tenant.uid}) raised a complaint`
    );
    res.status(201).json({ complaint });
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: 'Server error, please try again' });
  }
});

// Tenant views their own complaint history
router.get('/mine', requireAuth, requireTenant, async (req, res) => {
  try {
    const complaints = await db.listComplaintsForTenant(req.user.id);
    res.json({ complaints });
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: 'Server error, please try again' });
  }
});

// Admin view — Super Admin sees every complaint, sub-admins only their own block's
router.get('/', requireAuth, requireAdmin, async (req, res) => {
  try {
    const page = Math.max(parseInt(req.query.page, 10) || 1, 1);
    const limit = Math.min(parseInt(req.query.limit, 10) || 100, 200);
    const blockFilter = req.user.role === 'super' ? null : req.user.blockCode;
    const result = await db.listComplaintsForAdmin(blockFilter, { page, limit });
    res.json(result);
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: 'Server error, please try again' });
  }
});

router.post('/:id/resolve', requireAuth, requireAdmin, async (req, res) => {
  try {
    const complaint = await db.getComplaintById(req.params.id);
    if (!complaint) return res.status(404).json({ error: 'Complaint not found' });

    const parsed = db.parseUid(complaint.tenantUid);
    if (req.user.role !== 'super' && req.user.blockCode !== parsed.block) {
      return res.status(403).json({ error: 'You can only manage complaints in your own block' });
    }

    const updated = await db.resolveComplaint(complaint.id);
    await db.logAction(req.user.name, 'RESOLVE_COMPLAINT', `Resolved complaint from ${complaint.tenantName} (UID ${complaint.tenantUid})`);
    res.json({ complaint: updated });
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: 'Server error, please try again' });
  }
});

module.exports = router;
