const pool = require('../db/pool');

// Run this AFTER requireAuth on every route that touches the database.
// req.user.organizationId comes from the verified JWT — never trust an
// organization_id from the request body/query string, or a hostile admin
// could pass someone else's org and read/write across the isolation wall.
//
// Attaches req.db (a client with app.org_id pinned for RLS — see
// db/pool.js getOrgClient) and ALWAYS releases it back to the pool when the
// response finishes, whether the request succeeded, errored, or the client
// disconnected early.
async function withOrgScope(req, res, next) {
  if (!req.user || !req.user.organizationId) {
    return res.status(403).json({ error: 'No organization context on this session — please log in again' });
  }
  try {
    req.db = await pool.getOrgClient(req.user.organizationId);
  } catch (e) {
    console.error('Failed to acquire org-scoped DB client:', e);
    return res.status(500).json({ error: 'Server error, please try again' });
  }

  let released = false;
  const release = () => {
    if (released) return;
    released = true;
    req.db.release();
  };
  res.on('finish', release);
  res.on('close', release);

  next();
}

module.exports = { withOrgScope };
