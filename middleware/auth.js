const jwt = require('jsonwebtoken');

const JWT_SECRET = process.env.JWT_SECRET || 'nivara-dev-secret-change-in-production';

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

module.exports = { sign, requireAuth, requireAdmin, requireBlockAccess, JWT_SECRET };
