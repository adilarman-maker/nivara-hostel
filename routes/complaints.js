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

// Tenant submits a complaint — room/person/date are implicit from their own account
router.post('/', requireAuth, withOrgScope, requireTenant, async (req, res) => {
  try {
    const message = (req.body.message || '').trim();
    if (!message) return res.status(400).json({ error: 'Please describe the issue' });
    if (message.length > 2000) return res.status(400).json({ error: 'Please keep it under 2000 characters' });

    const complaint = await db.createComplaint(req.db, req.user.organizationId, req.user.id, message);
    const tenant = await db.getTenantById(req.db, req.user.organizationId, req.user.id);
    await db.logAction(req.db, req.user.organizationId, 
      tenant.name,
      'TENANT_COMPLAINT',
      `${tenant.name} (UID ${tenant.uid}) raised a complaint`
    );

    const blockCode = db.parseUid(tenant.uid).block;
    db.getPushSubscriptionsForAdmins(req.db, req.user.organizationId, blockCode)
      .then((subs) => sendPush(subs, {
        title: 'New complaint',
        body: `${tenant.name}: ${message.slice(0, 80)}${message.length > 80 ? '…' : ''}`,
        url: '/admin.html',
      }))
      .catch(() => {});

    res.status(201).json({ complaint });
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: 'Server error, please try again' });
  }
});

// Tenant views their own complaint history
router.get('/mine', requireAuth, withOrgScope, requireTenant, async (req, res) => {
  try {
    const complaints = await db.listComplaintsForTenant(req.db, req.user.organizationId, req.user.id);
    res.json({ complaints });
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: 'Server error, please try again' });
  }
});

// Admin view — Super Admin sees every complaint, sub-admins only their own block's
router.get('/', requireAuth, withOrgScope, requireAdmin, async (req, res) => {
  try {
    const page = Math.max(parseInt(req.query.page, 10) || 1, 1);
    const limit = Math.min(parseInt(req.query.limit, 10) || 100, 200);
    const blockFilter = req.user.role === 'super' ? null : req.user.blockCode;
    const result = await db.listComplaintsForAdmin(req.db, req.user.organizationId, blockFilter, { page, limit });
    res.json(result);
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: 'Server error, please try again' });
  }
});

router.post('/:id/resolve', requireAuth, withOrgScope, requireAdmin, async (req, res) => {
  try {
    const complaint = await db.getComplaintById(req.db, req.user.organizationId, req.params.id);
    if (!complaint) return res.status(404).json({ error: 'Complaint not found' });

    const parsed = db.parseUid(complaint.tenantUid);
    if (req.user.role !== 'super' && String(req.user.blockCode) !== String(parsed.block)) {
      return res.status(403).json({ error: 'You can only manage complaints in your own block' });
    }

    const updated = await db.resolveComplaint(req.db, req.user.organizationId, complaint.id);
    await db.logAction(req.db, req.user.organizationId, req.user.name, 'RESOLVE_COMPLAINT', `Resolved complaint from ${complaint.tenantName} (UID ${complaint.tenantUid})`);

    db.getPushSubscriptionsForUser(req.db, req.user.organizationId, 'tenant', complaint.tenantId)
      .then((subs) => sendPush(subs, {
        title: 'Complaint resolved ✅',
        body: `Your complaint has been marked resolved.`,
        url: '/tenant.html',
      }))
      .catch(() => {});

    res.json({ complaint: updated });
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: 'Server error, please try again' });
  }
});

module.exports = router;
