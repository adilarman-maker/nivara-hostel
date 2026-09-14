const jwt = require('jsonwebtoken');

const JWT_SECRET = process.env.JWT_SECRET || 'getnesty-dev-secret-change-in-production';

function sign(payload) {
  return jwt.sign(payload, JWT_SECRET, { expiresIn: '12h' });
}

function requireAuth(req, res, next) {
  const header = req.headers.authorization || '';
  const token = header.startsWith('Bearer ') ? header.slice(7) : null;
  if (!token) return res.status(401).json({ error: 'Not authenticated' });
  try {
    req.user = jwt.verify(token, JWT_SECRET);
    next();
  } catch (e) {
    return res.status(401).json({ error: 'Session expired, please log in again' });
  }
}

function requireAdmin(req, res, next) {
  if (!req.user || req.user.type !== 'admin') {
    return res.status(403).json({ error: 'Admin access required' });
  }
  next();
}

// Sub-admins are view-only across the whole app — they can see everything
// in their block, but every create/update/delete action (tenants, rooms,
// beds, payments, complaint resolution, admin accounts, blocks) requires
// the Super Admin. Put this on every write route, after requireAdmin.
function requireSuperAdmin(req, res, next) {
  if (!req.user || req.user.role !== 'super') {
    return res.status(403).json({ error: 'Sub-admins have view-only access — ask your Super Admin to make this change.' });
  }
  next();
}

// Blocks a sub-admin from touching a block that isn't theirs.
// Super admin (blockCode null) always passes.
function requireBlockAccess(getBlockCodeFromReq) {
  return (req, res, next) => {
    if (req.user.role === 'super') return next();
    const targetBlock = getBlockCodeFromReq(req);
    if (req.user.blockCode !== targetBlock) {
      return res.status(403).json({ error: 'You do not have permission to manage this block' });
    }
    next();
  };
}

// Platform Admin — a tier ABOVE every hostel, not scoped to any
// organization_id at all (see db/schema.sql platform_admins). Their JWT has
// no organizationId, so this must run INSTEAD OF withOrgScope, never
// alongside it — routes/platform.js talks to the database via the plain
// pool, same as the pre-login lookups in db/database.js.
function requirePlatformAdmin(req, res, next) {
  if (!req.user || req.user.type !== 'platform') {
    return res.status(403).json({ error: 'Platform Admin access required' });
  }
  next();
}

module.exports = { sign, requireAuth, requireAdmin, requireSuperAdmin, requireBlockAccess, requirePlatformAdmin, JWT_SECRET };
