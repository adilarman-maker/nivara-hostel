const pool = require('./pool');
const bcrypt = require('bcryptjs');

// ---------- UID helpers (pure functions, no DB) ----------
// Blocks are admin-created now (see the `blocks` DB functions below), but
// the UID *shape* is still fixed: 5 digits, [Block 1-9][Floor][Room 01-99][Bed 1-9].
// parseUid only validates the SHAPE — whether a given block digit currently
// has a real block behind it is a separate, async, DB-backed question
// (see getBlock/blockExists), checked wherever it actually matters (creating
// a room or tenant), not baked into this pure function.

function parseUid(uid) {
  if (!/^\d{5}$/.test(uid)) return null;
  const block = parseInt(uid[0], 10);
  const floor = parseInt(uid[1], 10);
  const room = parseInt(uid.slice(2, 4), 10);
  const bed = parseInt(uid[4], 10);
  if (block < 1 || block > 9) return null;
  if (room < 1 || bed < 1) return null;
  return { block, floor, room, bed };
}

// Async because the block's NAME lives in the database now, not a static
// constant. Used in a handful of places (tenant create/update responses),
// not a hot path, so making it async is a fine trade for correctness.
//
// EVERY function below this point takes (client, organizationId, ...) as its
// first two arguments:
//   - client         -> the request-scoped Postgres client from
//                        middleware/orgScope.js (req.db). Has the RLS
//                        session var app.org_id already pinned, so every
//                        SELECT/UPDATE/DELETE is automatically restricted to
//                        this organization even if a WHERE clause forgot to
//                        say so.
//   - organizationId  -> the SAME organization, as a plain value. Needed
//                        because RLS can't invent a value for a new row's
//                        organization_id column on INSERT — the app has to
//                        supply it explicitly, and it's included directly in
//                        WHERE clauses too as a second, explicit wall on top
//                        of RLS (matches the "app filter + RLS" design).
// The three EXCEPTIONS are findOrgBySlug / findAdminByUidPhone /
// findTenantByUidPhone — the login-time lookups that run BEFORE we know
// which organization we're in, which still use the plain unscoped `pool`.
async function describeUid(client, organizationId, uid) {
  const parsed = parseUid(uid);
  if (!parsed) return null;
  const block = await getBlock(client, organizationId, String(parsed.block));
  const blockName = block ? block.name : `Block ${parsed.block}`;
  return `${blockName} • Floor ${parsed.floor} • Room ${String(parsed.room).padStart(2, '0')} • Bed ${parsed.bed}`;
}

function buildUid(block, floor, room, bed) {
  return `${block}${floor}${String(room).padStart(2, '0')}${bed}`;
}

// ADMIN uid: 5 digits too, but the first digit must be exactly 0 — blocks
// now occupy every digit 1-9, so 0 is the only digit left that can never
// collide with (or be mistaken for) a real tenant room code.
function isValidAdminUid(uid) {
  if (!/^\d{5}$/.test(uid || '')) return false;
  return uid[0] === '0';
}

// ---------- blocks ----------

function mapBlock(row) {
  if (!row) return null;
  return {
    code: row.code,
    name: row.name,
    address: row.address,
    owner: row.owner,
    description: row.description,
    createdAt: row.created_at,
  };
}

async function listBlocks(client, organizationId) {
  const { rows } = await client.query(`SELECT * FROM blocks WHERE organization_id = $1 ORDER BY code`, [organizationId]);
  return rows.map(mapBlock);
}

async function getBlock(client, organizationId, code) {
  const { rows } = await client.query(`SELECT * FROM blocks WHERE organization_id = $1 AND code = $2`, [organizationId, String(code)]);
  return mapBlock(rows[0]);
}

async function blockExists(client, organizationId, code) {
  const { rows } = await client.query(`SELECT 1 FROM blocks WHERE organization_id = $1 AND code = $2`, [organizationId, String(code)]);
  return rows.length > 0;
}

// Auto-assigns the next free digit 1-9. Returns null if all 9 are already used.
async function nextFreeBlockCode(client, organizationId) {
  const { rows } = await client.query(`SELECT code FROM blocks WHERE organization_id = $1`, [organizationId]);
  const used = new Set(rows.map((r) => r.code));
  for (let i = 1; i <= 9; i++) {
    if (!used.has(String(i))) return String(i);
  }
  return null;
}

async function createBlock(client, organizationId, { name, address, owner, description }) {
  const code = await nextFreeBlockCode(client, organizationId);
  if (!code) {
    const err = new Error('All 9 possible block codes are in use — the UID scheme cannot support more than 9 blocks.');
    err.status = 409;
    throw err;
  }
  const { rows } = await client.query(
    `INSERT INTO blocks (organization_id, code, name, address, owner, description) VALUES ($1,$2,$3,$4,$5,$6) RETURNING *`,
    [organizationId, code, name, address || '', owner || '', description || '']
  );
  return mapBlock(rows[0]);
}

async function updateBlock(client, organizationId, code, { name, address, owner, description }) {
  const { rows } = await client.query(
    `UPDATE blocks SET
       name = COALESCE($3, name),
       address = COALESCE($4, address),
       owner = COALESCE($5, owner),
       description = COALESCE($6, description)
     WHERE organization_id = $1 AND code = $2 RETURNING *`,
    [organizationId, String(code), name ?? null, address ?? null, owner ?? null, description ?? null]
  );
  return mapBlock(rows[0]);
}

// Deletion is deliberately blocked if the block still has rooms or an
// assigned admin — forces a clean, deliberate teardown (remove rooms /
// reassign the admin first) rather than silently orphaning data.
async function deleteBlock(client, organizationId, code) {
  const { rows: roomRows } = await client.query(
    `SELECT 1 FROM rooms WHERE organization_id = $1 AND block_code = $2 LIMIT 1`, [organizationId, String(code)]);
  if (roomRows.length > 0) {
    const err = new Error('This block still has rooms in it — remove all rooms before deleting the block.');
    err.status = 409;
    throw err;
  }
  const { rows: adminRows } = await client.query(
    `SELECT 1 FROM admins WHERE organization_id = $1 AND block_code = $2 LIMIT 1`, [organizationId, String(code)]);
  if (adminRows.length > 0) {
    const err = new Error('This block still has a sub-admin assigned — reassign or remove that admin before deleting the block.');
    err.status = 409;
    throw err;
  }
  const { rowCount } = await client.query(`DELETE FROM blocks WHERE organization_id = $1 AND code = $2`, [organizationId, String(code)]);
  return rowCount > 0;
}

// Wipes everything IN a block (rooms, tenants, their payments and
// complaints) but keeps the block record itself and its sub-admin — the
// difference from deleteBlock() above, which requires the block to already
// be empty. Use this when an org wants to reset a block and start over
// without recreating the block/sub-admin from scratch. Runs as one
// transaction: either all of it clears or none of it does.
//
// Uses the SAME request-scoped `client` for BEGIN/COMMIT rather than
// opening its own separate connection — there's no need for a second
// connection since Node only ever does one thing at a time per request, and
// reusing it keeps this transaction under the same RLS session context.
async function clearBlockData(client, organizationId, code) {
  try {
    await client.query('BEGIN');
    const codeStr = String(code);
    // Tenants in this block = uid starting with this block's digit (same
    // pattern used everywhere else in this file, e.g. idx_tenants_block_char).
    await pool.timedQuery(client,
      `DELETE FROM complaints WHERE organization_id = $1 AND tenant_id IN (SELECT id FROM tenants WHERE organization_id = $1 AND LEFT(uid, 1) = $2)`,
      [organizationId, codeStr]);
    await pool.timedQuery(client,
      `DELETE FROM payments WHERE organization_id = $1 AND tenant_id IN (SELECT id FROM tenants WHERE organization_id = $1 AND LEFT(uid, 1) = $2)`,
      [organizationId, codeStr]);
    const { rowCount: tenantsRemoved } = await pool.timedQuery(client,
      `DELETE FROM tenants WHERE organization_id = $1 AND LEFT(uid, 1) = $2`, [organizationId, codeStr]);
    const { rowCount: roomsRemoved } = await pool.timedQuery(client,
      `DELETE FROM rooms WHERE organization_id = $1 AND block_code = $2`, [organizationId, codeStr]);
    await client.query('COMMIT');
    return { tenantsRemoved, roomsRemoved };
  } catch (e) {
    await client.query('ROLLBACK');
    throw e;
  }
}

// ---------- login-time lookups (UNSCOPED — run before we know the org) ----------

async function findOrgBySlug(slug) {
  const { rows } = await pool.query(`SELECT * FROM organizations WHERE slug = $1 AND active = true`, [String(slug || '').trim().toLowerCase()]);
  return rows[0] || null;
}

async function findAdminByUidPhone(organizationId, uid, phone) {
  const { rows } = await pool.query(
    `SELECT * FROM admins WHERE organization_id = $1 AND uid = $2 AND phone = $3`,
    [organizationId, uid, phone]
  );
  return rows[0] || null;
}

async function findTenantByUidPhone(organizationId, uid, phone) {
  const { rows } = await pool.query(
    `SELECT * FROM tenants WHERE organization_id = $1 AND uid = $2 AND phone = $3`,
    [organizationId, uid, phone]
  );
  return mapTenant(rows[0]);
}

// ---------- platform admin (UNSCOPED BY DESIGN — sits above every org, see schema.sql) ----------

async function findPlatformAdminByUsername(username) {
  const { rows } = await pool.query(`SELECT * FROM platform_admins WHERE username = $1`, [username]);
  return rows[0] || null;
}

// One row per hostel, with just enough live counts to be useful at a glance
// without pulling every tenant/admin row into memory.
async function listOrganizationsWithStats() {
  const { rows } = await pool.query(`
    SELECT o.id, o.slug, o.name, o.active, o.created_at,
      (SELECT COUNT(*)::int FROM tenants t WHERE t.organization_id = o.id AND t.status != 'moved_out') AS active_tenants,
      (SELECT COUNT(*)::int FROM admins a WHERE a.organization_id = o.id) AS admin_count,
      (SELECT COUNT(*)::int FROM blocks b WHERE b.organization_id = o.id) AS block_count
    FROM organizations o
    ORDER BY o.created_at DESC
  `);
  return rows.map((r) => ({
    id: r.id, slug: r.slug, name: r.name, active: r.active, createdAt: r.created_at,
    activeTenants: r.active_tenants, adminCount: r.admin_count, blockCount: r.block_count,
  }));
}

async function getOrganizationById(id) {
  const { rows } = await pool.query(`SELECT * FROM organizations WHERE id = $1`, [id]);
  return rows[0] || null;
}

// Used by the "which hostel am I in" display in the admin/tenant sidebars —
// scoped through the org-pinned client (not the raw pool) so it goes
// through RLS like everything else a logged-in admin/tenant can see.
async function getOwnOrganization(client, organizationId) {
  const { rows } = await client.query(`SELECT name, slug FROM organizations WHERE id = $1`, [organizationId]);
  return rows[0] || null;
}

async function slugTaken(slug) {
  const { rows } = await pool.query(`SELECT 1 FROM organizations WHERE slug = $1`, [String(slug).trim().toLowerCase()]);
  return rows.length > 0;
}

// Creates a hostel AND its first Super Admin in one transaction — never a
// hostel with no way to log into it, or vice versa. Uses the plain pool's
// own connection for the transaction (not a request-scoped org client —
// there IS no organization yet when this starts).
async function createOrganizationWithSuperAdmin({ orgId, slug, orgName, admin }) {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await client.query(`INSERT INTO organizations (id, slug, name) VALUES ($1,$2,$3)`, [orgId, slug, orgName]);
    const passwordHash = bcrypt.hashSync(admin.password, 10);
    await client.query(
      `INSERT INTO admins (id, organization_id, uid, phone, username, password_hash, role, block_code, name)
       VALUES ($1,$2,$3,$4,$5,$6,'super',NULL,$7)`,
      [admin.id, orgId, admin.uid, admin.phone, admin.uid, passwordHash, admin.name]
    );
    await client.query('COMMIT');
    return { id: orgId, slug, name: orgName };
  } catch (e) {
    await client.query('ROLLBACK');
    throw e;
  } finally {
    client.release();
  }
}

async function setOrganizationActive(id, active) {
  const { rows } = await pool.query(`UPDATE organizations SET active = $2 WHERE id = $1 RETURNING *`, [id, active]);
  return rows[0] || null;
}

// Resets the login credentials of an org's Super Admin — for when they're
// locked out. Deliberately targets role='super' (there's exactly one per
// org) rather than requiring the platform admin to know an admin id.
async function resetOrgSuperAdmin(organizationId, { uid, phone, password }) {
  const passwordHash = bcrypt.hashSync(password, 10);
  const { rows } = await pool.query(
    `UPDATE admins SET uid = $2, phone = $3, password_hash = $4
     WHERE organization_id = $1 AND role = 'super'
     RETURNING id, uid, phone, name`,
    [organizationId, uid, phone, passwordHash]
  );
  return rows[0] || null;
}

// Hard delete — every table's organization_id has ON DELETE CASCADE, so
// this one statement removes every tenant, room, payment, message, etc.
// belonging to this org. No undo. See routes/platform.js for the
// type-the-name confirmation gate in front of this.
async function deleteOrganizationHard(id) {
  const { rowCount } = await pool.query(`DELETE FROM organizations WHERE id = $1`, [id]);
  return rowCount > 0;
}

// ---------- admins ----------

async function findAdminById(client, organizationId, id) {
  const { rows } = await client.query(`SELECT * FROM admins WHERE organization_id = $1 AND id = $2`, [organizationId, id]);
  return rows[0] || null;
}

async function listAdmins(client, organizationId) {
  const { rows } = await client.query(
    `SELECT id, uid, phone, username, role, block_code AS "blockCode", name,
            payment_confirm_blocks AS "paymentConfirmBlocks"
     FROM admins WHERE organization_id = $1 ORDER BY role DESC, block_code`,
    [organizationId]
  );
  return rows;
}

// scope: null/[] = no confirmation access (default), ['*'] = every block,
// or a specific array of block codes e.g. ['1','3']. Ignored for role='super'.
async function setAdminPaymentConfirmScope(client, organizationId, id, scope) {
  const admin = await findAdminById(client, organizationId, id);
  if (!admin) return null;
  if (admin.role === 'super') {
    const err = new Error('The Super Admin already has full access — nothing to grant');
    err.status = 400;
    throw err;
  }
  const cleaned = Array.isArray(scope) && scope.length ? scope.map(String) : null;
  const { rows } = await client.query(
    `UPDATE admins SET payment_confirm_blocks = $3 WHERE organization_id = $1 AND id = $2
     RETURNING id, uid, phone, username, role, block_code AS "blockCode", name,
               payment_confirm_blocks AS "paymentConfirmBlocks"`,
    [organizationId, id, cleaned]
  );
  return rows[0] || null;
}

// Central check for "can this admin confirm a payment for this block?" —
// used by the proof approve/reject routes and the pending-proofs listing.
// Super Admin always passes; a sub-admin needs an explicit grant (see
// setAdminPaymentConfirmScope above) that covers '*' (all blocks) or this
// specific block. Accepts either a camelCase-mapped admin object or a raw
// DB row (snake_case), since callers fetch admins both ways.
function canConfirmPaymentsForBlock(admin, blockCode) {
  if (!admin) return false;
  if (admin.role === 'super') return true;
  const scope = admin.paymentConfirmBlocks || admin.payment_confirm_blocks || [];
  if (!scope || scope.length === 0) return false;
  if (scope.includes('*')) return true;
  return scope.map(String).includes(String(blockCode));
}

async function updateAdminPasswordHash(client, organizationId, id, passwordHash) {
  const { rowCount } = await client.query(
    `UPDATE admins SET password_hash = $1 WHERE organization_id = $2 AND id = $3`, [passwordHash, organizationId, id]);
  return rowCount > 0;
}

async function updateAdminUidPhone(client, organizationId, id, { uid, phone }) {
  const { rows } = await client.query(
    `UPDATE admins SET
       uid = COALESCE($3, uid),
       phone = COALESCE($4, phone)
     WHERE organization_id = $1 AND id = $2
     RETURNING id, uid, phone, username, role, block_code AS "blockCode", name`,
    [organizationId, id, uid ?? null, phone ?? null]
  );
  return rows[0] || null;
}

async function countAdmins(client, organizationId) {
  const { rows } = await client.query(`SELECT COUNT(*)::int AS n FROM admins WHERE organization_id = $1`, [organizationId]);
  return rows[0].n;
}

async function insertAdmin(client, organizationId, admin) {
  await client.query(
    `INSERT INTO admins (id, organization_id, uid, phone, username, password_hash, role, block_code, name)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9) ON CONFLICT (id) DO NOTHING`,
    [admin.id, organizationId, admin.uid, admin.phone, admin.username, admin.passwordHash, admin.role, admin.blockCode, admin.name]
  );
}

async function deleteAdmin(client, organizationId, id) {
  const { rowCount } = await client.query(`DELETE FROM admins WHERE organization_id = $1 AND id = $2`, [organizationId, id]);
  return rowCount > 0;
}

// ---------- cross-table uniqueness (a UID/phone must be unique across BOTH tenants AND admins, WITHIN one organization) ----------

// Excludes moved_out tenants deliberately — their bed's UID is meant to be
// reusable by whoever books it next (see tenants_uid_active_unique index).
async function uidTakenAnywhere(client, organizationId, uid, exclude = {}) {
  const { rows } = await client.query(
    `SELECT 1 FROM tenants WHERE organization_id = $1 AND uid = $2 AND status != 'moved_out' AND ($3::text IS NULL OR id != $3)
     UNION
     SELECT 1 FROM admins WHERE organization_id = $1 AND uid = $2 AND ($4::text IS NULL OR id != $4)`,
    [organizationId, uid, exclude.tenantId || null, exclude.adminId || null]
  );
  return rows.length > 0;
}

// Excludes moved_out tenants for the same reason uidTakenAnywhere does —
// once someone has moved out, their old phone number is free to be reused,
// whether that's the same person rejoining or the admin fixing a mistaken
// add-then-remove. Without this, a phone number was permanently "burned"
// the first time it was ever attached to a tenant, even after that tenant
// was removed — causing "already registered to someone else" errors on
// every future attempt to add that number again.
async function phoneTakenAnywhere(client, organizationId, phone, exclude = {}) {
  const { rows } = await client.query(
    `SELECT 1 FROM tenants WHERE organization_id = $1 AND phone = $2 AND status != 'moved_out' AND ($3::text IS NULL OR id != $3)
     UNION
     SELECT 1 FROM admins WHERE organization_id = $1 AND phone = $2 AND ($4::text IS NULL OR id != $4)`,
    [organizationId, phone, exclude.tenantId || null, exclude.adminId || null]
  );
  return rows.length > 0;
}

// ---------- tenants ----------

function mapTenant(row) {
  if (!row) return null;
  return {
    id: row.id,
    organizationId: row.organization_id,
    uid: row.uid,
    phone: row.phone,
    name: row.name,
    email: row.email,
    notes: row.notes,
    college: row.college,
    hometown: row.hometown,
    parentPhone: row.parent_phone,
    age: row.age,
    gender: row.gender,
    monthlyRent: row.monthly_rent === null ? null : Number(row.monthly_rent),
    advanceAmount: row.advance_amount === null ? null : Number(row.advance_amount),
    status: row.status,           // 'booked' | 'active' | 'moved_out'
    joinDate: row.join_date,
    vacateDate: row.vacate_date,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

// Lazy lifecycle sync — no cron/worker process needed. Every read path that
// matters (tenant lists, occupancy, dues generation) calls this first, so
// statuses are always correct as of "now" without any background job:
//   booked  -> active     once join_date has arrived
//   active  -> moved_out  once vacate_date has passed
// Cheap (two indexed UPDATEs that usually touch zero rows) and safe to call
// as often as needed.
async function syncTenantLifecycle(client, organizationId) {
  await client.query(`UPDATE tenants SET status = 'active' WHERE organization_id = $1 AND status = 'booked' AND join_date <= CURRENT_DATE`, [organizationId]);
  await client.query(`UPDATE tenants SET status = 'moved_out' WHERE organization_id = $1 AND status = 'active' AND vacate_date IS NOT NULL AND vacate_date < CURRENT_DATE`, [organizationId]);
}

// Excludes moved_out tenants — this feeds occupancy/dues/bed-assignment
// logic, which should only ever see who's currently booked or actually
// living there. Former tenants are still fully visible via listTenantsPage
// below (the admin's full tenant registry) and via their own tenant-by-id lookup.
async function listAllTenants(client, organizationId) {
  await syncTenantLifecycle(client, organizationId);
  const { rows } = await client.query(`SELECT * FROM tenants WHERE organization_id = $1 AND status != 'moved_out' ORDER BY uid`, [organizationId]);
  return rows.map(mapTenant);
}

// Scoped fetch — used by Rooms/Dues so we don't pull the whole tenants table
// just to check occupancy or dues for ONE block. Uses the functional index
// on LEFT(uid,1) (see migrate.js) so this stays fast as the table grows.
// Same moved_out exclusion as listAllTenants, for the same reason.
async function listTenantsByBlock(client, organizationId, blockCode) {
  await syncTenantLifecycle(client, organizationId);
  const { rows } = await client.query(
    `SELECT * FROM tenants WHERE organization_id = $1 AND LEFT(uid, 1) = $2 AND status != 'moved_out' ORDER BY uid`,
    [organizationId, String(blockCode)]
  );
  return rows.map(mapTenant);
}

// Paginated + optionally searched + optionally block-filtered tenant list —
// what the admin "All Tenants" screen actually calls now instead of
// fetching every row on every load.
async function listTenantsPage(client, organizationId, { blockCode, search, page = 1, limit = 50, statusFilter = 'active' }) {
  await syncTenantLifecycle(client, organizationId);
  const conditions = ['organization_id = $1'];
  const params = [organizationId];

  // Four buckets, matching the UI's All / Active / Booked / Moved out filter:
  //   'active'    -> only currently-residing tenants (status='active')
  //   'booked'    -> only future move-ins that haven't arrived yet
  //   'moved_out' -> only past tenants
  //   'all'       -> everyone, no filter
  if (statusFilter === 'active') {
    conditions.push(`status = 'active'`);
  } else if (statusFilter === 'booked') {
    conditions.push(`status = 'booked'`);
  } else if (statusFilter === 'moved_out') {
    conditions.push(`status = 'moved_out'`);
  }
  if (blockCode) {
    params.push(String(blockCode));
    conditions.push(`LEFT(uid, 1) = $${params.length}`);
  }
  if (search) {
    params.push(`%${search}%`);
    const idx = params.length;
    conditions.push(`(name ILIKE $${idx} OR uid ILIKE $${idx} OR phone ILIKE $${idx})`);
  }
  const where = `WHERE ${conditions.join(' AND ')}`;

  const countResult = await client.query(`SELECT COUNT(*)::int AS n FROM tenants ${where}`, params);
  const total = countResult.rows[0].n;

  const offset = (page - 1) * limit;
  params.push(limit, offset);
  const { rows } = await client.query(
    `SELECT * FROM tenants ${where} ORDER BY uid LIMIT $${params.length - 1} OFFSET $${params.length}`,
    params
  );

  return { tenants: rows.map(mapTenant), total, page, limit };
}

async function getTenantById(client, organizationId, id) {
  const { rows } = await client.query(`SELECT * FROM tenants WHERE organization_id = $1 AND id = $2`, [organizationId, id]);
  return mapTenant(rows[0]);
}

// Wrapped in a transaction with its initial advance payment so the two
// writes succeed or fail together — never a tenant with no payment record,
// or a payment record with no tenant. The advance is always charged
// immediately (it's what holds the bed/booking); status starts 'booked' if
// joinDate is in the future, otherwise 'active' right away.
//
// Uses the request-scoped `client` directly for this transaction (see the
// note on clearBlockData above for why there's no separate pool.connect()).
async function createTenantWithAdvance(client, organizationId, tenant, advancePeriod, advanceAmount) {
  try {
    await client.query('BEGIN');
    const joinDate = tenant.joinDate || new Date().toISOString().slice(0, 10);
    const status = joinDate > new Date().toISOString().slice(0, 10) ? 'booked' : 'active';
    const { rows } = await pool.timedQuery(client,
      `INSERT INTO tenants (id, organization_id, uid, phone, name, email, notes, college, hometown, parent_phone, age, gender, monthly_rent, advance_amount, status, join_date, vacate_date)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17) RETURNING *`,
      [
        tenant.id, organizationId, tenant.uid, tenant.phone, tenant.name, tenant.email || '', tenant.notes || '',
        tenant.college || '', tenant.hometown || '', tenant.parentPhone || '', tenant.age || null, tenant.gender || '',
        tenant.monthlyRent, tenant.advanceAmount, status, joinDate, tenant.vacateDate || null,
      ]
    );
    await pool.timedQuery(client,
      `INSERT INTO payments (id, organization_id, tenant_id, period, amount, type, status)
       VALUES ($1,$2,$3,$4,$5,'advance','due')
       ON CONFLICT (tenant_id, period, type) DO NOTHING`,
      [`p-${tenant.id}-${advancePeriod}-advance`, organizationId, tenant.id, advancePeriod, advanceAmount]
    );
    await client.query('COMMIT');
    return mapTenant(rows[0]);
  } catch (e) {
    await client.query('ROLLBACK');
    throw e;
  }
}

async function updateTenant(client, organizationId, id, fields) {
  const { rows } = await client.query(
    `UPDATE tenants SET
       uid = COALESCE($3, uid),
       phone = COALESCE($4, phone),
       name = COALESCE($5, name),
       email = COALESCE($6, email),
       notes = COALESCE($7, notes),
       college = COALESCE($8, college),
       hometown = COALESCE($9, hometown),
       parent_phone = COALESCE($10, parent_phone),
       age = COALESCE($11, age),
       gender = COALESCE($12, gender),
       monthly_rent = COALESCE($13, monthly_rent),
       advance_amount = COALESCE($14, advance_amount),
       join_date = COALESCE($15, join_date),
       -- vacate_date uses a sentinel ('' clears it) since COALESCE alone
       -- can't distinguish "leave unchanged" from "clear it" for a nullable field.
       vacate_date = CASE WHEN $16 = '__CLEAR__' THEN NULL ELSE COALESCE($16::date, vacate_date) END,
       updated_at = now()
     WHERE organization_id = $1 AND id = $2 RETURNING *`,
    [
      organizationId, id, fields.uid ?? null, fields.phone ?? null, fields.name ?? null, fields.email, fields.notes,
      fields.college, fields.hometown, fields.parentPhone, fields.age ?? null, fields.gender,
      fields.monthlyRent ?? null, fields.advanceAmount ?? null, fields.joinDate ?? null,
      fields.vacateDate === null ? '__CLEAR__' : (fields.vacateDate ?? null),
    ]
  );
  const updated = mapTenant(rows[0]);
  // A booking's join/vacate date can move after creation (e.g. tenant
  // pushes their move-in back) — re-run the lifecycle check immediately so
  // status doesn't wait for the next unrelated read to catch up.
  if (updated) await syncTenantLifecycle(client, organizationId);
  return updated;
}

async function deleteTenant(client, organizationId, id) {
  const { rowCount } = await client.query(`DELETE FROM tenants WHERE organization_id = $1 AND id = $2`, [organizationId, id]);
  return rowCount > 0;
}

// "Remove tenant" for someone who's actually lived there — unlike
// deleteTenant above (a hard delete, used only for cancelling a booking
// that never happened), this preserves the tenant row and every payment/
// complaint tied to it for Tenant History, while immediately freeing their
// bed: status flips to moved_out and vacate_date is backdated to today if
// it wasn't already set or was in the future.
async function moveOutTenant(client, organizationId, id) {
  const { rows } = await client.query(
    `UPDATE tenants SET
       status = 'moved_out',
       vacate_date = LEAST(COALESCE(vacate_date, CURRENT_DATE), CURRENT_DATE),
       updated_at = now()
     WHERE organization_id = $1 AND id = $2 RETURNING *`,
    [organizationId, id]
  );
  return mapTenant(rows[0]);
}

// Single grouped query instead of fetching every tenant row and counting in JS.
// Returns { '3': 12, '1': 5, ... } for whatever block digits actually have
// tenants — no longer a fixed 1-4 shape, since blocks are dynamic now.
// Excludes moved_out tenants (same convention as listAllTenants and the
// active-tenant count elsewhere) — this is what backs the "Tenants" number
// on the dashboard, so a moved-out tenant staying in that count made the
// dashboard drift from reality every time someone was removed.
async function tenantCountsByBlock(client, organizationId) {
  const { rows } = await client.query(
    `SELECT LEFT(uid, 1) AS block, COUNT(*)::int AS n FROM tenants WHERE organization_id = $1 AND status != 'moved_out' GROUP BY LEFT(uid, 1)`,
    [organizationId]
  );
  const counts = {};
  rows.forEach((r) => { counts[r.block] = r.n; });
  return counts;
}

// ---------- rooms (floors/rooms exist independently of tenants) ----------

function mapRoom(row) {
  if (!row) return null;
  const removedBeds = row.removed_beds || [];
  // The bed numbers actually in use right now, e.g. bedCount=3 with
  // removedBeds=[1] -> activeBedNumbers=[2,3]. Everything that renders or
  // counts beds should use this, not a raw 1..bedCount loop.
  const activeBedNumbers = [];
  for (let n = 1; n <= row.bed_count; n++) if (!removedBeds.includes(n)) activeBedNumbers.push(n);
  return {
    id: row.id,
    blockCode: row.block_code,
    floorNumber: row.floor_number,
    roomNumber: row.room_number,
    bedCount: row.bed_count,
    removedBeds,
    activeBedNumbers,
    activeBedCount: activeBedNumbers.length,
    // Display label matches hotel-style numbering: floor digit + 2-digit room, e.g. floor 1 room 1 -> "101"
    label: `${row.floor_number}${String(row.room_number).padStart(2, '0')}`,
  };
}

async function listRoomsByBlock(client, organizationId, blockCode) {
  const { rows } = await client.query(
    `SELECT * FROM rooms WHERE organization_id = $1 AND block_code = $2 ORDER BY floor_number, room_number`,
    [organizationId, blockCode]
  );
  return rows.map(mapRoom);
}

// Occupancy = total bed capacity vs how many of those beds have a tenant.
// Total capacity comes straight from rooms.bed_count (real infrastructure);
// occupied comes from actually counting tenants — never assume a 1:1 ratio,
// since a room can have more bed slots than it currently has tenants in.
async function getOccupancySummary(client, organizationId, blockCodeFilter) {
  const roomsQuery = blockCodeFilter
    ? await client.query(`SELECT * FROM rooms WHERE organization_id = $1 AND block_code = $2`, [organizationId, String(blockCodeFilter)])
    : await client.query(`SELECT * FROM rooms WHERE organization_id = $1`, [organizationId]);
  const rooms = roomsQuery.rows.map(mapRoom);
  // Use activeBedCount (bedCount minus any individually removed beds), not
  // the raw bedCount column — otherwise a room with a deleted bed would
  // still count its removed slot as an occupiable bed.
  const totalBeds = rooms.reduce((sum, r) => sum + r.activeBedCount, 0);

  const tenants = blockCodeFilter
    ? await listTenantsByBlock(client, organizationId, blockCodeFilter)
    : await listAllTenants(client, organizationId);
  // 'booked' beds are reserved (advance paid, not moved in yet) — neither
  // occupied (nobody's actually there) nor vacant (nobody else can book it).
  const occupiedBeds = tenants.filter((t) => t.status === 'active').length;
  const bookedBeds = tenants.filter((t) => t.status === 'booked').length;

  const vacantBeds = Math.max(0, totalBeds - occupiedBeds - bookedBeds);
  return {
    totalBeds,
    occupiedBeds,
    bookedBeds,
    vacantBeds,
    percentOccupied: totalBeds > 0 ? Math.round((occupiedBeds / totalBeds) * 100) : 0,
    percentBooked: totalBeds > 0 ? Math.round((bookedBeds / totalBeds) * 100) : 0,
    percentVacant: totalBeds > 0 ? Math.round((vacantBeds / totalBeds) * 100) : 0,
  };
}

async function floorExists(client, organizationId, blockCode, floorNumber) {
  const { rows } = await client.query(
    `SELECT 1 FROM rooms WHERE organization_id = $1 AND block_code = $2 AND floor_number = $3 LIMIT 1`,
    [organizationId, blockCode, floorNumber]
  );
  return rows.length > 0;
}

// Creates every room on a floor in ONE bulk insert instead of one INSERT
// per room (was up to 99 sequential round trips for a big floor).
async function createFloorRooms(client, organizationId, blockCode, floorNumber, roomCount) {
  try {
    await client.query('BEGIN');
    const values = [];
    const params = [];
    for (let roomNumber = 1; roomNumber <= roomCount; roomNumber++) {
      const id = `r-${blockCode}${floorNumber}-${Date.now().toString(36)}-${roomNumber}`;
      const base = params.length;
      params.push(id, organizationId, blockCode, floorNumber, roomNumber);
      values.push(`($${base + 1},$${base + 2},$${base + 3},$${base + 4},$${base + 5},1)`);
    }
    const { rows } = await pool.timedQuery(client,
      `INSERT INTO rooms (id, organization_id, block_code, floor_number, room_number, bed_count)
       VALUES ${values.join(',')} RETURNING *`,
      params
    );
    await client.query('COMMIT');
    return rows.map(mapRoom);
  } catch (e) {
    await client.query('ROLLBACK');
    throw e;
  }
}

async function getRoomById(client, organizationId, id) {
  const { rows } = await client.query(`SELECT * FROM rooms WHERE organization_id = $1 AND id = $2`, [organizationId, id]);
  return mapRoom(rows[0]);
}

// Inserts ONE room into an already-existing floor — used by "add room
// above/below" a given room (an explicit room number, not an auto-shifted
// position, because room number is baked into every tenant's UID; we never
// renumber existing rooms to make space, same reasoning as removed_beds).
async function createSingleRoom(client, organizationId, blockCode, floorNumber, roomNumber, bedCount) {
  const id = `r-${blockCode}${floorNumber}-${Date.now().toString(36)}-${roomNumber}`;
  const { rows } = await client.query(
    `INSERT INTO rooms (id, organization_id, block_code, floor_number, room_number, bed_count)
     VALUES ($1,$2,$3,$4,$5,$6) RETURNING *`,
    [id, organizationId, blockCode, floorNumber, roomNumber, bedCount]
  );
  return mapRoom(rows[0]);
}

async function roomNumberExists(client, organizationId, blockCode, floorNumber, roomNumber) {
  const { rows } = await client.query(
    `SELECT 1 FROM rooms WHERE organization_id = $1 AND block_code = $2 AND floor_number = $3 AND room_number = $4`,
    [organizationId, blockCode, floorNumber, roomNumber]
  );
  return rows.length > 0;
}

// Deletes the room slot entirely (not just vacates it). Caller must have
// already confirmed no active/booked tenant currently holds any bed in it —
// this only removes the room row itself.
async function deleteRoomRow(client, organizationId, id) {
  await client.query(`DELETE FROM rooms WHERE organization_id = $1 AND id = $2`, [organizationId, id]);
}

// Adding a bed fills the smallest previously-removed gap first (e.g. bed 1
// was deleted earlier -> the next "add bed" reactivates bed 1, it does NOT
// jump straight to bed 4). Only grows bed_count itself once there are no
// gaps left to fill, and never past 9 (the UID's bed digit is one character).
async function addBedToRoom(client, organizationId, id) {
  const room = await getRoomById(client, organizationId, id);
  if (!room) return null;
  if (room.removedBeds.length > 0) {
    const fillNumber = Math.min(...room.removedBeds);
    const { rows } = await client.query(
      `UPDATE rooms SET removed_beds = array_remove(removed_beds, $3) WHERE organization_id = $1 AND id = $2 RETURNING *`,
      [organizationId, id, fillNumber]
    );
    return mapRoom(rows[0]);
  }
  const { rows } = await client.query(
    `UPDATE rooms SET bed_count = bed_count + 1 WHERE organization_id = $1 AND id = $2 AND bed_count < 9 RETURNING *`,
    [organizationId, id]
  );
  return mapRoom(rows[0]);
}

// Removes ONE SPECIFIC bed number, regardless of its position in the room.
// Caller must have already verified that bed isn't occupied (occupancy is
// derived from tenants, not stored on the room itself). We never renumber
// the tenants in the beds that stay — see the schema.sql comment on
// removed_beds for why. If the removed bed happens to be the current top
// bed, we also trim bed_count downward so the array doesn't quietly grow
// forever with numbers nobody will ever see again.
async function removeBedFromRoom(client, organizationId, id, bedNumber) {
  try {
    await client.query('BEGIN');
    const { rows: current } = await pool.timedQuery(client,
      `SELECT * FROM rooms WHERE organization_id = $1 AND id = $2 FOR UPDATE`, [organizationId, id]);
    if (!current[0]) { await client.query('ROLLBACK'); return null; }
    let bedCount = current[0].bed_count;
    let removedBeds = new Set(current[0].removed_beds || []);
    if (bedCount <= 1) { await client.query('ROLLBACK'); return mapRoom(current[0]); } // guard: never go to 0 active-or-not beds via this path
    removedBeds.add(bedNumber);
    // Trim any now-unused numbers sitting at the very top of the range,
    // e.g. bedCount=3, removedBeds={3} -> collapses to bedCount=2, removedBeds={}.
    while (bedCount > 1 && removedBeds.has(bedCount)) {
      removedBeds.delete(bedCount);
      bedCount -= 1;
    }
    const { rows } = await pool.timedQuery(client,
      `UPDATE rooms SET bed_count = $3, removed_beds = $4 WHERE organization_id = $1 AND id = $2 RETURNING *`,
      [organizationId, id, bedCount, Array.from(removedBeds)]
    );
    await client.query('COMMIT');
    return mapRoom(rows[0]);
  } catch (e) {
    await client.query('ROLLBACK');
    throw e;
  }
}

async function setRoomBedCount(client, organizationId, id, bedCount) {
  const { rows } = await client.query(
    // Growing via this endpoint always grows from a clean state — clears
    // any old gaps rather than leaving stale removed_beds entries above the
    // new count, which could otherwise resurface confusingly on a later shrink.
    `UPDATE rooms SET bed_count = $3, removed_beds = (SELECT array_agg(n) FROM unnest(removed_beds) n WHERE n <= $3) WHERE organization_id = $1 AND id = $2 RETURNING *`,
    [organizationId, id, bedCount]
  );
  const row = rows[0];
  if (row && row.removed_beds === null) row.removed_beds = [];
  return mapRoom(row);
}

async function getRoomByLocation(client, organizationId, blockCode, floorNumber, roomNumber) {
  const { rows } = await client.query(
    `SELECT * FROM rooms WHERE organization_id = $1 AND block_code = $2 AND floor_number = $3 AND room_number = $4`,
    [organizationId, blockCode, floorNumber, roomNumber]
  );
  return mapRoom(rows[0]);
}

// ---------- payments ----------

// Uses the LOCAL calendar month, not UTC — .toISOString() converts to UTC
// first, which silently shifts the month backward for any timezone ahead of
// UTC (e.g. India, UTC+5:30) whenever local midnight falls on the previous
// UTC day. That bug caused monthly period labels to be off by one month.
function currentPeriod() {
  const now = new Date();
  return `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}`;
}

function rentForBedCount(bedCount, config) {
  const tiers = config.rentByBedCount || {};
  const keys = Object.keys(tiers).map(Number).sort((a, b) => a - b);
  if (keys.length === 0) return 0;
  // Use the exact tier if it exists, otherwise the highest tier at or below bedCount,
  // otherwise (bedCount smaller than the lowest defined tier) the lowest tier.
  let chosen = keys[0];
  for (const k of keys) {
    if (k <= bedCount) chosen = k;
  }
  return tiers[chosen];
}

function mapPayment(row) {
  if (!row) return null;
  const amount = Number(row.amount);
  const amountPaid = Number(row.amount_paid || 0);
  return {
    id: row.id,
    tenantId: row.tenant_id,
    period: row.period,
    amount,
    amountPaid,
    remaining: Math.max(0, amount - amountPaid),
    type: row.type,
    status: row.status,
    method: row.method,
    paidAt: row.paid_at,
    createdAt: row.created_at,
  };
}

// Strips anything sensitive before this config is ever sent to a browser —
// used for every GET /api/payments/config response, tenant or admin alike.
// (Nothing sensitive lives in here — this is just the advance/rent defaults
// used when adding a tenant. Where tenants actually PAY is a separate
// concept now: see payment_scanners / getScannerForBlock below. Kept as a
// deliberate allow-list rather than sending the raw config object, so a
// future field added here doesn't leak by default.)
function sanitizePaymentConfig(config) {
  return {
    advanceAmount: config.advanceAmount || 0,
    rentByBedCount: config.rentByBedCount || {},
  };
}

async function getPaymentConfig(client, organizationId) {
  const { rows } = await client.query(`SELECT value FROM settings WHERE organization_id = $1 AND key = 'paymentConfig'`, [organizationId]);
  return rows[0] ? rows[0].value : {
    advanceAmount: 0, rentByBedCount: {},
  };
}

async function setPaymentConfig(client, organizationId, config) {
  await client.query(
    `INSERT INTO settings (organization_id, key, value) VALUES ($1, 'paymentConfig', $2)
     ON CONFLICT (organization_id, key) DO UPDATE SET value = $2`,
    [organizationId, JSON.stringify(config)]
  );
}

// ---------- hostel info page (a free-form, block-based document — food timetable,
// rules, do's/don'ts, address, owner/sub-owner contacts, etc.) ----------
// Stored as one JSON array of blocks under settings.key='infoPage', same
// table/pattern as paymentConfig above. Order in the array IS the document
// order — no separate position/sort column needed since Super Admin always
// rewrites the whole array on save (see setInfoPage).
async function getInfoPage(client, organizationId) {
  const { rows } = await client.query(`SELECT value FROM settings WHERE organization_id = $1 AND key = 'infoPage'`, [organizationId]);
  return rows[0] ? rows[0].value : { blocks: [] };
}

async function setInfoPage(client, organizationId, blocks) {
  await client.query(
    `INSERT INTO settings (organization_id, key, value) VALUES ($1, 'infoPage', $2)
     ON CONFLICT (organization_id, key) DO UPDATE SET value = $2`,
    [organizationId, JSON.stringify({ blocks })]
  );
}

async function createPayment(client, organizationId, tenantId, period, amount, type, status = 'due') {
  const { rows } = await client.query(
    `INSERT INTO payments (id, organization_id, tenant_id, period, amount, type, status)
     VALUES ($1,$2,$3,$4,$5,$6,$7)
     ON CONFLICT (tenant_id, period, type) DO NOTHING
     RETURNING *`,
    [`p-${tenantId}-${period}-${type}`, organizationId, tenantId, period, amount, type, status]
  );
  return mapPayment(rows[0]);
}

// Type-aware: a tenant can have BOTH an 'advance' row and a 'rent' row for
// the same period, so this must ask for a specific type, not just "whatever
// payment exists for this tenant this month" (there can be two).
async function getPaymentByTenantPeriod(client, organizationId, tenantId, period, type) {
  const { rows } = await client.query(
    `SELECT * FROM payments WHERE organization_id = $1 AND tenant_id = $2 AND period = $3 AND type = $4`,
    [organizationId, tenantId, period, type]
  );
  return mapPayment(rows[0]);
}

// Called whenever a tenant's dashboard (or an admin's dues view) loads.
// If we're past the 5th of the month and this tenant has no RENT payment row
// yet for the current period, create one as 'due' using THEIR OWN
// monthly_rent (set explicitly by the admin who added them). Specifically
// checks for a 'rent' row — an 'advance' row in the same period (e.g. their
// move-in month) must never block this from being created.
async function ensureCurrentDue(client, organizationId, tenant) {
  const period = currentPeriod();
  const existing = await getPaymentByTenantPeriod(client, organizationId, tenant.id, period, 'rent');
  if (existing) return existing;

  const dayOfMonth = new Date().getDate();
  if (dayOfMonth < 6) return null; // no reminder before day 6

  const amount = tenant.monthlyRent || 0;
  return createPayment(client, organizationId, tenant.id, period, amount, 'rent', 'due');
}

async function listPaymentsForTenant(client, organizationId, tenantId) {
  const { rows } = await client.query(
    `SELECT * FROM payments WHERE organization_id = $1 AND tenant_id = $2 ORDER BY period DESC`, [organizationId, tenantId]);
  return rows.map(mapPayment);
}

// Every payment this tenant currently owes anything on — advance AND rent
// alike, not just the current month's rent. This is what the tenant
// dashboard actually shows as payable: a brand-new tenant's very first
// payment is their ADVANCE, which ensureCurrentDue above never surfaces
// (it only ever looks at 'rent' rows for the current period) — without
// this, a new tenant would have literally no way to pay their advance
// through the app. Ordered oldest-period-first, so the advance (almost
// always their earliest period) leads.
async function listUnpaidPaymentsForTenant(client, organizationId, tenantId) {
  const { rows } = await client.query(
    `SELECT * FROM payments WHERE organization_id = $1 AND tenant_id = $2 AND status IN ('due', 'partial') ORDER BY period ASC`,
    [organizationId, tenantId]
  );
  return rows.map(mapPayment);
}

async function getPaymentById(client, organizationId, id) {
  const { rows } = await client.query(`SELECT * FROM payments WHERE organization_id = $1 AND id = $2`, [organizationId, id]);
  return mapPayment(rows[0]);
}

async function markPaymentPaid(client, organizationId, id, method) {
  const { rows } = await client.query(
    `UPDATE payments SET status = 'paid', amount_paid = amount, method = $3, paid_at = now() WHERE organization_id = $1 AND id = $2 RETURNING *`,
    [organizationId, id, method]
  );
  return mapPayment(rows[0]);
}

// Records a cash/offline payment — can be partial or full. Adds to
// whatever's already been paid (so multiple partial cash payments over time
// accumulate correctly), and only flips status to 'paid' once the running
// total reaches or exceeds the amount due. Rejects overpayment amounts.
async function recordCashPayment(client, organizationId, id, amountReceived, method = 'cash') {
  const payment = await getPaymentById(client, organizationId, id);
  if (!payment) return null;
  if (payment.status === 'paid') {
    const err = new Error('This payment is already fully paid');
    err.status = 409;
    throw err;
  }
  if (amountReceived <= 0) {
    const err = new Error('Amount received must be greater than 0');
    err.status = 400;
    throw err;
  }
  if (amountReceived > payment.remaining + 0.001) { // small epsilon for float safety
    const err = new Error(`That's more than the remaining balance of ₹${payment.remaining}`);
    err.status = 400;
    throw err;
  }

  const newAmountPaid = payment.amountPaid + amountReceived;
  const newStatus = newAmountPaid >= payment.amount ? 'paid' : 'partial';
  const { rows } = await client.query(
    `UPDATE payments SET
       amount_paid = $3,
       status = $4,
       method = $5,
       paid_at = CASE WHEN $4 = 'paid' THEN now() ELSE paid_at END
     WHERE organization_id = $1 AND id = $2 RETURNING *`,
    [organizationId, id, newAmountPaid, newStatus, method]
  );
  return mapPayment(rows[0]);
}

// ---------- manual payment confirmation: scanners ----------

function mapScanner(row) {
  if (!row) return null;
  return {
    id: row.id,
    scopeBlock: row.scope_block, // null = whole hostel
    accountName: row.account_name,
    accountDetails: row.account_details,
    qrImage: row.qr_image,
    contactPhone: row.contact_phone,
    createdAt: row.created_at,
  };
}

// ---------- Push notification subscriptions ----------
// One browser/device can have several subscriptions across a lifetime
// (reinstalling, clearing site data), so this upserts on the endpoint —
// re-subscribing the same device just refreshes its row rather than
// creating duplicates.
async function savePushSubscription(client, organizationId, { userType, userId, blockCode, endpoint, p256dh, auth }) {
  const id = `push-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
  await client.query(
    `INSERT INTO push_subscriptions (id, organization_id, user_type, user_id, block_code, endpoint, p256dh, auth)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8)
     ON CONFLICT (organization_id, endpoint) DO UPDATE SET user_type = $3, user_id = $4, block_code = $5, p256dh = $7, auth = $8`,
    [id, organizationId, userType, userId, blockCode || null, endpoint, p256dh, auth]
  );
}

async function removePushSubscription(client, organizationId, endpoint) {
  await client.query(`DELETE FROM push_subscriptions WHERE organization_id = $1 AND endpoint = $2`, [organizationId, endpoint]);
}

async function getPushSubscriptionsForUser(client, organizationId, userType, userId) {
  const { rows } = await client.query(
    `SELECT endpoint, p256dh, auth FROM push_subscriptions WHERE organization_id = $1 AND user_type = $2 AND user_id = $3`,
    [organizationId, userType, userId]
  );
  return rows;
}

// Super Admins (block_code IS NULL) always included, plus whichever
// sub-admin is assigned to this specific block — matches "who normally
// manages this block", not the finer-grained payment-confirmation grant.
async function getPushSubscriptionsForAdmins(client, organizationId, blockCode) {
  const { rows } = await client.query(
    `SELECT endpoint, p256dh, auth FROM push_subscriptions
     WHERE organization_id = $1 AND user_type = 'admin' AND (block_code IS NULL OR block_code = $2)`,
    [organizationId, String(blockCode)]
  );
  return rows;
}

// For a posted message/announcement — audience depends on adminOnly +
// scopeBlock the same way the message's own visibility does. Tenants have
// no block_code column of their own (only admins do), so a block-scoped
// broadcast to tenants matches on the tenant's UID prefix instead.
async function getPushSubscriptionsForMessage(client, organizationId, { adminOnly, scopeBlock }) {
  if (adminOnly) {
    if (scopeBlock) return getPushSubscriptionsForAdmins(client, organizationId, scopeBlock);
    const { rows } = await client.query(
      `SELECT endpoint, p256dh, auth FROM push_subscriptions WHERE organization_id = $1 AND user_type = 'admin'`,
      [organizationId]
    );
    return rows;
  }
  if (scopeBlock) {
    const { rows } = await client.query(
      `SELECT ps.endpoint, ps.p256dh, ps.auth FROM push_subscriptions ps
       JOIN tenants t ON t.id = ps.user_id
       WHERE ps.organization_id = $1 AND ps.user_type = 'tenant' AND LEFT(t.uid, 1) = $2`,
      [organizationId, String(scopeBlock)]
    );
    return rows;
  }
  const { rows } = await client.query(
    `SELECT endpoint, p256dh, auth FROM push_subscriptions WHERE organization_id = $1 AND user_type = 'tenant'`,
    [organizationId]
  );
  return rows;
}

async function listScanners(client, organizationId) {
  const { rows } = await client.query(
    `SELECT * FROM payment_scanners WHERE organization_id = $1 ORDER BY scope_block NULLS FIRST`,
    [organizationId]
  );
  return rows.map(mapScanner);
}

// A tenant's applicable scanner: their own block's, if one is set,
// otherwise the whole-hostel one. Returns null if neither exists yet.
// The subquery + explicit priority column is deliberate — a bare
// `UNION ALL ... LIMIT 1` does NOT guarantee which branch's row comes back
// first (Postgres is free to reorder a plain UNION ALL), so without this,
// "prefer the block-specific scanner" would be unreliable rather than wrong
// every time — the worst kind of bug to have shipped.
async function getScannerForBlock(client, organizationId, blockCode) {
  const { rows } = await client.query(
    `SELECT * FROM (
       SELECT *, 0 AS priority FROM payment_scanners WHERE organization_id = $1 AND scope_block = $2
       UNION ALL
       SELECT *, 1 AS priority FROM payment_scanners WHERE organization_id = $1 AND scope_block IS NULL
     ) sub
     ORDER BY priority ASC
     LIMIT 1`,
    [organizationId, String(blockCode)]
  );
  return mapScanner(rows[0]);
}

async function createScanner(client, organizationId, { id, scopeBlock, accountName, accountDetails, qrImage, contactPhone }) {
  const { rows } = await client.query(
    `INSERT INTO payment_scanners (id, organization_id, scope_block, account_name, account_details, qr_image, contact_phone)
     VALUES ($1,$2,$3,$4,$5,$6,$7) RETURNING *`,
    [id, organizationId, scopeBlock || null, accountName, accountDetails || '', qrImage || '', contactPhone || '']
  );
  return mapScanner(rows[0]);
}

async function updateScanner(client, organizationId, id, { accountName, accountDetails, qrImage, contactPhone }) {
  const { rows } = await client.query(
    `UPDATE payment_scanners SET
       account_name = COALESCE($3, account_name),
       account_details = COALESCE($4, account_details),
       qr_image = COALESCE($5, qr_image),
       contact_phone = COALESCE($6, contact_phone)
     WHERE organization_id = $1 AND id = $2 RETURNING *`,
    [organizationId, id, accountName ?? null, accountDetails ?? null, qrImage ?? null, contactPhone ?? null]
  );
  return mapScanner(rows[0]);
}

async function deleteScanner(client, organizationId, id) {
  const { rowCount } = await client.query(`DELETE FROM payment_scanners WHERE organization_id = $1 AND id = $2`, [organizationId, id]);
  return rowCount > 0;
}

// ---------- manual payment confirmation: proof submissions ----------

function mapProof(row) {
  if (!row) return null;
  return {
    id: row.id,
    paymentId: row.payment_id,
    tenantId: row.tenant_id,
    screenshot: row.screenshot,
    utrReference: row.utr_reference,
    paidDate: row.paid_date,
    claimedAmount: Number(row.claimed_amount),
    status: row.status,
    adminNote: row.admin_note,
    submittedAt: row.submitted_at,
    reviewedAt: row.reviewed_at,
    reviewedBy: row.reviewed_by,
    // present only when this came from the admin-facing joined query below
    tenantName: row.tenant_name,
    tenantUid: row.tenant_uid,
    tenantPhone: row.tenant_phone,
    period: row.period,
    paymentType: row.payment_type,
    dueAmount: row.due_amount != null ? Number(row.due_amount) : undefined,
  };
}

async function hasPendingProofForPayment(client, organizationId, paymentId) {
  const { rows } = await client.query(
    `SELECT 1 FROM payment_proofs WHERE organization_id = $1 AND payment_id = $2 AND status = 'pending'`,
    [organizationId, paymentId]
  );
  return rows.length > 0;
}

async function createPaymentProof(client, organizationId, { id, paymentId, tenantId, screenshot, utrReference, paidDate, claimedAmount }) {
  const { rows } = await client.query(
    `INSERT INTO payment_proofs (id, organization_id, payment_id, tenant_id, screenshot, utr_reference, paid_date, claimed_amount)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8) RETURNING *`,
    [id, organizationId, paymentId, tenantId, screenshot, utrReference || '', paidDate || null, claimedAmount]
  );
  return mapProof(rows[0]);
}

// A tenant's own submissions, most recent first — used to show "pending
// review" / "approved" / "rejected" status and to drive polling for a live
// update the moment an admin confirms it, without the tenant refreshing.
async function listProofsForTenant(client, organizationId, tenantId) {
  const { rows } = await client.query(
    `SELECT p.*, pay.period, pay.type AS payment_type FROM payment_proofs p JOIN payments pay ON pay.id = p.payment_id
     WHERE p.organization_id = $1 AND p.tenant_id = $2 ORDER BY p.submitted_at DESC`,
    [organizationId, tenantId]
  );
  return rows.map(mapProof);
}

// blockCodeFilter: null/'*' = every pending proof (Super Admin, or a sub-admin
// granted all-blocks confirmation access); a single code string = one block;
// an array of codes = a sub-admin granted access to specific blocks.
async function listPendingProofsForAdmin(client, organizationId, blockCodeFilter) {
  const params = [organizationId];
  let where = `WHERE p.organization_id = $1 AND p.status = 'pending'`;
  if (Array.isArray(blockCodeFilter)) {
    if (blockCodeFilter.length === 0) {
      where += ` AND false`; // granted access to zero blocks — show nothing
    } else {
      params.push(blockCodeFilter.map(String));
      where += ` AND LEFT(t.uid, 1) = ANY($${params.length}::text[])`;
    }
  } else if (blockCodeFilter && blockCodeFilter !== '*') {
    params.push(String(blockCodeFilter));
    where += ` AND LEFT(t.uid, 1) = $${params.length}`;
  }
  const { rows } = await client.query(
    `SELECT p.*, t.name AS tenant_name, t.uid AS tenant_uid, t.phone AS tenant_phone, pay.period, pay.type AS payment_type, pay.amount AS due_amount
     FROM payment_proofs p
     JOIN tenants t ON t.id = p.tenant_id
     JOIN payments pay ON pay.id = p.payment_id
     ${where}
     ORDER BY p.submitted_at ASC`,
    params
  );
  return rows.map(mapProof);
}

async function getProofById(client, organizationId, id) {
  const { rows } = await client.query(
    `SELECT p.*, t.name AS tenant_name, t.uid AS tenant_uid, t.phone AS tenant_phone, pay.period, pay.type AS payment_type, pay.amount AS due_amount
     FROM payment_proofs p
     JOIN tenants t ON t.id = p.tenant_id
     JOIN payments pay ON pay.id = p.payment_id
     WHERE p.organization_id = $1 AND p.id = $2`,
    [organizationId, id]
  );
  return mapProof(rows[0]);
}

// Approving is what actually marks the underlying payment paid — reuses
// recordCashPayment's accumulate-and-cap-at-remaining logic (see above) so
// an approved amount that's less than the full due correctly leaves the
// payment 'partial' rather than incorrectly closing it out. finalAmount is
// whatever the admin confirms (defaults to what the tenant claimed, but the
// admin can edit it first — e.g. the screenshot shows a slightly different
// amount than what was typed).
// Approving also clears the stored screenshot (sets it to NULL) in the same
// UPDATE — once an admin has downloaded a copy to their own device (the
// frontend triggers that download before calling this), keeping the
// base64 image sitting in the database forever serves no purpose and is
// exactly the kind of thing that quietly fills up a database's storage
// over hundreds/thousands of tenants. The payment record itself (amount,
// UTR reference, dates, who approved it) is kept permanently — only the
// image bytes are dropped. Rejected proofs are NOT cleared here, since a
// rejected submission may still need review if the tenant disputes it.
async function approveProof(client, organizationId, id, finalAmount, reviewerName) {
  const proof = await getProofById(client, organizationId, id);
  if (!proof) return null;
  const payment = await recordCashPayment(client, organizationId, proof.paymentId, finalAmount, 'upi_manual');
  const { rows } = await client.query(
    `UPDATE payment_proofs SET status = 'approved', claimed_amount = $3, reviewed_at = now(), reviewed_by = $4, screenshot = NULL
     WHERE organization_id = $1 AND id = $2 RETURNING *`,
    [organizationId, id, finalAmount, reviewerName]
  );
  return { proof: mapProof(rows[0]), payment };
}

async function rejectProof(client, organizationId, id, reviewerName, note) {
  const { rows } = await client.query(
    `UPDATE payment_proofs SET status = 'rejected', admin_note = $3, reviewed_at = now(), reviewed_by = $4
     WHERE organization_id = $1 AND id = $2 RETURNING *`,
    [organizationId, id, note || '', reviewerName]
  );
  return mapProof(rows[0]);
}

// If `period` is the tenant's very first rent month (i.e. matches the
// calendar month of their join_date) and they didn't join on the 1st, rent
// for that month is prorated by the days actually lived there — a tenant
// joining on the 20th of a 30-day month owes 11/30 of the full rent, not
// the whole month. Every period AFTER their join month is charged in full.
function proratedFirstMonthRent(tenant, period) {
  const full = Number(tenant.monthlyRent);
  const joinDate = new Date(tenant.joinDate);
  const joinPeriod = `${joinDate.getUTCFullYear()}-${String(joinDate.getUTCMonth() + 1).padStart(2, '0')}`;
  if (joinPeriod !== period) return full; // not their join month — full rent as normal

  const joinDay = joinDate.getUTCDate();
  if (joinDay <= 1) return full; // joined on the 1st — no proration needed

  const daysInMonth = new Date(Date.UTC(joinDate.getUTCFullYear(), joinDate.getUTCMonth() + 1, 0)).getUTCDate();
  const daysLived = daysInMonth - joinDay + 1; // join day itself counts as a day there
  return Math.round((full * daysLived) / daysInMonth);
}

// Makes sure every tenant in scope has an up-to-date due row for the current
// period (if we're past day 5), then returns the aggregated view an admin sees.
// This used to loop and `await` one query PER TENANT (classic N+1) — now it's
// two batched queries total, regardless of how many tenants are in scope.
async function getDuesOverview(client, organizationId, blockCodeFilter) {
  const scoped = blockCodeFilter
    ? await listTenantsByBlock(client, organizationId, blockCodeFilter)
    : await listAllTenants(client, organizationId);

  if (scoped.length === 0) {
    return { dueList: [], totalDue: 0, totalCollected: 0, dueCount: 0, percentCollected: 0, percentDue: 0 };
  }

  const tenantIds = scoped.map((t) => t.id);
  const period = currentPeriod();
  const dayOfMonth = new Date().getDate();

  if (dayOfMonth >= 6) {
    // One query: which of these tenants already have a RENT row for this
    // period? (Must filter by type='rent' — an 'advance' row in the same
    // period, e.g. their move-in month, must never count as "already has
    // their rent covered".)
    const { rows: existing } = await client.query(
      `SELECT tenant_id FROM payments WHERE organization_id = $1 AND tenant_id = ANY($2::text[]) AND period = $3 AND type = 'rent'`,
      [organizationId, tenantIds, period]
    );
    const alreadyHave = new Set(existing.map((r) => r.tenant_id));
    // 'booked' tenants (future join date, haven't moved in) never get a rent
    // due — only their advance holds the booking until move-in day arrives.
    const needsRow = scoped.filter((t) => !alreadyHave.has(t.id) && t.monthlyRent && t.status === 'active');

    if (needsRow.length > 0) {
      // One bulk insert for everyone who's missing a row, instead of one INSERT per tenant.
      const values = [];
      const params = [];
      needsRow.forEach((t, i) => {
        const base = i * 6;
        const amount = proratedFirstMonthRent(t, period);
        params.push(`p-${t.id}-${period}-rent`, organizationId, t.id, period, amount, 'rent');
        values.push(`($${base + 1},$${base + 2},$${base + 3},$${base + 4},$${base + 5},$${base + 6},'due')`);
      });
      await client.query(
        `INSERT INTO payments (id, organization_id, tenant_id, period, amount, type, status)
         VALUES ${values.join(',')}
         ON CONFLICT (tenant_id, period, type) DO NOTHING`,
        params
      );
    }
  }

  const { rows } = await client.query(
    `SELECT p.*, t.name AS tenant_name, t.uid AS tenant_uid, t.phone AS tenant_phone
     FROM payments p JOIN tenants t ON t.id = p.tenant_id
     WHERE p.organization_id = $1 AND p.tenant_id = ANY($2::text[])
     ORDER BY p.period DESC`,
    [organizationId, tenantIds]
  );

  const due = rows.filter((r) => r.status === 'due' || r.status === 'partial');
  const totalDue = due.reduce((sum, r) => sum + (Number(r.amount) - Number(r.amount_paid || 0)), 0);
  const totalCollected = rows.reduce((sum, r) => sum + Number(r.amount_paid || 0), 0);
  const totalOfBoth = totalDue + totalCollected;

  // This period's collections, split by type — advance (from tenants who
  // moved in/booked this month) vs. recurring rent, plus a combined grand
  // total. Deliberately scoped to THIS period only, unlike totalCollected
  // above which is all-time — this answers "how much came in this month,
  // and from which source" rather than "how much have we ever collected".
  const thisMonthRows = rows.filter((r) => r.period === period);
  const collectedThisMonth = {
    advance: thisMonthRows.filter((r) => r.type === 'advance').reduce((sum, r) => sum + Number(r.amount_paid || 0), 0),
    rent: thisMonthRows.filter((r) => r.type === 'rent').reduce((sum, r) => sum + Number(r.amount_paid || 0), 0),
  };
  collectedThisMonth.total = collectedThisMonth.advance + collectedThisMonth.rent;

  return {
    dueList: due.map((r) => ({
      ...mapPayment(r),
      tenantName: r.tenant_name,
      tenantUid: r.tenant_uid,
      tenantPhone: r.tenant_phone,
    })),
    totalDue,
    totalCollected,
    collectedThisMonth,
    dueCount: due.length,
    percentCollected: totalOfBoth > 0 ? Math.round((totalCollected / totalOfBoth) * 100) : 0,
    percentDue: totalOfBoth > 0 ? Math.round((totalDue / totalOfBoth) * 100) : 0,
  };
}

// Full payment history for one tenant, for an admin viewing their profile
// (permission/block-scoping is checked in the route, not here).
async function listPaymentsForTenantAdmin(client, organizationId, tenantId) {
  return listPaymentsForTenant(client, organizationId, tenantId);
}

// Monthly RENT collection trend (deliberately excludes the one-time advance —
// that's a move-in cost, not a recurring pattern worth graphing). Returns
// the last `months` calendar months in order, oldest first, with zeros
// filled in for months with no rent activity yet, so the chart's x-axis is
// always a clean, consistent run of months rather than only months that
// happen to have data.
async function getMonthlyRentSummary(client, organizationId, blockCodeFilter, months = 6) {
  const scopedTenantIds = blockCodeFilter
    ? (await listTenantsByBlock(client, organizationId, blockCodeFilter)).map((t) => t.id)
    : (await listAllTenants(client, organizationId)).map((t) => t.id);

  // Build the list of the last N periods, e.g. ['2026-03', ..., '2026-08']
  const periods = [];
  const now = new Date();
  for (let i = months - 1; i >= 0; i--) {
    const d = new Date(now.getFullYear(), now.getMonth() - i, 1);
    // Local year/month directly — NOT .toISOString() (see currentPeriod() above for why).
    periods.push(`${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`);
  }

  if (scopedTenantIds.length === 0) {
    return periods.map((period) => ({ period, due: 0, collected: 0 }));
  }

  const { rows } = await client.query(
    `SELECT period, SUM(amount)::numeric AS due_total, SUM(amount_paid)::numeric AS collected_total
     FROM payments
     WHERE organization_id = $1 AND type = 'rent' AND tenant_id = ANY($2::text[]) AND period = ANY($3::text[])
     GROUP BY period`,
    [organizationId, scopedTenantIds, periods]
  );
  const byPeriod = new Map(rows.map((r) => [r.period, r]));

  return periods.map((period) => {
    const row = byPeriod.get(period);
    return {
      period,
      due: row ? Number(row.due_total) : 0,
      collected: row ? Number(row.collected_total) : 0,
    };
  });
}

// ---------- complaints ----------

function mapComplaint(row) {
  if (!row) return null;
  return {
    id: row.id,
    tenantId: row.tenant_id,
    message: row.message,
    status: row.status,
    createdAt: row.created_at,
    resolvedAt: row.resolved_at,
    tenantName: row.tenant_name,
    tenantUid: row.tenant_uid,
    tenantPhone: row.tenant_phone,
  };
}

async function createComplaint(client, organizationId, tenantId, message) {
  const id = `c-${tenantId}-${Date.now().toString(36)}`;
  const { rows } = await client.query(
    `INSERT INTO complaints (id, organization_id, tenant_id, message) VALUES ($1,$2,$3,$4) RETURNING *`,
    [id, organizationId, tenantId, message]
  );
  return mapComplaint(rows[0]);
}

async function listComplaintsForTenant(client, organizationId, tenantId) {
  const { rows } = await client.query(
    `SELECT * FROM complaints WHERE organization_id = $1 AND tenant_id = $2 ORDER BY created_at DESC`, [organizationId, tenantId]);
  return rows.map(mapComplaint);
}

// blockCodeFilter null = every complaint (Super Admin); otherwise scoped to that block (sub-admin)
async function listComplaintsForAdmin(client, organizationId, blockCodeFilter, { page = 1, limit = 100 } = {}) {
  const params = [organizationId];
  let where = `WHERE c.organization_id = $1`;
  if (blockCodeFilter) {
    params.push(String(blockCodeFilter));
    where += ` AND LEFT(t.uid, 1) = $${params.length}`;
  }

  const countResult = await client.query(
    `SELECT COUNT(*)::int AS n FROM complaints c JOIN tenants t ON t.id = c.tenant_id ${where}`,
    params
  );
  const total = countResult.rows[0].n;

  const offset = (page - 1) * limit;
  params.push(limit, offset);
  const { rows } = await client.query(
    `SELECT c.*, t.name AS tenant_name, t.uid AS tenant_uid, t.phone AS tenant_phone
     FROM complaints c JOIN tenants t ON t.id = c.tenant_id
     ${where}
     ORDER BY c.created_at DESC
     LIMIT $${params.length - 1} OFFSET $${params.length}`,
    params
  );
  return { complaints: rows.map(mapComplaint), total, page, limit };
}

async function getComplaintById(client, organizationId, id) {
  const { rows } = await client.query(
    `SELECT c.*, t.name AS tenant_name, t.uid AS tenant_uid, t.phone AS tenant_phone
     FROM complaints c JOIN tenants t ON t.id = c.tenant_id
     WHERE c.organization_id = $1 AND c.id = $2`,
    [organizationId, id]
  );
  return mapComplaint(rows[0]);
}

async function resolveComplaint(client, organizationId, id) {
  const { rows } = await client.query(
    `UPDATE complaints SET status = 'resolved', resolved_at = now() WHERE organization_id = $1 AND id = $2 RETURNING *`,
    [organizationId, id]
  );
  return mapComplaint(rows[0]);
}

// ---------- audit log ----------

async function logAction(client, organizationId, byName, action, details) {
  await client.query(`INSERT INTO audit_log (organization_id, by_name, action, details) VALUES ($1,$2,$3,$4)`, [organizationId, byName, action, details]);
}

async function recentAuditLog(client, organizationId, limit = 10) {
  const { rows } = await client.query(
    `SELECT ts, by_name AS by, action, details FROM audit_log WHERE organization_id = $1 ORDER BY ts DESC LIMIT $2`,
    [organizationId, limit]
  );
  return rows;
}

// Escalating in-app reminder tone based on how many days into the month it
// is: gentle on day 1, firmer from day 5, then a warning every 2 days from
// day 7 onward. Pure function — used by both tenant and admin dashboards to
// decide banner styling/wording, no external messaging involved.
function reminderTone(dayOfMonth) {
  if (dayOfMonth < 1) return null;
  if (dayOfMonth === 1) return { level: 'notice', label: 'New month — rent is due' };
  if (dayOfMonth < 5) return { level: 'notice', label: 'Rent due this month' };
  if (dayOfMonth < 7) return { level: 'reminder', label: 'Reminder: rent is overdue' };
  // day 7 onward: warning, escalating every 2 days (7, 9, 11, 13...)
  const overdueBy = dayOfMonth - 5;
  return { level: 'warning', label: `Warning: rent is ${overdueBy} days overdue` };
}

// ===================== Messages / announcements board =====================

function mapMessage(row) {
  if (!row) return null;
  return {
    id: row.id,
    senderId: row.sender_id,
    senderName: row.sender_name,
    senderRole: row.sender_role,
    scopeBlock: row.scope_block,       // null = whole hostel
    adminOnly: row.admin_only,         // true = never shown to tenants ("Admin team" channel)
    type: row.type,                    // 'text' | 'image' | 'poll' | 'contact'
    body: row.body || '',
    imageData: row.image_data || null,
    pollQuestion: row.poll_question || null,
    pollOptions: row.poll_options || null,
    contactName: row.contact_name || null,
    contactPhone: row.contact_phone || null,
    editedAt: row.edited_at || null,
    createdAt: row.created_at,
  };
}

async function createMessage(client, organizationId, msg) {
  // Defensive de-duplication: if this exact sender posted the exact same
  // content in the last 5 seconds, treat it as a repeat network/double-click
  // rather than a genuinely new message, and just return the existing one.
  // This protects against any client-side double-submission bug (present or
  // future) actually reaching the database, without needing every caller to
  // generate and track its own idempotency key.
  const { rows: recent } = await client.query(
    `SELECT * FROM messages
     WHERE organization_id = $1 AND sender_id = $2 AND type = $3 AND created_at > now() - interval '5 seconds'
       AND body IS NOT DISTINCT FROM $4
       AND poll_question IS NOT DISTINCT FROM $5
       AND image_data IS NOT DISTINCT FROM $6
       AND contact_phone IS NOT DISTINCT FROM $7
     ORDER BY created_at DESC LIMIT 1`,
    [organizationId, msg.senderId, msg.type, msg.body || '', msg.pollQuestion || null, msg.imageData || null, msg.contactPhone || null]
  );
  if (recent[0]) return mapMessage(recent[0]);

  const { rows } = await client.query(
    `INSERT INTO messages (id, organization_id, sender_id, sender_name, sender_role, scope_block, admin_only, type, body, image_data, poll_question, poll_options, contact_name, contact_phone)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14) RETURNING *`,
    [
      msg.id, organizationId, msg.senderId, msg.senderName, msg.senderRole, msg.scopeBlock || null, !!msg.adminOnly, msg.type,
      msg.body || '', msg.imageData || null, msg.pollQuestion || null,
      msg.pollOptions ? JSON.stringify(msg.pollOptions) : null, msg.contactName || null, msg.contactPhone || null,
    ]
  );
  return mapMessage(rows[0]);
}

// scopeBlock = the viewer's own block (null for Super Admin, who sees
// everything). isAdmin = tenants must NEVER see admin_only messages, no
// matter what. channel supports the chat-list-style filter tabs:
//   'all'    -> everything the viewer can see (default)
//   'admins' -> ONLY admin_only messages (the private "Admin team" channel) — admins only
//   '<code>' -> only that specific block's messages + global ones (the per-block tab)
async function listMessagesForScope(client, organizationId, scopeBlock, { after, limit = 50, viewerKey = null, isAdmin = false, channel = 'all' } = {}) {
  const conditions = ['organization_id = $1'];
  const params = [organizationId];

  if (channel === 'admins') {
    if (!isAdmin) { conditions.push('false'); } // tenants can never reach this channel — return nothing rather than erroring
    else conditions.push('admin_only = true');
  } else {
    if (!isAdmin) conditions.push('admin_only = false');
    if (channel && channel !== 'all') {
      params.push(String(channel));
      conditions.push(`(scope_block IS NULL OR scope_block = $${params.length})`);
    } else if (scopeBlock !== null && scopeBlock !== undefined) {
      params.push(String(scopeBlock));
      conditions.push(`(scope_block IS NULL OR scope_block = $${params.length})`);
    }
  }
  if (after) {
    params.push(after);
    conditions.push(`created_at > $${params.length}`);
  }
  const where = `WHERE ${conditions.join(' AND ')}`;
  params.push(limit);
  const { rows } = await client.query(
    `SELECT * FROM messages ${where} ORDER BY created_at DESC LIMIT $${params.length}`,
    params
  );
  const messages = rows.map(mapMessage).reverse(); // oldest-first for a natural chat feed

  // Attach vote tallies + "did I vote / for what" for every poll in this batch —
  // one extra query total, not one per poll.
  const pollIds = messages.filter((m) => m.type === 'poll').map((m) => m.id);
  if (pollIds.length > 0) {
    const { rows: voteRows } = await client.query(
      `SELECT message_id, option_index, voter_key, voter_name FROM message_votes WHERE organization_id = $1 AND message_id = ANY($2::text[])`,
      [organizationId, pollIds]
    );
    const votesByMessage = new Map();
    voteRows.forEach((v) => {
      if (!votesByMessage.has(v.message_id)) votesByMessage.set(v.message_id, []);
      votesByMessage.get(v.message_id).push(v);
    });
    messages.forEach((m) => {
      if (m.type !== 'poll') return;
      const votes = votesByMessage.get(m.id) || [];
      const tally = (m.pollOptions || []).map((_, i) => votes.filter((v) => v.option_index === i).length);
      m.pollTally = tally;
      m.pollTotalVotes = votes.length;
      const mine = viewerKey ? votes.find((v) => v.voter_key === viewerKey) : null;
      m.myVote = mine ? mine.option_index : null;
    });
  }
  return messages;
}

async function getMessageById(client, organizationId, id) {
  const { rows } = await client.query(`SELECT * FROM messages WHERE organization_id = $1 AND id = $2`, [organizationId, id]);
  return mapMessage(rows[0]);
}

// Sender edits their own message after posting. Only the fields relevant to
// its type are touched (a text edit doesn't clear poll data, etc.) — this
// updates whichever ones are provided and stamps edited_at.
async function updateMessage(client, organizationId, id, fields) {
  const { rows } = await client.query(
    `UPDATE messages SET
       body = COALESCE($3, body),
       poll_question = COALESCE($4, poll_question),
       poll_options = COALESCE($5, poll_options),
       contact_name = COALESCE($6, contact_name),
       contact_phone = COALESCE($7, contact_phone),
       edited_at = now()
     WHERE organization_id = $1 AND id = $2 RETURNING *`,
    [
      organizationId, id, fields.body ?? null, fields.pollQuestion ?? null,
      fields.pollOptions ? JSON.stringify(fields.pollOptions) : null,
      fields.contactName ?? null, fields.contactPhone ?? null,
    ]
  );
  return mapMessage(rows[0]);
}

// Full per-voter breakdown for the "Info" panel on a poll — deliberately a
// separate call from the main feed fetch (which only returns aggregate
// tallies + the current viewer's own vote) so browsing the feed never leaks
// every other voter's identity by default; only requesting Info does.
async function getPollVoterBreakdown(client, organizationId, messageId) {
  const { rows } = await client.query(
    `SELECT option_index, voter_name, created_at FROM message_votes WHERE organization_id = $1 AND message_id = $2 ORDER BY created_at ASC`,
    [organizationId, messageId]
  );
  return rows.map((r) => ({ optionIndex: r.option_index, name: r.voter_name, votedAt: r.created_at }));
}

// Single-message version of the tally logic in listMessagesForScope — used
// right after a vote, so we don't refetch the whole feed just to show one
// updated poll's counts.
async function getMessageWithTally(client, organizationId, id, viewerKey = null) {
  const message = await getMessageById(client, organizationId, id);
  if (!message || message.type !== 'poll') return message;
  const { rows: voteRows } = await client.query(
    `SELECT option_index, voter_key, voter_name FROM message_votes WHERE organization_id = $1 AND message_id = $2`,
    [organizationId, id]
  );
  message.pollTally = (message.pollOptions || []).map((_, i) => voteRows.filter((v) => v.option_index === i).length);
  message.pollTotalVotes = voteRows.length;
  const mine = viewerKey ? voteRows.find((v) => v.voter_key === viewerKey) : null;
  message.myVote = mine ? mine.option_index : null;
  return message;
}

async function deleteMessage(client, organizationId, id) {
  const { rowCount } = await client.query(`DELETE FROM messages WHERE organization_id = $1 AND id = $2`, [organizationId, id]);
  return rowCount > 0;
}

// voterKey = "tenant:<id>" or "admin:<id>" — ON CONFLICT lets someone change
// their vote (re-voting just updates option_index) rather than erroring.
async function voteOnPoll(client, organizationId, messageId, voterKey, voterName, optionIndex) {
  await client.query(
    `INSERT INTO message_votes (organization_id, message_id, voter_key, voter_name, option_index)
     VALUES ($1,$2,$3,$4,$5)
     ON CONFLICT (message_id, voter_key) DO UPDATE SET option_index = $5, voter_name = $4`,
    [organizationId, messageId, voterKey, voterName, optionIndex]
  );
}

module.exports = {
  parseUid,
  describeUid,
  buildUid,
  isValidAdminUid,
  listBlocks,
  getBlock,
  blockExists,
  createBlock,
  updateBlock,
  deleteBlock,
  clearBlockData,
  createMessage,
  listMessagesForScope,
  getMessageById,
  getMessageWithTally,
  updateMessage,
  getPollVoterBreakdown,
  deleteMessage,
  voteOnPoll,
  findOrgBySlug,
  findAdminByUidPhone,
  findPlatformAdminByUsername,
  listOrganizationsWithStats,
  getOrganizationById,
  getOwnOrganization,
  slugTaken,
  createOrganizationWithSuperAdmin,
  setOrganizationActive,
  resetOrgSuperAdmin,
  deleteOrganizationHard,
  findAdminById,
  listAdmins,
  setAdminPaymentConfirmScope,
  canConfirmPaymentsForBlock,
  updateAdminPasswordHash,
  updateAdminUidPhone,
  countAdmins,
  insertAdmin,
  deleteAdmin,
  uidTakenAnywhere,
  phoneTakenAnywhere,
  findTenantByUidPhone,
  listAllTenants,
  listTenantsByBlock,
  listTenantsPage,
  getTenantById,
  createTenantWithAdvance,
  updateTenant,
  deleteTenant,
  moveOutTenant,
  tenantCountsByBlock,
  listRoomsByBlock,
  floorExists,
  createFloorRooms,
  getRoomById,
  createSingleRoom,
  roomNumberExists,
  deleteRoomRow,
  addBedToRoom,
  removeBedFromRoom,
  setRoomBedCount,
  getRoomByLocation,
  currentPeriod,
  rentForBedCount,
  getPaymentConfig,
  setPaymentConfig,
  getInfoPage,
  setInfoPage,
  sanitizePaymentConfig,
  createPayment,
  getPaymentByTenantPeriod,
  ensureCurrentDue,
  listPaymentsForTenant,
  listUnpaidPaymentsForTenant,
  listPaymentsForTenantAdmin,
  getPaymentById,
  markPaymentPaid,
  recordCashPayment,
  savePushSubscription,
  removePushSubscription,
  getPushSubscriptionsForUser,
  getPushSubscriptionsForAdmins,
  getPushSubscriptionsForMessage,
  listScanners,
  getScannerForBlock,
  createScanner,
  updateScanner,
  deleteScanner,
  hasPendingProofForPayment,
  createPaymentProof,
  listProofsForTenant,
  listPendingProofsForAdmin,
  getProofById,
  approveProof,
  rejectProof,
  reminderTone,
  getDuesOverview,
  getMonthlyRentSummary,
  getOccupancySummary,
  createComplaint,
  listComplaintsForTenant,
  listComplaintsForAdmin,
  getComplaintById,
  resolveComplaint,
  logAction,
  recentAuditLog,
};
