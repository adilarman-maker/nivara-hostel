const express = require('express');
const db = require('../db/database');
const { withOrgScope } = require('../middleware/orgScope');
const { requireAuth, requireSuperAdmin } = require('../middleware/auth');

const router = express.Router();

// Generous but bounded — this is one JSON document that can hold several
// embedded images, but it isn't meant to become a file store. Mirrors the
// spirit of MAX_IMAGE_BASE64_LENGTH in routes/messages.js, just for the
// whole document rather than one image.
const MAX_INFO_PAGE_BYTES = 4 * 1024 * 1024; // 4MB

// Any signed-in person in the org can view it — tenants need to read the
// rules as much as admins do.
router.get('/', requireAuth, withOrgScope, async (req, res) => {
  try {
    const page = await db.getInfoPage(req.db, req.user.organizationId);
    res.json(page);
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: 'Server error, please try again' });
  }
});

// Editing is Super Admin only — this is one shared, hostel-wide document,
// not something scoped to a single block a Sub Admin manages.
router.put('/', requireAuth, withOrgScope, requireSuperAdmin, async (req, res) => {
  try {
    const { blocks } = req.body;
    if (!Array.isArray(blocks)) return res.status(400).json({ error: 'blocks must be an array' });

    const serialized = JSON.stringify(blocks);
    if (Buffer.byteLength(serialized, 'utf8') > MAX_INFO_PAGE_BYTES) {
      return res.status(413).json({ error: 'This page has gotten too large (likely from embedded images) — remove or shrink an image and try again' });
    }

    await db.setInfoPage(req.db, req.user.organizationId, blocks);
    await db.logAction(req.db, req.user.organizationId, req.user.name, 'INFO_PAGE_UPDATED', `${req.user.name} updated the hostel info page (${blocks.length} block${blocks.length === 1 ? '' : 's'})`);
    res.json({ blocks });
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: 'Server error, please try again' });
  }
});

module.exports = router;
