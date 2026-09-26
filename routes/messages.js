const express = require('express');
const db = require('../db/database');
const { withOrgScope } = require('../middleware/orgScope');
const { requireAuth, requireAdmin } = require('../middleware/auth');
const { sendPush } = require('../lib/push');

const router = express.Router();

// Resolves "which block should this viewer's feed be scoped to" for both
// admin and tenant tokens — null means "Super Admin, sees every block's
// messages plus global ones", any other value means "this block's messages
// plus global ones only".
function viewerScopeBlock(user) {
  if (user.type === 'admin') return user.role === 'super' ? null : user.blockCode;
  // tenant: derive their block from their own UID's first digit
  const parsed = db.parseUid(user.uid);
  return parsed ? String(parsed.block) : null;
}

function voterIdentity(user, adminNameIfKnown) {
  if (user.type === 'admin') return { key: `admin:${user.id}`, name: adminNameIfKnown || user.name || 'Admin' };
  return { key: `tenant:${user.id}`, name: null }; // tenant name filled in by caller from DB
}

const MAX_IMAGE_BASE64_LENGTH = 900 * 1024; // ~650KB actual image after base64 overhead — plenty for a chat photo, keeps the DB sane

// GET /api/messages?after=<ISO timestamp>&channel=<all|admins|blockCode>
// Both admins and tenants can read. `after` supports cheap polling — pass
// the newest createdAt you already have and only new messages come back.
// `channel` drives the chat-list-style filter tabs: a SPECIFIC block code
// (any block, not just your own — admins can browse other blocks read-only,
// same as everywhere else in this app) or 'admins' for the private
// admin-only channel. Tenants are hard-restricted server-side to their own
// scope regardless of what they pass — they can never peek into another
// block's channel or the admin-only one.
router.get('/', requireAuth, withOrgScope, async (req, res) => {
  try {
    const isAdmin = req.user.type === 'admin';
    const scopeBlock = viewerScopeBlock(req.user);
    const viewerKey = isAdmin ? `admin:${req.user.id}` : `tenant:${req.user.id}`;

    let channel = req.query.channel || 'all';
    if (!isAdmin) channel = 'all'; // tenants never get cross-block or admin-only browsing, no matter what they ask for

    const messages = await db.listMessagesForScope(req.db, req.user.organizationId, scopeBlock, {
      after: req.query.after || null,
      limit: Math.min(parseInt(req.query.limit, 10) || 50, 100),
      viewerKey,
      isAdmin,
      channel,
    });
    res.json({ messages });
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: 'Server error, please try again' });
  }
});

// POST /api/messages — ADMIN ONLY (super or sub). A sub-admin's message is
// always scoped to their own block (they can't choose otherwise); a Super
// Admin can post to one specific block or to the whole hostel (omit block).
// adminOnly marks it as visible to admins only, regardless of block scope.
router.post('/', requireAuth, withOrgScope, requireAdmin, async (req, res) => {
  try {
    const type = req.body.type;
    if (!['text', 'image', 'poll', 'contact'].includes(type)) {
      return res.status(400).json({ error: 'Invalid message type' });
    }

    let scopeBlock = null;
    if (req.user.role === 'sub') {
      scopeBlock = req.user.blockCode; // forced — a sub-admin cannot broadcast outside their own block
    } else if (req.body.scopeBlock) {
      scopeBlock = String(req.body.scopeBlock);
      if (!(await db.blockExists(req.db, req.user.organizationId, scopeBlock))) return res.status(400).json({ error: 'Invalid block' });
    }

    const msg = {
      id: 'm-' + Date.now().toString(36) + Math.random().toString(36).slice(2, 8),
      senderId: req.user.id,
      senderName: req.user.name,
      senderRole: req.user.role,
      scopeBlock,
      adminOnly: !!req.body.adminOnly,
      type,
      body: (req.body.body || '').trim(),
    };

    if (type === 'text') {
      if (!msg.body) return res.status(400).json({ error: 'Message text cannot be empty' });
    } else if (type === 'image') {
      const imageData = req.body.imageData || '';
      if (!imageData.startsWith('data:image/')) return res.status(400).json({ error: 'Invalid image data' });
      if (imageData.length > MAX_IMAGE_BASE64_LENGTH) {
        return res.status(413).json({ error: 'Image is too large — please use a smaller photo (it should already be compressed client-side)' });
      }
      msg.imageData = imageData;
    } else if (type === 'poll') {
      const question = (req.body.pollQuestion || '').trim();
      const options = Array.isArray(req.body.pollOptions) ? req.body.pollOptions.map((o) => String(o).trim()).filter(Boolean) : [];
      if (!question) return res.status(400).json({ error: 'Poll needs a question' });
      if (options.length < 2 || options.length > 8) return res.status(400).json({ error: 'Poll needs between 2 and 8 options' });
      msg.pollQuestion = question;
      msg.pollOptions = options;
    } else if (type === 'contact') {
      const contactName = (req.body.contactName || '').trim();
      const contactPhone = (req.body.contactPhone || '').trim();
      if (!contactName || !/^\d{10}$/.test(contactPhone)) {
        return res.status(400).json({ error: 'Contact card needs a name and a valid 10-digit phone number' });
      }
      msg.contactName = contactName;
      msg.contactPhone = contactPhone;
    }

    const created = await db.createMessage(req.db, req.user.organizationId, msg);
    await db.logAction(req.db, req.user.organizationId, req.user.name, 'POST_MESSAGE', `Posted a ${type} message` + (msg.adminOnly ? ' to the Admin team channel' : scopeBlock ? ` to block ${scopeBlock}` : ' to all blocks'));

    const previewBody = type === 'text' ? msg.body : type === 'poll' ? msg.pollQuestion : type === 'image' ? 'Sent a photo' : `Contact: ${msg.contactName}`;
    db.getPushSubscriptionsForMessage(req.db, req.user.organizationId, { adminOnly: msg.adminOnly, scopeBlock })
      .then((subs) => sendPush(subs, {
        title: `New message from ${req.user.name}`,
        body: previewBody.slice(0, 100),
        url: msg.adminOnly ? '/admin.html' : '/tenant.html', // matches who actually receives it, not who sent it
      }))
      .catch(() => {});

    res.status(201).json({ message: created });
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: 'Server error, please try again' });
  }
});

// POST /api/messages/:id/vote — any admin or tenant within the message's
// visibility scope can vote. Re-voting changes your vote rather than erroring.
router.post('/:id/vote', requireAuth, withOrgScope, async (req, res) => {
  try {
    const message = await db.getMessageById(req.db, req.user.organizationId, req.params.id);
    if (!message || message.type !== 'poll') return res.status(404).json({ error: 'Poll not found' });

    const scopeBlock = viewerScopeBlock(req.user);
    const inScope = message.scopeBlock === null || scopeBlock === null || String(message.scopeBlock) === String(scopeBlock);
    if (!inScope) return res.status(403).json({ error: "You don't have access to this poll" });

    const optionIndex = parseInt(req.body.optionIndex, 10);
    if (isNaN(optionIndex) || optionIndex < 0 || optionIndex >= message.pollOptions.length) {
      return res.status(400).json({ error: 'Invalid option' });
    }

    let voterName;
    if (req.user.type === 'admin') {
      voterName = req.user.name;
    } else {
      const tenant = await db.getTenantById(req.db, req.user.organizationId, req.user.id);
      voterName = tenant ? tenant.name : 'Tenant';
    }
    const identity = voterIdentity(req.user, voterName);
    await db.voteOnPoll(req.db, req.user.organizationId, message.id, identity.key, voterName, optionIndex);

    const refreshed = await db.getMessageWithTally(req.db, req.user.organizationId, message.id, identity.key);
    res.json({ message: refreshed });
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: 'Server error, please try again' });
  }
});

// PUT /api/messages/:id — sender edits their own message (Super Admin can
// also edit anyone's, same moderation privilege as delete). Only the fields
// relevant to that message's type are accepted.
router.put('/:id', requireAuth, withOrgScope, requireAdmin, async (req, res) => {
  try {
    const message = await db.getMessageById(req.db, req.user.organizationId, req.params.id);
    if (!message) return res.status(404).json({ error: 'Message not found' });
    if (req.user.role !== 'super' && message.senderId !== req.user.id) {
      return res.status(403).json({ error: 'You can only edit your own messages' });
    }

    const fields = {};
    if (message.type === 'text' || message.type === 'image') {
      if (req.body.body !== undefined) fields.body = String(req.body.body).trim();
      if (message.type === 'text' && !fields.body) return res.status(400).json({ error: 'Message text cannot be empty' });
    } else if (message.type === 'poll') {
      if (req.body.pollQuestion !== undefined) {
        fields.pollQuestion = String(req.body.pollQuestion).trim();
        if (!fields.pollQuestion) return res.status(400).json({ error: 'Poll needs a question' });
      }
      if (req.body.pollOptions !== undefined) {
        const options = Array.isArray(req.body.pollOptions) ? req.body.pollOptions.map((o) => String(o).trim()).filter(Boolean) : [];
        if (options.length < 2 || options.length > 8) return res.status(400).json({ error: 'Poll needs between 2 and 8 options' });
        fields.pollOptions = options;
      }
    } else if (message.type === 'contact') {
      if (req.body.contactName !== undefined) fields.contactName = String(req.body.contactName).trim();
      if (req.body.contactPhone !== undefined) {
        const phone = String(req.body.contactPhone).trim();
        if (!/^\d{10}$/.test(phone)) return res.status(400).json({ error: 'Enter a valid 10-digit phone number' });
        fields.contactPhone = phone;
      }
    }

    const updated = await db.updateMessage(req.db, req.user.organizationId, message.id, fields);
    await db.logAction(req.db, req.user.organizationId, req.user.name, 'EDIT_MESSAGE', `Edited a ${message.type} message`);
    res.json({ message: updated });
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: 'Server error, please try again' });
  }
});

// GET /api/messages/:id/votes — full per-voter breakdown for the "Info"
// panel. Kept separate from the main feed fetch so browsing the board never
// exposes every voter's identity by default — only asking for Info does.
router.get('/:id/votes', requireAuth, withOrgScope, async (req, res) => {
  try {
    const message = await db.getMessageById(req.db, req.user.organizationId, req.params.id);
    if (!message || message.type !== 'poll') return res.status(404).json({ error: 'Poll not found' });

    const isAdmin = req.user.type === 'admin';
    const scopeBlock = viewerScopeBlock(req.user);
    if (message.adminOnly && !isAdmin) return res.status(403).json({ error: "You don't have access to this poll" });
    const inScope = message.scopeBlock === null || scopeBlock === null || String(message.scopeBlock) === String(scopeBlock);
    if (!inScope) return res.status(403).json({ error: "You don't have access to this poll" });

    const voters = await db.getPollVoterBreakdown(req.db, req.user.organizationId, message.id);
    res.json({ voters });
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: 'Server error, please try again' });
  }
});

// DELETE /api/messages/:id — the sender can delete their own message; a
// Super Admin can delete anyone's (moderation).
router.delete('/:id', requireAuth, withOrgScope, requireAdmin, async (req, res) => {
  try {
    const message = await db.getMessageById(req.db, req.user.organizationId, req.params.id);
    if (!message) return res.status(404).json({ error: 'Message not found' });
    if (req.user.role !== 'super' && message.senderId !== req.user.id) {
      return res.status(403).json({ error: 'You can only delete your own messages' });
    }
    await db.deleteMessage(req.db, req.user.organizationId, message.id);
    await db.logAction(req.db, req.user.organizationId, req.user.name, 'DELETE_MESSAGE', `Deleted a message from ${message.senderName}`);
    res.json({ ok: true });
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: 'Server error, please try again' });
  }
});

module.exports = router;
