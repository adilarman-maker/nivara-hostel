const pool = require('./pool');

// Block code map — 1st digit of every TENANT UID
const BLOCKS = {
  1: { key: 'veera', name: 'Veera', type: 'Boys Hostel' },
  2: { key: 'dheera', name: 'Dheera', type: 'Boys Premium' },
  3: { key: 'shakthi', name: 'Shakthi', type: 'Girls Hostel' },
  4: { key: 'karuna', name: 'Karuna', type: 'Hotel / Lodge' },
};

// ---------- UID helpers (pure functions, no DB) ----------

// TENANT uid: 5 digits, [Block 1-4][Floor][Room 01-99][Bed 1-9]
function parseUid(uid) {
  if (!/^\d{5}$/.test(uid)) return null;
  const block = parseInt(uid[0], 10);
  const floor = parseInt(uid[1], 10);
  const room = parseInt(uid.slice(2, 4), 10);
  const bed = parseInt(uid[4], 10);
  if (!BLOCKS[block]) return null;
  if (room < 1 || bed < 1) return null;
  return { block, floor, room, bed };
}

function describeUid(uid) {
  const parsed = parseUid(uid);
  if (!parsed) return null;
  const b = BLOCKS[parsed.block];
  return `${b.name} • Floor ${parsed.floor} • Room ${String(parsed.room).padStart(2, '0')} • Bed ${parsed.bed}`;
}

function buildUid(block, floor, room, bed) {
  return `${block}${floor}${String(room).padStart(2, '0')}${bed}`;
}

// ADMIN uid: 5 digits too, but the first digit must NOT be 1-4, so an admin
// UID can never collide in meaning with (or be mistaken for) a tenant room
// code. It's just an access code, not an encoded location.
function isValidAdminUid(uid) {
  if (!/^\d{5}$/.test(uid || '')) return false;
  const firstDigit = parseInt(uid[0], 10);
  return firstDigit < 1 || firstDigit > 4;
}

// ---------- admins ----------

async function findAdminByUidPhone(uid, phone) {
  const { rows } = await pool.query(`SELECT * FROM admins WHERE uid = $1 AND phone = $2`, [uid, phone]);
  return rows[0] || null;
}

async function findAdminById(id) {
  const { rows } = await pool.query(`SELECT * FROM admins WHERE id = $1`, [id]);
  return rows[0] || null;
}

async function listAdmins() {
  const { rows } = await pool.query(
    `SELECT id, uid, phone, username, role, block_code AS "blockCode", name FROM admins ORDER BY role DESC, block_code`
  );
  return rows;
}

async function updateAdminPasswordHash(id, passwordHash) {
  const { rowCount } = await pool.query(`UPDATE admins SET password_hash = $1 WHERE id = $2`, [passwordHash, id]);
  return rowCount > 0;
}

async function updateAdminUidPhone(id, { uid, phone }) {
  const { rows } = await pool.query(
    `UPDATE admins SET
       uid = COALESCE($2, uid),
       phone = COALESCE($3, phone)
     WHERE id = $1
     RETURNING id, uid, phone, username, role, block_code AS "blockCode", name`,
    [id, uid ?? null, phone ?? null]
  );
  return rows[0] || null;
}

async function countAdmins() {
  const { rows } = await pool.query(`SELECT COUNT(*)::int AS n FROM admins`);
  return rows[0].n;
}

async function insertAdmin(admin) {
  await pool.query(
    `INSERT INTO admins (id, uid, phone, username, password_hash, role, block_code, name)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8) ON CONFLICT (id) DO NOTHING`,
    [admin.id, admin.uid, admin.phone, admin.username, admin.passwordHash, admin.role, admin.blockCode, admin.name]
  );
}

// ---------- cross-table uniqueness (a UID/phone must be unique across BOTH tenants AND admins) ----------

async function uidTakenAnywhere(uid, exclude = {}) {
  const { rows } = await pool.query(
    `SELECT 1 FROM tenants WHERE uid = $1 AND ($2::text IS NULL OR id != $2)
     UNION
     SELECT 1 FROM admins WHERE uid = $1 AND ($3::text IS NULL OR id != $3)`,
    [uid, exclude.tenantId || null, exclude.adminId || null]
  );
  return rows.length > 0;
}

async function phoneTakenAnywhere(phone, exclude = {}) {
  const { rows } = await pool.query(
    `SELECT 1 FROM tenants WHERE phone = $1 AND ($2::text IS NULL OR id != $2)
     UNION
     SELECT 1 FROM admins WHERE phone = $1 AND ($3::text IS NULL OR id != $3)`,
    [phone, exclude.tenantId || null, exclude.adminId || null]
  );
  return rows.length > 0;
}

// ---------- tenants ----------

function mapTenant(row) {
  if (!row) return null;
  return {
    id: row.id,
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
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

async function findTenantByUidPhone(uid, phone) {
  const { rows } = await pool.query(`SELECT * FROM tenants WHERE uid = $1 AND phone = $2`, [uid, phone]);
  return mapTenant(rows[0]);
}

async function listAllTenants() {
  const { rows } = await pool.query(`SELECT * FROM tenants ORDER BY uid`);
  return rows.map(mapTenant);
}

// Scoped fetch — used by Rooms/Dues so we don't pull the whole tenants table
// just to check occupancy or dues for ONE block. Uses the functional index
// on LEFT(uid,1) (see migrate.js) so this stays fast as the table grows.
async function listTenantsByBlock(blockCode) {
  const { rows } = await pool.query(
    `SELECT * FROM tenants WHERE LEFT(uid, 1) = $1 ORDER BY uid`,
    [String(blockCode)]
  );
  return rows.map(mapTenant);
}

// Paginated + optionally searched + optionally block-filtered tenant list —
// what the admin "All Tenants" screen actually calls now instead of
// fetching every row on every load.
async function listTenantsPage({ blockCode, search, page = 1, limit = 50 }) {
  const conditions = [];
  const params = [];

  if (blockCode) {
    params.push(String(blockCode));
    conditions.push(`LEFT(uid, 1) = $${params.length}`);
  }
  if (search) {
    params.push(`%${search}%`);
    const idx = params.length;
    conditions.push(`(name ILIKE $${idx} OR uid ILIKE $${idx} OR phone ILIKE $${idx})`);
  }
  const where = conditions.length ? `WHERE ${conditions.join(' AND ')}` : '';

  const countResult = await pool.query(`SELECT COUNT(*)::int AS n FROM tenants ${where}`, params);
  const total = countResult.rows[0].n;

  const offset = (page - 1) * limit;
  params.push(limit, offset);
  const { rows } = await pool.query(
    `SELECT * FROM tenants ${where} ORDER BY uid LIMIT $${params.length - 1} OFFSET $${params.length}`,
    params
  );

  return { tenants: rows.map(mapTenant), total, page, limit };
}

async function getTenantById(id) {
  const { rows } = await pool.query(`SELECT * FROM tenants WHERE id = $1`, [id]);
  return mapTenant(rows[0]);
}

// Wrapped in a transaction with its initial advance payment so the two
// writes succeed or fail together — never a tenant with no payment record,
// or a payment record with no tenant.
async function createTenantWithAdvance(tenant, advancePeriod, advanceAmount) {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const { rows } = await pool.timedQuery(client,
      `INSERT INTO tenants (id, uid, phone, name, email, notes, college, hometown, parent_phone, age, gender, monthly_rent, advance_amount)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13) RETURNING *`,
      [
        tenant.id, tenant.uid, tenant.phone, tenant.name, tenant.email || '', tenant.notes || '',
        tenant.college || '', tenant.hometown || '', tenant.parentPhone || '', tenant.age || null, tenant.gender || '',
        tenant.monthlyRent, tenant.advanceAmount,
      ]
    );
    await pool.timedQuery(client,
      `INSERT INTO payments (id, tenant_id, period, amount, type, status) VALUES ($1,$2,$3,$4,'advance','due')`,
      [`p-${tenant.id}-${advancePeriod}`, tenant.id, advancePeriod, advanceAmount]
    );
    await client.query('COMMIT');
    return mapTenant(rows[0]);
  } catch (e) {
    await client.query('ROLLBACK');
    throw e;
  } finally {
    client.release();
  }
}

async function updateTenant(id, fields) {
  const { rows } = await pool.query(
    `UPDATE tenants SET
       uid = COALESCE($2, uid),
       phone = COALESCE($3, phone),
       name = COALESCE($4, name),
       email = COALESCE($5, email),
       notes = COALESCE($6, notes),
       college = COALESCE($7, college),
       hometown = COALESCE($8, hometown),
       parent_phone = COALESCE($9, parent_phone),
       age = COALESCE($10, age),
       gender = COALESCE($11, gender),
       monthly_rent = COALESCE($12, monthly_rent),
       advance_amount = COALESCE($13, advance_amount),
       updated_at = now()
     WHERE id = $1 RETURNING *`,
    [
      id, fields.uid ?? null, fields.phone ?? null, fields.name ?? null, fields.email, fields.notes,
      fields.college, fields.hometown, fields.parentPhone, fields.age ?? null, fields.gender,
      fields.monthlyRent ?? null, fields.advanceAmount ?? null,
    ]
  );
  return mapTenant(rows[0]);
}

async function deleteTenant(id) {
  const { rowCount } = await pool.query(`DELETE FROM tenants WHERE id = $1`, [id]);
  return rowCount > 0;
}

// Single grouped query instead of fetching every tenant row and counting in JS.
async function tenantCountsByBlock() {
  const { rows } = await pool.query(
    `SELECT LEFT(uid, 1) AS block, COUNT(*)::int AS n FROM tenants GROUP BY LEFT(uid, 1)`
  );
  const counts = { 1: 0, 2: 0, 3: 0, 4: 0 };
  rows.forEach((r) => { if (counts[r.block] !== undefined) counts[r.block] = r.n; });
  return counts;
}

// ---------- rooms (floors/rooms exist independently of tenants) ----------

function mapRoom(row) {
  if (!row) return null;
  return {
    id: row.id,
    blockCode: row.block_code,
    floorNumber: row.floor_number,
    roomNumber: row.room_number,
    bedCount: row.bed_count,
    // Display label matches hotel-style numbering: floor digit + 2-digit room, e.g. floor 1 room 1 -> "101"
    label: `${row.floor_number}${String(row.room_number).padStart(2, '0')}`,
  };
}

async function listRoomsByBlock(blockCode) {
  const { rows } = await pool.query(
    `SELECT * FROM rooms WHERE block_code = $1 ORDER BY floor_number, room_number`,
    [blockCode]
  );
  return rows.map(mapRoom);
}

async function floorExists(blockCode, floorNumber) {
  const { rows } = await pool.query(
    `SELECT 1 FROM rooms WHERE block_code = $1 AND floor_number = $2 LIMIT 1`,
    [blockCode, floorNumber]
  );
  return rows.length > 0;
}

// Creates every room on a floor in ONE bulk insert instead of one INSERT
// per room (was up to 99 sequential round trips for a big floor).
async function createFloorRooms(blockCode, floorNumber, roomCount) {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const values = [];
    const params = [];
    for (let roomNumber = 1; roomNumber <= roomCount; roomNumber++) {
      const id = `r-${blockCode}${floorNumber}-${Date.now().toString(36)}-${roomNumber}`;
      const base = params.length;
      params.push(id, blockCode, floorNumber, roomNumber);
      values.push(`($${base + 1},$${base + 2},$${base + 3},$${base + 4},1)`);
    }
    const { rows } = await pool.timedQuery(client,
      `INSERT INTO rooms (id, block_code, floor_number, room_number, bed_count)
       VALUES ${values.join(',')} RETURNING *`,
      params
    );
    await client.query('COMMIT');
    return rows.map(mapRoom);
  } catch (e) {
    await client.query('ROLLBACK');
    throw e;
  } finally {
    client.release();
  }
}

async function getRoomById(id) {
  const { rows } = await pool.query(`SELECT * FROM rooms WHERE id = $1`, [id]);
  return mapRoom(rows[0]);
}

async function addBedToRoom(id) {
  const { rows } = await pool.query(
    `UPDATE rooms SET bed_count = bed_count + 1 WHERE id = $1 AND bed_count < 9 RETURNING *`,
    [id]
  );
  return mapRoom(rows[0]);
}

// Removes the highest-numbered bed slot. Caller must have already verified
// that bed isn't occupied (checked in the route, since occupancy is derived
// from tenants, not stored on the room itself).
async function removeBedFromRoom(id) {
  const { rows } = await pool.query(
    `UPDATE rooms SET bed_count = bed_count - 1 WHERE id = $1 AND bed_count > 1 RETURNING *`,
    [id]
  );
  return mapRoom(rows[0]);
}

async function setRoomBedCount(id, bedCount) {
  const { rows } = await pool.query(
    `UPDATE rooms SET bed_count = $2 WHERE id = $1 RETURNING *`,
    [id, bedCount]
  );
  return mapRoom(rows[0]);
}

async function getRoomByLocation(blockCode, floorNumber, roomNumber) {
  const { rows } = await pool.query(
    `SELECT * FROM rooms WHERE block_code = $1 AND floor_number = $2 AND room_number = $3`,
    [blockCode, floorNumber, roomNumber]
  );
  return mapRoom(rows[0]);
}

// ---------- payments ----------

function currentPeriod() {
  return new Date().toISOString().slice(0, 7); // 'YYYY-MM'
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
  return {
    id: row.id,
    tenantId: row.tenant_id,
    period: row.period,
    amount: Number(row.amount),
    type: row.type,
    status: row.status,
    method: row.method,
    gatewayOrderId: row.gateway_order_id,
    gatewayPaymentId: row.gateway_payment_id,
    paidAt: row.paid_at,
    createdAt: row.created_at,
  };
}

// Strips secrets before this config is ever sent to a browser — used for
// every GET /api/payments/config response, tenant or admin alike.
// razorpayKeyId is safe to expose (Razorpay's own checkout.js requires it
// client-side by design); razorpayKeySecret and razorpayWebhookSecret must
// never leave the server.
function sanitizePaymentConfig(config) {
  return {
    upiId: config.upiId || '',
    payeeName: config.payeeName || 'Nivara Hostel & Stay',
    advanceAmount: config.advanceAmount || 0,
    rentByBedCount: config.rentByBedCount || {},
    razorpayKeyId: config.razorpayKeyId || '',
    razorpayEnabled: !!(config.razorpayKeyId && config.razorpayKeySecret),
  };
}

async function getPaymentConfig() {
  const { rows } = await pool.query(`SELECT value FROM settings WHERE key = 'paymentConfig'`);
  return rows[0] ? rows[0].value : {
    upiId: '', payeeName: 'Nivara Hostel & Stay', advanceAmount: 0, rentByBedCount: {},
    razorpayKeyId: '', razorpayKeySecret: '', razorpayWebhookSecret: '',
  };
}

async function setPaymentConfig(config) {
  await pool.query(
    `INSERT INTO settings (key, value) VALUES ('paymentConfig', $1)
     ON CONFLICT (key) DO UPDATE SET value = $1`,
    [JSON.stringify(config)]
  );
}

async function createPayment(tenantId, period, amount, type, status = 'due') {
  const { rows } = await pool.query(
    `INSERT INTO payments (id, tenant_id, period, amount, type, status)
     VALUES ($1,$2,$3,$4,$5,$6)
     ON CONFLICT (tenant_id, period) DO NOTHING
     RETURNING *`,
    [`p-${tenantId}-${period}`, tenantId, period, amount, type, status]
  );
  return mapPayment(rows[0]);
}

async function getPaymentByTenantPeriod(tenantId, period) {
  const { rows } = await pool.query(`SELECT * FROM payments WHERE tenant_id = $1 AND period = $2`, [tenantId, period]);
  return mapPayment(rows[0]);
}

// Called whenever a tenant's dashboard (or an admin's dues view) loads.
// If we're past the 5th of the month and this tenant has no payment row yet
// for the current period, create one as 'due' using THEIR OWN monthly_rent
// (set explicitly by the admin who added them, not a bed-count guess).
async function ensureCurrentDue(tenant) {
  const period = currentPeriod();
  const existing = await getPaymentByTenantPeriod(tenant.id, period);
  if (existing) return existing;

  const dayOfMonth = new Date().getDate();
  if (dayOfMonth < 6) return null; // no reminder before day 6

  const amount = tenant.monthlyRent || 0;
  return createPayment(tenant.id, period, amount, 'rent', 'due');
}

async function listPaymentsForTenant(tenantId) {
  const { rows } = await pool.query(`SELECT * FROM payments WHERE tenant_id = $1 ORDER BY period DESC`, [tenantId]);
  return rows.map(mapPayment);
}

async function getPaymentById(id) {
  const { rows } = await pool.query(`SELECT * FROM payments WHERE id = $1`, [id]);
  return mapPayment(rows[0]);
}

async function markPaymentPaid(id, method) {
  const { rows } = await pool.query(
    `UPDATE payments SET status = 'paid', method = $2, paid_at = now() WHERE id = $1 RETURNING *`,
    [id, method]
  );
  return mapPayment(rows[0]);
}

// Used by BOTH the client-side "verify right after checkout" call AND the
// webhook — either can arrive first. The `AND status != 'paid'` makes this
// safe to call twice for the same payment: whichever arrives first does the
// real update, the second is a harmless no-op (alreadyPaid: true).
async function markPaymentPaidViaGateway(id, gatewayPaymentId) {
  const { rows } = await pool.query(
    `UPDATE payments SET status = 'paid', method = 'razorpay', gateway_payment_id = $2, paid_at = now()
     WHERE id = $1 AND status != 'paid' RETURNING *`,
    [id, gatewayPaymentId]
  );
  if (rows.length > 0) return { payment: mapPayment(rows[0]), alreadyPaid: false };
  const existing = await getPaymentById(id);
  return { payment: existing, alreadyPaid: true };
}

async function setPaymentGatewayOrder(id, orderId) {
  const { rows } = await pool.query(
    `UPDATE payments SET gateway_order_id = $2 WHERE id = $1 RETURNING *`,
    [id, orderId]
  );
  return mapPayment(rows[0]);
}

async function findPaymentByGatewayOrderId(orderId) {
  const { rows } = await pool.query(`SELECT * FROM payments WHERE gateway_order_id = $1`, [orderId]);
  return mapPayment(rows[0]);
}

// Makes sure every tenant in scope has an up-to-date due row for the current
// period (if we're past day 5), then returns the aggregated view an admin sees.
// This used to loop and `await` one query PER TENANT (classic N+1) — now it's
// two batched queries total, regardless of how many tenants are in scope.
async function getDuesOverview(blockCodeFilter) {
  const scoped = blockCodeFilter ? await listTenantsByBlock(blockCodeFilter) : await listAllTenants();

  if (scoped.length === 0) {
    return { dueList: [], totalDue: 0, totalCollected: 0, dueCount: 0, percentCollected: 0, percentDue: 0 };
  }

  const tenantIds = scoped.map((t) => t.id);
  const period = currentPeriod();
  const dayOfMonth = new Date().getDate();

  if (dayOfMonth >= 6) {
    // One query: which of these tenants already have a row for this period?
    const { rows: existing } = await pool.query(
      `SELECT tenant_id FROM payments WHERE tenant_id = ANY($1::text[]) AND period = $2`,
      [tenantIds, period]
    );
    const alreadyHave = new Set(existing.map((r) => r.tenant_id));
    const needsRow = scoped.filter((t) => !alreadyHave.has(t.id) && t.monthlyRent);

    if (needsRow.length > 0) {
      // One bulk insert for everyone who's missing a row, instead of one INSERT per tenant.
      const values = [];
      const params = [];
      needsRow.forEach((t, i) => {
        const base = i * 5;
        params.push(`p-${t.id}-${period}`, t.id, period, t.monthlyRent, 'rent');
        values.push(`($${base + 1},$${base + 2},$${base + 3},$${base + 4},$${base + 5},'due')`);
      });
      await pool.query(
        `INSERT INTO payments (id, tenant_id, period, amount, type, status)
         VALUES ${values.join(',')}
         ON CONFLICT (tenant_id, period) DO NOTHING`,
        params
      );
    }
  }

  const { rows } = await pool.query(
    `SELECT p.*, t.name AS tenant_name, t.uid AS tenant_uid, t.phone AS tenant_phone
     FROM payments p JOIN tenants t ON t.id = p.tenant_id
     WHERE p.tenant_id = ANY($1::text[])
     ORDER BY p.period DESC`,
    [tenantIds]
  );

  const due = rows.filter((r) => r.status === 'due');
  const paid = rows.filter((r) => r.status === 'paid');
  const totalDue = due.reduce((sum, r) => sum + Number(r.amount), 0);
  const totalCollected = paid.reduce((sum, r) => sum + Number(r.amount), 0);
  const totalOfBoth = totalDue + totalCollected;

  return {
    dueList: due.map((r) => ({
      ...mapPayment(r),
      tenantName: r.tenant_name,
      tenantUid: r.tenant_uid,
      tenantPhone: r.tenant_phone,
    })),
    totalDue,
    totalCollected,
    dueCount: due.length,
    percentCollected: totalOfBoth > 0 ? Math.round((totalCollected / totalOfBoth) * 100) : 0,
    percentDue: totalOfBoth > 0 ? Math.round((totalDue / totalOfBoth) * 100) : 0,
  };
}

// Full payment history for one tenant, for an admin viewing their profile
// (permission/block-scoping is checked in the route, not here).
async function listPaymentsForTenantAdmin(tenantId) {
  return listPaymentsForTenant(tenantId);
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

async function createComplaint(tenantId, message) {
  const id = `c-${tenantId}-${Date.now().toString(36)}`;
  const { rows } = await pool.query(
    `INSERT INTO complaints (id, tenant_id, message) VALUES ($1,$2,$3) RETURNING *`,
    [id, tenantId, message]
  );
  return mapComplaint(rows[0]);
}

async function listComplaintsForTenant(tenantId) {
  const { rows } = await pool.query(`SELECT * FROM complaints WHERE tenant_id = $1 ORDER BY created_at DESC`, [tenantId]);
  return rows.map(mapComplaint);
}

// blockCodeFilter null = every complaint (Super Admin); otherwise scoped to that block (sub-admin)
async function listComplaintsForAdmin(blockCodeFilter, { page = 1, limit = 100 } = {}) {
  const params = [];
  let where = '';
  if (blockCodeFilter) {
    params.push(String(blockCodeFilter));
    where = `WHERE LEFT(t.uid, 1) = $${params.length}`;
  }

  const countResult = await pool.query(
    `SELECT COUNT(*)::int AS n FROM complaints c JOIN tenants t ON t.id = c.tenant_id ${where}`,
    params
  );
  const total = countResult.rows[0].n;

  const offset = (page - 1) * limit;
  params.push(limit, offset);
  const { rows } = await pool.query(
    `SELECT c.*, t.name AS tenant_name, t.uid AS tenant_uid, t.phone AS tenant_phone
     FROM complaints c JOIN tenants t ON t.id = c.tenant_id
     ${where}
     ORDER BY c.created_at DESC
     LIMIT $${params.length - 1} OFFSET $${params.length}`,
    params
  );
  return { complaints: rows.map(mapComplaint), total, page, limit };
}

async function getComplaintById(id) {
  const { rows } = await pool.query(
    `SELECT c.*, t.name AS tenant_name, t.uid AS tenant_uid, t.phone AS tenant_phone
     FROM complaints c JOIN tenants t ON t.id = c.tenant_id
     WHERE c.id = $1`,
    [id]
  );
  return mapComplaint(rows[0]);
}

async function resolveComplaint(id) {
  const { rows } = await pool.query(
    `UPDATE complaints SET status = 'resolved', resolved_at = now() WHERE id = $1 RETURNING *`,
    [id]
  );
  return mapComplaint(rows[0]);
}

// ---------- audit log ----------

async function logAction(byName, action, details) {
  await pool.query(`INSERT INTO audit_log (by_name, action, details) VALUES ($1,$2,$3)`, [byName, action, details]);
}

async function recentAuditLog(limit = 10) {
  const { rows } = await pool.query(`SELECT ts, by_name AS by, action, details FROM audit_log ORDER BY ts DESC LIMIT $1`, [limit]);
  return rows;
}

module.exports = {
  BLOCKS,
  parseUid,
  describeUid,
  buildUid,
  isValidAdminUid,
  findAdminByUidPhone,
  findAdminById,
  listAdmins,
  updateAdminPasswordHash,
  updateAdminUidPhone,
  countAdmins,
  insertAdmin,
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
  tenantCountsByBlock,
  listRoomsByBlock,
  floorExists,
  createFloorRooms,
  getRoomById,
  addBedToRoom,
  removeBedFromRoom,
  setRoomBedCount,
  getRoomByLocation,
  currentPeriod,
  rentForBedCount,
  getPaymentConfig,
  setPaymentConfig,
  sanitizePaymentConfig,
  createPayment,
  getPaymentByTenantPeriod,
  ensureCurrentDue,
  listPaymentsForTenant,
  listPaymentsForTenantAdmin,
  getPaymentById,
  markPaymentPaid,
  markPaymentPaidViaGateway,
  setPaymentGatewayOrder,
  findPaymentByGatewayOrderId,
  getDuesOverview,
  createComplaint,
  listComplaintsForTenant,
  listComplaintsForAdmin,
  getComplaintById,
  resolveComplaint,
  logAction,
  recentAuditLog,
};
