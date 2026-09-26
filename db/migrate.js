require('dotenv').config();
const fs = require('fs');
const path = require('path');
const bcrypt = require('bcryptjs');
const pool = require('./pool');

// Only the Super Admin has a fixed starter login now — sub-admins are
// created dynamically alongside each block from the Blocks screen.
const STARTER_SUPER_ADMIN = {
  id: 'a-super', uid: '00001', phone: '6302126347', username: 'superadmin',
  role: 'super', blockCode: null, name: 'Super Admin', password: 'Super@123',
};

// The Platform Admin — the one account that sits above every hostel and can
// create/deactivate/delete them. Change this password immediately after
// your first login (there's no "forgot password" for this tier yet — if
// you lose it, reset it directly in the platform_admins table via SQL).
const STARTER_PLATFORM_ADMIN = {
  id: 'pa-owner', username: 'platform-owner', name: 'Platform Owner', password: 'ChangeMe@123',
};

async function migrate() {
  // One-time destructive migration to dynamic blocks: if the `blocks` table
  // doesn't exist yet but `admins` already does, this is an existing
  // deployment from before blocks were dynamic. Per the setup choice made
  // for this app, that means: wipe rooms/tenants/payments/complaints, and
  // remove the 4 old fixed sub-admin accounts (Super Admin is kept).
  const { rows: blocksCheck } = await pool.query(`SELECT to_regclass('public.blocks') AS exists`);
  const { rows: adminsCheck } = await pool.query(`SELECT to_regclass('public.admins') AS exists`);
  const isFreshInstall = !adminsCheck[0].exists;
  const needsDynamicBlocksMigration = !blocksCheck[0].exists && !isFreshInstall;

  if (needsDynamicBlocksMigration) {
    console.log('\n⚠️  Migrating to dynamic blocks — this WIPES existing rooms, tenants,');
    console.log('   payments, and complaints, and removes the 4 old fixed sub-admin');
    console.log('   accounts (Super Admin is kept). This runs only this one time.\n');
    await pool.query(`DROP TABLE IF EXISTS payments CASCADE`);
    await pool.query(`DROP TABLE IF EXISTS complaints CASCADE`);
    await pool.query(`DROP TABLE IF EXISTS rooms CASCADE`);
    await pool.query(`DROP TABLE IF EXISTS tenants CASCADE`);
    await pool.query(`DELETE FROM admins WHERE role = 'sub'`);
    // admins.block_code was INTEGER before; blocks.code is TEXT now.
    await pool.query(`ALTER TABLE admins ALTER COLUMN block_code TYPE TEXT USING block_code::TEXT`);
    console.log('✓ Old block-scoped data wiped, admins.block_code converted to TEXT\n');
  }

  console.log('Running schema.sql …');
  const schema = fs.readFileSync(path.join(__dirname, 'schema.sql'), 'utf-8');
  await pool.query(schema);
  console.log('✓ Tables ready');

  // ---------------------------------------------------------------------
  // HOSTEL ID (organizations.slug) — independent of the check below, so
  // this self-heals even if an earlier version of this script already ran
  // once (creating `organizations` without a slug column). Every row that
  // predates slug gets 'default' — rename it any time in the
  // organizations table; it's just what's typed into the Hostel ID field
  // on the login screen.
  // ---------------------------------------------------------------------
  await pool.query(`ALTER TABLE organizations ADD COLUMN IF NOT EXISTS slug TEXT`);
  await pool.query(`UPDATE organizations SET slug = 'default' WHERE slug IS NULL`);
  await pool.query(`ALTER TABLE organizations ALTER COLUMN slug SET NOT NULL`);
  await pool.query(`CREATE UNIQUE INDEX IF NOT EXISTS organizations_slug_key ON organizations(slug)`);
  console.log('✓ organizations.slug (Hostel ID) ready');

  // ---------------------------------------------------------------------
  // Ensure exactly one organization exists — the "home" for anything below
  // that doesn't have its own org context yet (the paymentConfig seed, the
  // starter Super Admin, and — on an upgrade — every pre-existing row
  // backfilled in the block right after this one). Centralized here so
  // there's exactly one place that creates a default org, instead of three
  // places that could disagree with each other.
  // ---------------------------------------------------------------------
  const { rows: anyOrgRows } = await pool.query(`SELECT id FROM organizations LIMIT 1`);
  let DEFAULT_ORG_ID = anyOrgRows[0]?.id;
  if (!DEFAULT_ORG_ID) {
    DEFAULT_ORG_ID = 'o-default';
    let defaultOrgName = 'My Hostel';
    const { rows: cfgRows } = await pool.query(`SELECT value FROM settings WHERE key = 'paymentConfig'`);
    if (cfgRows[0]?.value?.payeeName) defaultOrgName = cfgRows[0].value.payeeName;
    await pool.query(`INSERT INTO organizations (id, slug, name) VALUES ($1, $2, $3)`, [DEFAULT_ORG_ID, 'default', defaultOrgName]);
    console.log(`✓ Created default organization "${defaultOrgName}" (id: ${DEFAULT_ORG_ID}, Hostel ID: 'default')`);
  }

  // ---------------------------------------------------------------------
  // MULTI-TENANT MIGRATION — one-time, only runs against a database created
  // before organizations existed. On a fresh install, schema.sql above
  // already created every table with organization_id built in, so this
  // whole block is a no-op there (gated on the check below).
  //
  // The gate checks TWO things, not one: does admins.organization_id exist,
  // AND is blocks' primary key already the composite (organization_id,
  // code) shape. Checking only the first one caused a real bug — if an
  // earlier run of this script got partway through (e.g. crashed or hit an
  // error after backfilling organization_id everywhere but before fixing
  // blocks' primary key), a later run would see organization_id already
  // present, conclude "already migrated", and skip the rest — even though
  // blocks was still sitting in its old shape. Checking blocks' actual
  // structure directly, not just inferring it from a different table,
  // closes that gap.
  //
  // Every statement inside this block is ALSO independently idempotent
  // (DROP CONSTRAINT IF EXISTS immediately before each ADD CONSTRAINT) —
  // so no matter which combination of steps a previous run completed
  // before failing, this one safely finishes the rest without erroring on
  // "already exists".
  // ---------------------------------------------------------------------
  const { rows: orgColCheck } = await pool.query(
    `SELECT 1 FROM information_schema.columns WHERE table_name = 'admins' AND column_name = 'organization_id'`
  );
  const { rows: blocksPkCols } = await pool.query(`
    SELECT a.attname FROM pg_index i
    JOIN pg_attribute a ON a.attrelid = i.indrelid AND a.attnum = ANY(i.indkey)
    WHERE i.indrelid = 'blocks'::regclass AND i.indisprimary
  `);
  const blocksPkIsComposite = blocksPkCols.some((r) => r.attname === 'organization_id');
  const needsOrgMigration = orgColCheck.length === 0 || !blocksPkIsComposite;

  if (needsOrgMigration) {
    console.log('\n⚠️  Migrating to multi-tenant — assigning all existing data to one default organization.\n');

    const orgOwnedTables = ['blocks', 'admins', 'tenants', 'rooms', 'settings', 'payments', 'complaints', 'audit_log', 'messages', 'message_votes'];
    for (const t of orgOwnedTables) {
      await pool.query(`ALTER TABLE ${t} ADD COLUMN IF NOT EXISTS organization_id TEXT`);
      await pool.query(`UPDATE ${t} SET organization_id = $1 WHERE organization_id IS NULL`, [DEFAULT_ORG_ID]);
      await pool.query(`ALTER TABLE ${t} ALTER COLUMN organization_id SET NOT NULL`);
    }
    console.log('✓ organization_id backfilled on every table');

    // blocks: switch PK from (code) to (organization_id, code). CASCADE is
    // needed because admins/rooms/messages still have FKs pointing at the
    // old PK — CASCADE drops those FKs along with it; they get recreated
    // as composite FKs right below anyway. Safe to re-run: DROP...IF EXISTS
    // removes whichever shape is currently there (old or already-fixed)
    // before ADD PRIMARY KEY puts the correct one back.
    await pool.query(`ALTER TABLE blocks DROP CONSTRAINT IF EXISTS blocks_pkey CASCADE`);
    await pool.query(`ALTER TABLE blocks ADD PRIMARY KEY (organization_id, code)`);
    await pool.query(`ALTER TABLE blocks DROP CONSTRAINT IF EXISTS blocks_organization_id_fkey`);
    await pool.query(`ALTER TABLE blocks ADD CONSTRAINT blocks_organization_id_fkey FOREIGN KEY (organization_id) REFERENCES organizations(id) ON DELETE CASCADE`);

    // admins/rooms/messages: old single-column FKs to blocks(code) need to
    // become composite FKs to blocks(organization_id, code).
    await pool.query(`ALTER TABLE admins DROP CONSTRAINT IF EXISTS admins_block_code_fkey`);
    await pool.query(`ALTER TABLE admins DROP CONSTRAINT IF EXISTS admins_organization_id_fkey`);
    await pool.query(`ALTER TABLE admins ADD CONSTRAINT admins_organization_id_fkey FOREIGN KEY (organization_id) REFERENCES organizations(id) ON DELETE CASCADE`);
    await pool.query(`ALTER TABLE admins DROP CONSTRAINT IF EXISTS admins_org_block_fkey`);
    await pool.query(`ALTER TABLE admins ADD CONSTRAINT admins_org_block_fkey FOREIGN KEY (organization_id, block_code) REFERENCES blocks(organization_id, code) ON DELETE SET NULL`);

    await pool.query(`ALTER TABLE rooms DROP CONSTRAINT IF EXISTS rooms_block_code_fkey`);
    await pool.query(`ALTER TABLE rooms DROP CONSTRAINT IF EXISTS rooms_block_code_floor_number_room_number_key`);
    await pool.query(`ALTER TABLE rooms DROP CONSTRAINT IF EXISTS rooms_organization_id_fkey`);
    await pool.query(`ALTER TABLE rooms ADD CONSTRAINT rooms_organization_id_fkey FOREIGN KEY (organization_id) REFERENCES organizations(id) ON DELETE CASCADE`);
    await pool.query(`ALTER TABLE rooms DROP CONSTRAINT IF EXISTS rooms_org_block_fkey`);
    await pool.query(`ALTER TABLE rooms ADD CONSTRAINT rooms_org_block_fkey FOREIGN KEY (organization_id, block_code) REFERENCES blocks(organization_id, code) ON DELETE RESTRICT`);
    await pool.query(`ALTER TABLE rooms DROP CONSTRAINT IF EXISTS rooms_org_block_floor_room_key`);
    await pool.query(`ALTER TABLE rooms ADD CONSTRAINT rooms_org_block_floor_room_key UNIQUE (organization_id, block_code, floor_number, room_number)`);

    await pool.query(`ALTER TABLE messages DROP CONSTRAINT IF EXISTS messages_scope_block_fkey`);
    await pool.query(`ALTER TABLE messages DROP CONSTRAINT IF EXISTS messages_organization_id_fkey`);
    await pool.query(`ALTER TABLE messages ADD CONSTRAINT messages_organization_id_fkey FOREIGN KEY (organization_id) REFERENCES organizations(id) ON DELETE CASCADE`);
    await pool.query(`ALTER TABLE messages DROP CONSTRAINT IF EXISTS messages_org_block_fkey`);
    await pool.query(`ALTER TABLE messages ADD CONSTRAINT messages_org_block_fkey FOREIGN KEY (organization_id, scope_block) REFERENCES blocks(organization_id, code) ON DELETE CASCADE`);

    // Remaining tables just need the plain organization_id -> organizations FK.
    for (const t of ['tenants', 'payments', 'complaints', 'audit_log', 'message_votes', 'settings']) {
      await pool.query(`ALTER TABLE ${t} DROP CONSTRAINT IF EXISTS ${t}_organization_id_fkey`);
      await pool.query(`ALTER TABLE ${t} ADD CONSTRAINT ${t}_organization_id_fkey FOREIGN KEY (organization_id) REFERENCES organizations(id) ON DELETE CASCADE`);
    }

    // settings: PK moves from (key) to (organization_id, key) — payment
    // config etc. is now per-organization. Same DROP-then-ADD idempotency
    // as blocks above.
    await pool.query(`ALTER TABLE settings DROP CONSTRAINT IF EXISTS settings_pkey`);
    await pool.query(`ALTER TABLE settings ADD PRIMARY KEY (organization_id, key)`);

    // tenants.uid uniqueness must be scoped per org — two orgs can each
    // have an active tenant in "their own" bed 10011.
    await pool.query(`DROP INDEX IF EXISTS tenants_uid_active_unique`);
    await pool.query(`CREATE UNIQUE INDEX IF NOT EXISTS tenants_uid_active_unique ON tenants(organization_id, uid) WHERE status != 'moved_out'`);

    // Login moved from "UID+phone, globally unique" to "Hostel ID (slug) +
    // UID+phone, unique per organization" — drop the old GLOBAL uniqueness
    // constraints from earlier versions of this app and replace them with
    // per-organization ones.
    await pool.query(`DROP INDEX IF EXISTS admins_uid_unique`);
    await pool.query(`DROP INDEX IF EXISTS admins_phone_unique`);
    await pool.query(`ALTER TABLE admins DROP CONSTRAINT IF EXISTS admins_username_key`);
    await pool.query(`CREATE UNIQUE INDEX IF NOT EXISTS admins_org_uid_unique ON admins(organization_id, uid)`);
    await pool.query(`CREATE UNIQUE INDEX IF NOT EXISTS admins_org_phone_unique ON admins(organization_id, phone)`);
    await pool.query(`CREATE UNIQUE INDEX IF NOT EXISTS admins_org_username_unique ON admins(organization_id, username)`);
    await pool.query(`ALTER TABLE tenants DROP CONSTRAINT IF EXISTS tenants_phone_key`);
    await pool.query(`CREATE UNIQUE INDEX IF NOT EXISTS tenants_org_phone_unique ON tenants(organization_id, phone)`);

    console.log('✓ Composite keys/FKs fixed to be per-organization');
  } else {
    console.log('• organization_id already present — multi-tenant migration already applied, skipped');
  }

  // These reference organization_id, which schema.sql itself can't safely
  // index unconditionally (see the comment in schema.sql) — created here
  // instead, now that organization_id is guaranteed to exist on every
  // table either way.
  await pool.query(`CREATE INDEX IF NOT EXISTS idx_blocks_org ON blocks(organization_id)`);
  await pool.query(`CREATE INDEX IF NOT EXISTS idx_admins_org ON admins(organization_id)`);
  await pool.query(`CREATE INDEX IF NOT EXISTS idx_tenants_org ON tenants(organization_id)`);
  await pool.query(`CREATE INDEX IF NOT EXISTS idx_rooms_org ON rooms(organization_id, block_code, floor_number)`);
  await pool.query(`CREATE INDEX IF NOT EXISTS idx_payments_org ON payments(organization_id)`);
  await pool.query(`CREATE INDEX IF NOT EXISTS idx_complaints_org ON complaints(organization_id)`);
  await pool.query(`CREATE INDEX IF NOT EXISTS idx_messages_org ON messages(organization_id)`);
  console.log('✓ organization_id indexes ready');

  // payment_scanners' FK to blocks(organization_id, code) — deliberately not
  // declared inline in schema.sql (see the comment there): this table is
  // brand new, so its CREATE TABLE actually runs even against your existing
  // database, before `blocks` is necessarily fixed up to have that composite
  // key. Safe to add now — by this point blocks.PRIMARY KEY is guaranteed to
  // be (organization_id, code) either way (fresh install had it from the
  // start; an upgraded one just got fixed above).
  const { rows: scannerFkCheck } = await pool.query(
    `SELECT 1 FROM pg_constraint WHERE conname = 'payment_scanners_org_block_fkey'`
  );
  if (scannerFkCheck.length === 0) {
    await pool.query(
      `ALTER TABLE payment_scanners ADD CONSTRAINT payment_scanners_org_block_fkey
       FOREIGN KEY (organization_id, scope_block) REFERENCES blocks(organization_id, code) ON DELETE CASCADE`
    );
    console.log('✓ payment_scanners -> blocks foreign key added');
  }

  // Safe to re-run on a database created by an older version of this app —
  // adds the uid/phone columns if they're missing. Scoped per-organization
  // now (see the multi-tenant migration block above, which drops the old
  // global indexes when upgrading from a pre-Hostel-ID database).
  await pool.query(`ALTER TABLE admins ADD COLUMN IF NOT EXISTS uid CHAR(5)`);
  await pool.query(`ALTER TABLE admins ADD COLUMN IF NOT EXISTS phone CHAR(10)`);
  await pool.query(`CREATE UNIQUE INDEX IF NOT EXISTS admins_org_uid_unique ON admins(organization_id, uid)`);
  await pool.query(`CREATE UNIQUE INDEX IF NOT EXISTS admins_org_phone_unique ON admins(organization_id, phone)`);
  console.log('✓ admins.uid / admins.phone columns ready (unique within each organization)');

  // Lets a Super Admin grant a sub-admin payment-confirmation rights beyond
  // their own block (or none at all). NULL/empty = no access (default).
  await pool.query(`ALTER TABLE admins ADD COLUMN IF NOT EXISTS payment_confirm_blocks TEXT[]`);
  console.log('✓ admins.payment_confirm_blocks column ready (Super Admin grants confirmation access per sub-admin)');

  // Tenants now record date AND time of payment, not just the date — widen
  // the column. Safe to re-run: ALTER...TYPE to the same type is a no-op.
  await pool.query(`ALTER TABLE payment_proofs ALTER COLUMN paid_date TYPE TIMESTAMP USING paid_date::timestamp`);
  console.log('✓ payment_proofs.paid_date widened to TIMESTAMP (date + time)');

  await pool.query(`ALTER TABLE tenants ADD COLUMN IF NOT EXISTS college TEXT DEFAULT ''`);
  await pool.query(`ALTER TABLE tenants ADD COLUMN IF NOT EXISTS hometown TEXT DEFAULT ''`);
  await pool.query(`ALTER TABLE tenants ADD COLUMN IF NOT EXISTS parent_phone TEXT DEFAULT ''`);
  await pool.query(`ALTER TABLE tenants ADD COLUMN IF NOT EXISTS age INTEGER`);
  await pool.query(`ALTER TABLE tenants ADD COLUMN IF NOT EXISTS gender TEXT DEFAULT ''`);
  await pool.query(`ALTER TABLE tenants ADD COLUMN IF NOT EXISTS monthly_rent NUMERIC`);
  await pool.query(`ALTER TABLE tenants ADD COLUMN IF NOT EXISTS advance_amount NUMERIC`);
  console.log('✓ tenants profile + fee columns ready');

  // The backfill below only makes sense ONCE — the very first time the
  // `type` column is introduced on a database that predates it entirely.
  // Running it again on a database that already has real advance+rent data
  // is actively harmful: a tenant can legitimately have BOTH an advance row
  // and a rent row in the same period (that's intentional, see the
  // payments_tenant_id_period_type_key fix below), and this backfill's
  // DISTINCT ON has no tiebreaker for that case — it can grab the rent row
  // instead of the advance row and try to relabel it 'advance' too,
  // colliding with the real advance row already there.
  const { rows: typeColCheck } = await pool.query(
    `SELECT 1 FROM information_schema.columns WHERE table_name = 'payments' AND column_name = 'type'`
  );
  const typeColumnAlreadyExisted = typeColCheck.length > 0;
  await pool.query(`ALTER TABLE payments ADD COLUMN IF NOT EXISTS type TEXT DEFAULT 'rent'`);
  if (!typeColumnAlreadyExisted) {
    await pool.query(`
      UPDATE payments SET type = 'advance'
      WHERE id IN (SELECT DISTINCT ON (tenant_id) id FROM payments ORDER BY tenant_id, period ASC)
      AND type = 'rent'
    `);
    console.log('✓ payments.type column added and backfilled (earliest period per tenant marked as advance)');
  } else {
    console.log('• payments.type column already existed — skipped the one-time backfill (it would corrupt real advance/rent data if re-run)');
  }

  await pool.query(`ALTER TABLE payments ADD COLUMN IF NOT EXISTS gateway_order_id TEXT`);
  await pool.query(`ALTER TABLE payments ADD COLUMN IF NOT EXISTS gateway_payment_id TEXT`);
  await pool.query(`CREATE INDEX IF NOT EXISTS idx_payments_gateway_order ON payments(gateway_order_id)`);
  console.log('✓ payments.gateway_order_id / gateway_payment_id ready (unused now that Razorpay is removed — kept rather than risking a DROP COLUMN migration for zero benefit)');

  await pool.query(`ALTER TABLE payments ADD COLUMN IF NOT EXISTS amount_paid NUMERIC NOT NULL DEFAULT 0`);
  // Backfill: any already-'paid' payment is fully paid, so amount_paid = amount for those.
  await pool.query(`UPDATE payments SET amount_paid = amount WHERE status = 'paid' AND amount_paid = 0`);
  console.log('✓ payments.amount_paid column ready (supports partial/cash payments)');

  // Fix a real bug: the old UNIQUE(tenant_id, period) constraint meant a
  // tenant's one-time advance (created in their move-in month) occupied
  // that entire month's slot, silently preventing their monthly RENT due
  // from ever being created for that same month. The constraint needs to
  // include `type` so advance and rent can coexist in the same period.
  const { rows: constraintCheck } = await pool.query(`
    SELECT conname FROM pg_constraint
    WHERE conrelid = 'payments'::regclass AND contype = 'u'
  `);
  const hasOldConstraint = constraintCheck.some((c) => c.conname !== 'payments_tenant_id_period_type_key');
  if (hasOldConstraint) {
    for (const c of constraintCheck) {
      await pool.query(`ALTER TABLE payments DROP CONSTRAINT IF EXISTS ${c.conname}`);
    }
    await pool.query(`ALTER TABLE payments ADD CONSTRAINT payments_tenant_id_period_type_key UNIQUE (tenant_id, period, type)`);
    console.log('✓ Fixed payments constraint — advance and rent no longer collide in the same month');
  } else {
    console.log('• payments constraint already fixed — left untouched');
  }

  const { rows: existingConfig } = await pool.query(`SELECT 1 FROM settings WHERE organization_id = $1 AND key = 'paymentConfig'`, [DEFAULT_ORG_ID]);
  if (existingConfig.length === 0) {
    await pool.query(
      `INSERT INTO settings (organization_id, key, value) VALUES ($1, 'paymentConfig', $2)`,
      [DEFAULT_ORG_ID, JSON.stringify({
        advanceAmount: 2000,
        // Monthly rent by how many people share the room (matches the brochure's tiers).
        // Rooms with more beds than the highest key use that highest tier's rate.
        rentByBedCount: { 1: 9000, 2: 8000, 3: 7000, 4: 6000, 5: 5500 },
      })]
    );
    console.log('✓ Seeded default payment config (edit advance/rent amounts in Payments → Advance & rent amounts)');
  } else {
    console.log('• paymentConfig already exists — left untouched');
  }

  // Functional index on the block digit (1st char of UID) — used by every
  // block-scoped query (Rooms, Dues, Complaints, tenant search) instead of
  // fetching every row and filtering in JavaScript.
  await pool.query(`CREATE INDEX IF NOT EXISTS idx_tenants_block_char ON tenants ((LEFT(uid, 1)))`);
  console.log('✓ Performance index ready (tenants block-char lookup)');

  await pool.query(`ALTER TABLE rooms ADD COLUMN IF NOT EXISTS removed_beds INTEGER[] NOT NULL DEFAULT '{}'`);
  console.log('✓ rooms.removed_beds column ready (lets you delete a specific empty bed, not just the last one)');

  // Booking / lifecycle columns for tenants (pre-book a bed with a future
  // join date, optional auto-vacate date). Existing tenants all default to
  // 'active' with join_date backfilled from when they were actually created.
  await pool.query(`ALTER TABLE tenants ADD COLUMN IF NOT EXISTS status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('booked','active','moved_out'))`);
  await pool.query(`ALTER TABLE tenants ADD COLUMN IF NOT EXISTS join_date DATE NOT NULL DEFAULT CURRENT_DATE`);
  await pool.query(`ALTER TABLE tenants ADD COLUMN IF NOT EXISTS vacate_date DATE`);
  await pool.query(`UPDATE tenants SET join_date = created_at::date WHERE join_date = CURRENT_DATE AND created_at::date != CURRENT_DATE`);
  // Replace the old always-unique uid constraint with a partial one, so a
  // moved-out tenant's UID can be reused by whoever books that bed next,
  // while their own row (and payment history) stays intact forever.
  await pool.query(`ALTER TABLE tenants DROP CONSTRAINT IF EXISTS tenants_uid_key`);
  // Scoped per-organization now — see the multi-tenant migration block above,
  // which also drops/recreates this index when upgrading an older database.
  // On a fresh install this is the only place it's created (IF NOT EXISTS
  // makes re-running this harmless either way).
  await pool.query(`CREATE UNIQUE INDEX IF NOT EXISTS tenants_uid_active_unique ON tenants(organization_id, uid) WHERE status != 'moved_out'`);
  console.log('✓ tenants booking columns ready (status, join_date, vacate_date) — UID reuse after move-out enabled, scoped per organization');

  // Same reuse-after-move-out treatment for phone as uid just got above.
  // tenants_org_phone_unique (created earlier in this file, and on older
  // databases before that) is a plain always-unique index — it was still
  // blocking a moved-out tenant's phone number from ever being used again,
  // even though the app-level check (phoneTakenAnywhere) already excludes
  // moved_out tenants. Replacing it with a partial index scoped the same
  // way as the UID one is what actually fixes "phone already registered"
  // on re-adding someone who was previously removed.
  await pool.query(`DROP INDEX IF EXISTS tenants_org_phone_unique`);
  await pool.query(`ALTER TABLE tenants DROP CONSTRAINT IF EXISTS tenants_phone_key`);
  await pool.query(`CREATE UNIQUE INDEX IF NOT EXISTS tenants_phone_active_unique ON tenants(organization_id, phone) WHERE status != 'moved_out'`);
  console.log('✓ tenants phone uniqueness relaxed to active-only (moved_out phone numbers can be reused), scoped per organization');

  // Messages board columns added after the table's first release — safe to
  // re-run (IF NOT EXISTS), and necessary because CREATE TABLE IF NOT EXISTS
  // above is a no-op on a database that already has the messages table.
  await pool.query(`ALTER TABLE messages ADD COLUMN IF NOT EXISTS admin_only BOOLEAN NOT NULL DEFAULT false`);
  await pool.query(`ALTER TABLE messages ADD COLUMN IF NOT EXISTS edited_at TIMESTAMPTZ`);
  console.log('✓ messages.admin_only / messages.edited_at columns ready');

  const { rows: superRows } = await pool.query(`SELECT id, uid, phone FROM admins WHERE id = $1`, [STARTER_SUPER_ADMIN.id]);
  const a = STARTER_SUPER_ADMIN;
  if (superRows.length === 0) {
    // Only relevant on a fresh install (an upgrade already has its own real
    // Super Admin from before this migration ran). DEFAULT_ORG_ID was
    // resolved/created earlier in this script either way.
    //
    // Guard against a UID/phone collision under DEFAULT_ORG_ID from some
    // OTHER admin row (e.g. one created by hand through the app on a local
    // dev database, or a leftover from an earlier seed with a different id)
    // — that would otherwise crash the whole migration on the unique
    // constraint below with no clue what actually conflicted. Since this is
    // just a convenience starter account, skip it with a clear message
    // instead of failing the entire run over a seed that isn't essential.
    const { rows: clashRows } = await pool.query(
      `SELECT id, uid, phone FROM admins WHERE organization_id = $1 AND (uid = $2 OR phone = $3)`,
      [DEFAULT_ORG_ID, a.uid, a.phone]
    );
    if (clashRows.length > 0) {
      console.log(`• Skipped seeding starter Super Admin — UID '${a.uid}' or phone '${a.phone}' is already used by a different admin (id '${clashRows[0].id}') in the default organization. This is harmless if you already have a working super admin login; if not, either log in with that existing admin or free up UID '${a.uid}'/phone '${a.phone}' and re-run migrate.`);
    } else {
      const passwordHash = bcrypt.hashSync(a.password, 10);
      await pool.query(
        `INSERT INTO admins (id, organization_id, uid, phone, username, password_hash, role, block_code, name)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)`,
        [a.id, DEFAULT_ORG_ID, a.uid, a.phone, a.username, passwordHash, a.role, a.blockCode, a.name]
      );
      console.log(`✓ Created ${a.name} — Hostel ID 'default', starter UID ${a.uid}, phone ${a.phone}`);
    }
  } else if (!superRows[0].uid || !superRows[0].phone) {
    await pool.query(`UPDATE admins SET uid = $2, phone = $3 WHERE id = $1`, [a.id, a.uid, a.phone]);
    console.log(`✓ Backfilled starter UID/phone for ${a.name}`);
  } else {
    console.log(`• ${a.name} already has a UID/phone set — left untouched`);
  }

  // Platform Admin — the account that sits above every hostel. Seeded once,
  // same "only if missing" pattern as the Super Admin above.
  const { rows: platformRows } = await pool.query(`SELECT id FROM platform_admins WHERE id = $1`, [STARTER_PLATFORM_ADMIN.id]);
  if (platformRows.length === 0) {
    const pa = STARTER_PLATFORM_ADMIN;
    const platformPasswordHash = bcrypt.hashSync(pa.password, 10);
    await pool.query(
      `INSERT INTO platform_admins (id, username, password_hash, name) VALUES ($1,$2,$3,$4)`,
      [pa.id, pa.username, platformPasswordHash, pa.name]
    );
    console.log(`✓ Created Platform Admin — username '${pa.username}', starter password '${pa.password}' (CHANGE THIS after first login)`);
  } else {
    console.log('• Platform Admin already exists — left untouched');
  }

  // ---------------------------------------------------------------------
  // ROW-LEVEL SECURITY — second, independent wall against cross-org leaks,
  // on top of the organization_id filter every app query is expected to
  // apply. Deliberately the LAST thing this script does: this connection
  // (plain, unscoped pool.query — no app.org_id set) still needs to run
  // every ordinary INSERT/UPDATE/ALTER above it first. If your DB role does
  // NOT bypass RLS (see the warning below), enabling FORCE ROW LEVEL
  // SECURITY earlier would make this script's OWN later writes fail with a
  // policy violation, since app.org_id is never '' for a real row.
  //
  // Every request from the running app pins the session var app.org_id via
  // db/pool.js's getOrgClient() (see middleware/orgScope.js). If it's ever
  // unset, current_setting(..., true) returns '', matching no real
  // organization_id — so a missing session var denies all rows rather than
  // leaking them.
  //
  // IMPORTANT — verify this is actually enforced for YOUR Supabase
  // connection role: FORCE ROW LEVEL SECURITY makes RLS apply even to the
  // table owner, but a role with the BYPASSRLS attribute (some Supabase
  // roles have this) skips RLS entirely regardless of this setting. Test it
  // directly: run one query as your app's DB user with app.org_id set to a
  // WRONG org and confirm you get zero rows back, not another org's data.
  // ---------------------------------------------------------------------
  const orgOwnedTablesForRls = ['blocks', 'admins', 'tenants', 'rooms', 'settings', 'payments', 'complaints', 'audit_log', 'messages', 'message_votes', 'payment_scanners', 'payment_proofs', 'push_subscriptions'];
  for (const t of orgOwnedTablesForRls) {
    await pool.query(`ALTER TABLE ${t} ENABLE ROW LEVEL SECURITY`);
    await pool.query(`ALTER TABLE ${t} FORCE ROW LEVEL SECURITY`);
    await pool.query(`DROP POLICY IF EXISTS org_isolation ON ${t}`);
    await pool.query(
      `CREATE POLICY org_isolation ON ${t} USING (organization_id = current_setting('app.org_id', true)) WITH CHECK (organization_id = current_setting('app.org_id', true))`
    );
  }
  console.log('✓ Row-Level Security policies applied — TEST these against your Supabase role (see comment above) before onboarding a second organization');

  console.log('\nMigration complete. Log in with the Super Admin starter UID/phone + password,');
  console.log('then create your blocks (and their sub-admins) from the Blocks screen.\n');
  await pool.end();
}

migrate().catch((err) => {
  console.error('Migration failed:', err.message);
  process.exit(1);
});
