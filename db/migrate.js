require('dotenv').config();
const fs = require('fs');
const path = require('path');
const bcrypt = require('bcryptjs');
const pool = require('./pool');

// Starter/placeholder login values so you can log in the FIRST time.
// Change every one of these from the Admin Accounts screen once you're in —
// that's the whole point of this update. UIDs deliberately start with a
// digit that's never a valid tenant block (1-4), so an admin UID can never
// collide with a real tenant room code.
const STARTER_ADMINS = [
  { id: 'a-super', uid: '00001', phone: '6302126347', username: 'superadmin', role: 'super', blockCode: null, name: 'Super Admin', password: 'Super@123' },
  { id: 'a-veera', uid: '90001', phone: '9000000001', username: 'admin.veera', role: 'sub', blockCode: 1, name: 'Veera Block Admin', password: 'Veera@123' },
  { id: 'a-dheera', uid: '90002', phone: '9000000002', username: 'admin.dheera', role: 'sub', blockCode: 2, name: 'Dheera Block Admin', password: 'Dheera@123' },
  { id: 'a-shakthi', uid: '90003', phone: '9000000003', username: 'admin.shakthi', role: 'sub', blockCode: 3, name: 'Shakthi Block Admin', password: 'Shakthi@123' },
  { id: 'a-karuna', uid: '90004', phone: '9000000004', username: 'admin.karuna', role: 'sub', blockCode: 4, name: 'Karuna Block Admin', password: 'Karuna@123' },
];

async function migrate() {
  console.log('Running schema.sql …');
  const schema = fs.readFileSync(path.join(__dirname, 'schema.sql'), 'utf-8');
  await pool.query(schema);
  console.log('✓ Tables ready');

  // Safe to re-run on a database created by an older version of this app —
  // adds the uid/phone columns if they're missing.
  await pool.query(`ALTER TABLE admins ADD COLUMN IF NOT EXISTS uid CHAR(5)`);
  await pool.query(`ALTER TABLE admins ADD COLUMN IF NOT EXISTS phone CHAR(10)`);
  await pool.query(`CREATE UNIQUE INDEX IF NOT EXISTS admins_uid_unique ON admins(uid)`);
  await pool.query(`CREATE UNIQUE INDEX IF NOT EXISTS admins_phone_unique ON admins(phone)`);
  console.log('✓ admins.uid / admins.phone columns ready');

  await pool.query(`ALTER TABLE tenants ADD COLUMN IF NOT EXISTS college TEXT DEFAULT ''`);
  await pool.query(`ALTER TABLE tenants ADD COLUMN IF NOT EXISTS hometown TEXT DEFAULT ''`);
  await pool.query(`ALTER TABLE tenants ADD COLUMN IF NOT EXISTS parent_phone TEXT DEFAULT ''`);
  await pool.query(`ALTER TABLE tenants ADD COLUMN IF NOT EXISTS age INTEGER`);
  await pool.query(`ALTER TABLE tenants ADD COLUMN IF NOT EXISTS gender TEXT DEFAULT ''`);
  await pool.query(`ALTER TABLE tenants ADD COLUMN IF NOT EXISTS monthly_rent NUMERIC`);
  await pool.query(`ALTER TABLE tenants ADD COLUMN IF NOT EXISTS advance_amount NUMERIC`);
  console.log('✓ tenants profile + fee columns ready');

  await pool.query(`ALTER TABLE payments ADD COLUMN IF NOT EXISTS type TEXT DEFAULT 'rent'`);
  // Backfill: the earliest payment period per tenant was their advance, everything after is rent.
  await pool.query(`
    UPDATE payments SET type = 'advance'
    WHERE id IN (SELECT DISTINCT ON (tenant_id) id FROM payments ORDER BY tenant_id, period ASC)
    AND type = 'rent'
  `);
  console.log('✓ payments.type column ready (backfilled earliest period per tenant as advance)');

  await pool.query(`ALTER TABLE payments ADD COLUMN IF NOT EXISTS gateway_order_id TEXT`);
  await pool.query(`ALTER TABLE payments ADD COLUMN IF NOT EXISTS gateway_payment_id TEXT`);
  await pool.query(`CREATE INDEX IF NOT EXISTS idx_payments_gateway_order ON payments(gateway_order_id)`);
  console.log('✓ payments Razorpay columns ready (gateway_order_id, gateway_payment_id)');

  const { rows: existingConfig } = await pool.query(`SELECT 1 FROM settings WHERE key = 'paymentConfig'`);
  if (existingConfig.length === 0) {
    await pool.query(
      `INSERT INTO settings (key, value) VALUES ('paymentConfig', $1)`,
      [JSON.stringify({
        upiId: '',
        payeeName: 'Nivara Hostel & Stay',
        advanceAmount: 9000,
        // Monthly rent by how many people share the room (matches the brochure's tiers).
        // Rooms with more beds than the highest key use that highest tier's rate.
        rentByBedCount: { 1: 9000, 2: 8000, 3: 7000, 4: 6000, 5: 5500 },
        // Razorpay — blank until the Super Admin fills these in from Payments → Settings.
        // razorpayKeySecret and razorpayWebhookSecret NEVER get sent to the browser once
        // saved (see db/database.js: sanitizePaymentConfig).
        razorpayKeyId: '',
        razorpayKeySecret: '',
        razorpayWebhookSecret: '',
      })]
    );
    console.log('✓ Seeded default payment config (edit it in Payments → Settings before going live)');
  } else {
    console.log('• paymentConfig already exists — left untouched');
  }

  // Functional index on the block digit (1st char of UID) — used by every
  // block-scoped query (Rooms, Dues, Complaints, tenant search) instead of
  // fetching every row and filtering in JavaScript.
  await pool.query(`CREATE INDEX IF NOT EXISTS idx_tenants_block_char ON tenants ((LEFT(uid, 1)))`);
  // (No separate payments tenant+period index needed — the UNIQUE(tenant_id, period)
  // constraint in schema.sql already creates that index automatically.)
  console.log('✓ Performance index ready (tenants block-char lookup)');

  for (const a of STARTER_ADMINS) {
    const { rows } = await pool.query(`SELECT id, uid, phone FROM admins WHERE id = $1`, [a.id]);
    if (rows.length === 0) {
      // Brand new row — insert with starter credentials.
      const passwordHash = bcrypt.hashSync(a.password, 10);
      await pool.query(
        `INSERT INTO admins (id, uid, phone, username, password_hash, role, block_code, name)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8)`,
        [a.id, a.uid, a.phone, a.username, passwordHash, a.role, a.blockCode, a.name]
      );
      console.log(`✓ Created ${a.name} — starter UID ${a.uid}, phone ${a.phone}`);
    } else if (!rows[0].uid || !rows[0].phone) {
      // Existing row from an older version of the app that never had uid/phone — backfill starters,
      // but never overwrite a UID/phone you've already set yourself.
      await pool.query(`UPDATE admins SET uid = $2, phone = $3 WHERE id = $1`, [a.id, a.uid, a.phone]);
      console.log(`✓ Backfilled starter UID/phone for ${a.name}`);
    } else {
      console.log(`• ${a.name} already has a UID/phone set — left untouched`);
    }
  }

  console.log('\nMigration complete. Log in with the starter UID/phone + password shown above,');
  console.log('then change each one from the Admin Accounts screen.\n');
  await pool.end();
}

migrate().catch((err) => {
  console.error('Migration failed:', err.message);
  process.exit(1);
});
