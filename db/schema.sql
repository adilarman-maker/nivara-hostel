-- GETNESTLY schema. Run once via `npm run migrate`.

-- Platform Admin — a tier ABOVE every hostel, not inside any of them.
-- Deliberately has NO organization_id and is never touched through the
-- org-scoped RLS client (see middleware/orgScope.js) — platform routes
-- query it through the plain, unscoped pool, same as the login-time
-- lookups in db/database.js. This is what lets Adil (or whoever he
-- delegates) create/deactivate/delete hostels across the whole platform.
-- Login is separate from everyone else's: username + password only, no
-- Hostel ID — see public/platform.html + routes/platform.js.
CREATE TABLE IF NOT EXISTS platform_admins (
  id            TEXT PRIMARY KEY,
  username      TEXT UNIQUE NOT NULL,
  password_hash TEXT NOT NULL,
  name          TEXT NOT NULL,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Multi-tenant root. Every other table hangs off organization_id so one
-- Vercel deployment + one Supabase database can serve many hostel
-- businesses at once, isolated from each other by Postgres RLS (see the
-- bottom of this file) AND by an organization_id filter in every app query.
-- id is app-generated (e.g. 'o-' + random), matching the id style used
-- elsewhere in this codebase (tenants: 't-...', admins: 'a-...').
-- slug is the human-facing "Hostel ID" typed at login (Step 1, alongside
-- UID + phone) — short, memorable, chosen by the hostel owner at onboarding,
-- globally unique since it's what resolves "which organization" BEFORE we
-- know anything else about the person logging in.
CREATE TABLE IF NOT EXISTS organizations (
  id         TEXT PRIMARY KEY,
  slug       TEXT UNIQUE NOT NULL,
  name       TEXT NOT NULL,
  active     BOOLEAN NOT NULL DEFAULT true,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Blocks are admin-created (not hardcoded). The block "code" is a single
-- digit 1-9 because the tenant UID scheme encodes block as its first digit —
-- this caps EACH ORGANIZATION at 9 total blocks ever (intentional, not a
-- bug). Admin login UIDs are required to start with 0 specifically so they
-- can never collide with a real block digit.
-- PRIMARY KEY is composite (organization_id, code) — two different hostels
-- both having a "Block 1" is expected and must not collide.
CREATE TABLE IF NOT EXISTS blocks (
  organization_id TEXT NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  code        TEXT NOT NULL CHECK (code ~ '^[1-9]$'),
  name        TEXT NOT NULL,
  address     TEXT DEFAULT '',
  owner       TEXT DEFAULT '',
  description TEXT DEFAULT '',
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (organization_id, code)
);

-- admins.uid and admins.phone are unique PER ORGANIZATION now, not globally
-- — login is Hostel ID (organizations.slug) + UID + phone, so the Hostel ID
-- already tells us which organization before UID/phone are even checked.
-- See db/database.js findAdminByUidPhone / routes/auth.js.
CREATE TABLE IF NOT EXISTS admins (
  id              TEXT PRIMARY KEY,
  organization_id TEXT NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  uid           CHAR(5),               -- admin's own individual login UID (unique within the org)
  phone         CHAR(10),              -- admin's own individual login phone (unique within the org)
  username      TEXT NOT NULL,         -- not used for login (kept because NOT NULL); == uid, so scoped per org too
  password_hash TEXT NOT NULL,
  role          TEXT NOT NULL CHECK (role IN ('super', 'sub')),
  block_code    TEXT, -- NULL for super admin; composite FK to blocks added below
  name          TEXT NOT NULL,
  -- Payment-confirmation permission grant for sub-admins, set by the Super Admin
  -- (see routes/admin.js PUT /admins/:id/payment-scope). NULL/empty = no access
  -- (default — only the Super Admin can confirm payments). ['*'] = all blocks.
  -- ['1','3'] = confirmation access limited to those specific blocks. Ignored
  -- entirely for role='super', who always has full access.
  payment_confirm_blocks TEXT[],
  FOREIGN KEY (organization_id, block_code) REFERENCES blocks(organization_id, code) ON DELETE SET NULL,
  UNIQUE (organization_id, uid),
  UNIQUE (organization_id, phone),
  UNIQUE (organization_id, username)
);

-- tenants.phone is likewise unique PER ORGANIZATION now, not globally — same
-- Hostel-ID-first login resolution as admins above.
CREATE TABLE IF NOT EXISTS tenants (
  id           TEXT PRIMARY KEY,
  organization_id TEXT NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  uid          CHAR(5) NOT NULL,
  phone        CHAR(10) NOT NULL,
  name         TEXT NOT NULL,
  email        TEXT DEFAULT '',
  notes        TEXT DEFAULT '',
  college      TEXT DEFAULT '',
  hometown     TEXT DEFAULT '',
  parent_phone TEXT DEFAULT '',
  age          INTEGER,
  gender       TEXT DEFAULT '',
  monthly_rent NUMERIC,        -- set explicitly by the admin who added them; overrides the bed-count default
  advance_amount NUMERIC,      -- one-time amount set explicitly by the admin at move-in
  -- Lifecycle: 'booked' = advance paid to hold the bed, hasn't moved in yet
  -- (join_date is in the future); 'active' = currently residing; 'moved_out'
  -- = past vacate_date. A daily lazy sync (see syncTenantLifecycle in
  -- db/database.js — no cron needed) flips booked->active and active->moved_out
  -- automatically. uid is intentionally NOT globally unique anymore — see
  -- the partial index below — so a moved-out tenant's bed can be rebooked
  -- under the same UID while their own row (and payment history) survives.
  status       TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('booked', 'active', 'moved_out')),
  join_date    DATE NOT NULL DEFAULT CURRENT_DATE,
  vacate_date  DATE,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at   TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Only ONE currently-relevant (booked or active) tenant may hold a given UID
-- at a time; any number of moved_out tenants can have held it historically.
-- Note: the uid partial-unique index (tenants_uid_active_unique) is created
-- in migrate.js, AFTER the status column is guaranteed to exist on both
-- fresh installs and upgrades from an older database — creating it here
-- would fail on any existing database, since CREATE TABLE IF NOT EXISTS is
-- a no-op there and status wouldn't exist yet when this file runs.

-- A room is a physical slot that can exist BEFORE any tenant is assigned to
-- it — created in bulk via "Add floor". bed_count is how many bed slots
-- currently exist in that room; the "+" button in the UI increments it.
CREATE TABLE IF NOT EXISTS rooms (
  id           TEXT PRIMARY KEY,
  organization_id TEXT NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  block_code   TEXT NOT NULL,
  floor_number INTEGER NOT NULL CHECK (floor_number BETWEEN 0 AND 9),
  room_number  INTEGER NOT NULL CHECK (room_number BETWEEN 1 AND 99),
  bed_count    INTEGER NOT NULL DEFAULT 1 CHECK (bed_count BETWEEN 1 AND 9),
  -- Specific bed NUMBERS that have been individually removed (e.g. bed 1
  -- deleted while beds 2/3 stay occupied). We never renumber existing beds
  -- to close the gap, because a tenant's UID literally encodes their bed
  -- number as its 5th digit — shifting numbers would silently change a
  -- tenant's login credentials. A later "add bed" refills the smallest
  -- gap here before growing bed_count further.
  removed_beds INTEGER[] NOT NULL DEFAULT '{}',
  created_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (organization_id, block_code, floor_number, room_number),
  FOREIGN KEY (organization_id, block_code) REFERENCES blocks(organization_id, code) ON DELETE RESTRICT
);

-- Kept for forward-compatibility / general key-value settings; no longer
-- used for admin gates now that every admin has their own individual UID+phone.
-- Also stores the 'paymentConfig' key (UPI id, payee name, advance amount,
-- monthly rent per sharing size) — PER ORGANIZATION now, since each hostel
-- business sets its own UPI id and rent tiers.
CREATE TABLE IF NOT EXISTS settings (
  organization_id TEXT NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  key   TEXT NOT NULL,
  value JSONB NOT NULL,
  PRIMARY KEY (organization_id, key)
);

-- One row per tenant per calendar month PER TYPE — a tenant can have BOTH
-- an 'advance' row and a 'rent' row in the same month (e.g. the month they
-- move in: advance is due immediately, and rent for that same month is due
-- too). The unique constraint is (tenant, period, type), not just
-- (tenant, period), specifically so these two don't collide with each other.
CREATE TABLE IF NOT EXISTS payments (
  id                TEXT PRIMARY KEY,
  organization_id   TEXT NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  tenant_id         TEXT NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  period            CHAR(7) NOT NULL,           -- e.g. '2026-08'
  amount            NUMERIC NOT NULL,           -- total amount due for this period
  amount_paid       NUMERIC NOT NULL DEFAULT 0, -- running total actually received (supports partial/cash payments)
  type              TEXT NOT NULL DEFAULT 'rent' CHECK (type IN ('advance', 'rent')),
  status            TEXT NOT NULL DEFAULT 'due' CHECK (status IN ('due', 'partial', 'paid')),
  method            TEXT DEFAULT '',            -- 'upi_manual' | 'cash' | 'bank_transfer' | 'other' | 'admin_marked'
  gateway_order_id  TEXT,                       -- unused leftover from the removed Razorpay integration; left in place rather than risking a DROP COLUMN migration for zero benefit
  gateway_payment_id TEXT,                      -- same as above
  paid_at           TIMESTAMPTZ,
  created_at        TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, period, type)
);

-- Tenant complaints. Visible to the Super Admin and the tenant's own block admin.
CREATE TABLE IF NOT EXISTS complaints (
  id          TEXT PRIMARY KEY,
  organization_id TEXT NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  tenant_id   TEXT NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  message     TEXT NOT NULL,
  status      TEXT NOT NULL DEFAULT 'open' CHECK (status IN ('open', 'resolved')),
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  resolved_at TIMESTAMPTZ
);

CREATE TABLE IF NOT EXISTS audit_log (
  id      SERIAL PRIMARY KEY,
  organization_id TEXT NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  ts      TIMESTAMPTZ NOT NULL DEFAULT now(),
  by_name TEXT NOT NULL,
  action  TEXT NOT NULL,
  details TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_tenants_uid ON tenants(uid);
CREATE INDEX IF NOT EXISTS idx_tenants_phone ON tenants(phone);
-- Every login lookup filters on exactly these three columns together
-- (organization_id, uid, phone) — this is the single most-executed query
-- in the whole app, so it gets its own composite index rather than relying
-- on the single-column ones above to be combined efficiently.
CREATE INDEX IF NOT EXISTS idx_tenants_org_uid_phone ON tenants(organization_id, uid, phone);
CREATE INDEX IF NOT EXISTS idx_tenants_org_status ON tenants(organization_id, status);
CREATE INDEX IF NOT EXISTS idx_audit_ts ON audit_log(ts DESC);
CREATE INDEX IF NOT EXISTS idx_audit_org_ts ON audit_log(organization_id, ts DESC);
CREATE INDEX IF NOT EXISTS idx_rooms_block_floor ON rooms(block_code, floor_number);
CREATE INDEX IF NOT EXISTS idx_payments_tenant ON payments(tenant_id);
CREATE INDEX IF NOT EXISTS idx_payments_period ON payments(period);
CREATE INDEX IF NOT EXISTS idx_payments_status ON payments(status);
-- organization_id indexes (idx_blocks_org, idx_admins_org, idx_tenants_org,
-- idx_rooms_org, idx_payments_org, idx_complaints_org, idx_messages_org, and
-- the org-aware version of idx_rooms_block_floor) are created in
-- db/migrate.js instead of here — this file runs its CREATE TABLE
-- statements as IF NOT EXISTS (a no-op on a database that predates
-- organization_id), but a bare CREATE INDEX has no such guard and would
-- fail immediately on that column not existing yet. migrate.js creates
-- them once organization_id is guaranteed to exist everywhere.
-- Note: idx_payments_gateway_order is created in migrate.js AFTER the
-- ALTER TABLE step, since older databases won't have gateway_order_id yet
-- when this file first runs against them (same reasoning as admins.uid above).
CREATE INDEX IF NOT EXISTS idx_complaints_tenant ON complaints(tenant_id);
CREATE INDEX IF NOT EXISTS idx_complaints_status ON complaints(status);

-- Messages / announcements board. Only admins can create messages (see
-- routes/messages.js); tenants and other admins can only read within their
-- visibility scope. scope_block = NULL means "visible to the whole hostel,
-- every block" (only a Super Admin can post one of these); a specific block
-- code means "visible only within that block" (what a sub-admin posts, and
-- what a tenant of that block can see).
CREATE TABLE IF NOT EXISTS messages (
  id             TEXT PRIMARY KEY,
  organization_id TEXT NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  sender_id      TEXT NOT NULL,
  sender_name    TEXT NOT NULL,
  sender_role    TEXT NOT NULL CHECK (sender_role IN ('super', 'sub')),
  scope_block    TEXT, -- NULL = all blocks; composite FK to blocks added below
  admin_only     BOOLEAN NOT NULL DEFAULT false, -- true = never visible to tenants, only admins ("Admin team" channel)
  type           TEXT NOT NULL CHECK (type IN ('text', 'image', 'poll', 'contact')),
  body           TEXT DEFAULT '',           -- message text / image caption
  image_data     TEXT,                      -- base64 data URI, resized+compressed client-side before send
  poll_question  TEXT,
  poll_options   JSONB,                     -- array of option strings, e.g. ["Friday","Saturday"]
  contact_name   TEXT,
  contact_phone  TEXT,
  edited_at      TIMESTAMPTZ,               -- set when the sender edits body/poll/contact after posting
  created_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
  FOREIGN KEY (organization_id, scope_block) REFERENCES blocks(organization_id, code) ON DELETE CASCADE
);

-- One vote per person per poll. voter_key is "tenant:<id>" or "admin:<id>"
-- so tenants and admins share one uniqueness rule without two tables.
-- organization_id is denormalized here (copied from the parent message at
-- insert time) purely so its RLS policy doesn't need a join.
CREATE TABLE IF NOT EXISTS message_votes (
  id           SERIAL PRIMARY KEY,
  organization_id TEXT NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  message_id   TEXT NOT NULL REFERENCES messages(id) ON DELETE CASCADE,
  voter_key    TEXT NOT NULL,
  voter_name   TEXT NOT NULL DEFAULT '',
  option_index INTEGER NOT NULL,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (message_id, voter_key)
);

CREATE INDEX IF NOT EXISTS idx_messages_scope_created ON messages(scope_block, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_message_votes_message ON message_votes(message_id);

-- ===================== Manual payment confirmation =====================
-- Replaces the earlier Razorpay integration entirely: tenants pay via a
-- UPI/bank scanner the Super Admin configures, then upload proof; a human
-- (Super Admin or the tenant's own Sub Admin) reviews and confirms it.
--
-- One scanner can cover the whole hostel (scope_block IS NULL) or be
-- specific to one block (e.g. a different collection account per block
-- owner). A tenant's applicable scanner is: their own block's scanner if
-- one is set, otherwise the whole-hostel one — see db/database.js
-- getScannerForBlock. The two partial unique indexes below enforce "at
-- most one global scanner" and "at most one scanner per block" — a plain
-- UNIQUE(organization_id, scope_block) wouldn't work here since SQL NULLs
-- are never considered equal to each other, so it wouldn't actually stop
-- two global (NULL) scanners from being created.
CREATE TABLE IF NOT EXISTS payment_scanners (
  id              TEXT PRIMARY KEY,
  organization_id TEXT NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  scope_block     TEXT,
  account_name    TEXT NOT NULL,
  account_details TEXT NOT NULL DEFAULT '',
  qr_image        TEXT NOT NULL DEFAULT '',
  contact_phone   TEXT NOT NULL DEFAULT '',
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now()
  -- NOTE: the (organization_id, scope_block) -> blocks(organization_id, code)
  -- foreign key is deliberately NOT declared here — this table is brand new,
  -- so this CREATE TABLE actually executes even against an existing
  -- database, before that database's `blocks` table has necessarily been
  -- fixed up to have a composite (organization_id, code) key yet. Added
  -- instead via ALTER TABLE in db/migrate.js, after that's guaranteed.
);
CREATE UNIQUE INDEX IF NOT EXISTS payment_scanners_global_unique ON payment_scanners(organization_id) WHERE scope_block IS NULL;
CREATE UNIQUE INDEX IF NOT EXISTS payment_scanners_block_unique ON payment_scanners(organization_id, scope_block) WHERE scope_block IS NOT NULL;

-- One row per device/browser that's granted notification permission. A
-- person can have several (phone + laptop), so this is keyed by the
-- browser's own subscription endpoint, not one-per-user.
CREATE TABLE IF NOT EXISTS push_subscriptions (
  id              TEXT PRIMARY KEY,
  organization_id TEXT NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  user_type       TEXT NOT NULL CHECK (user_type IN ('tenant','admin')),
  user_id         TEXT NOT NULL,
  block_code      TEXT, -- the admin's block at subscribe time, NULL for super admins/tenants — lets a proof/complaint notification target only the relevant sub-admins without a join
  endpoint        TEXT NOT NULL,
  p256dh          TEXT NOT NULL,
  auth            TEXT NOT NULL,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX IF NOT EXISTS push_subs_endpoint_unique ON push_subscriptions(organization_id, endpoint);
CREATE INDEX IF NOT EXISTS push_subs_lookup ON push_subscriptions(organization_id, user_type, user_id);

-- One row per screenshot a tenant uploads against one of their own due
-- payments (db/database.js payments table). status starts 'pending' and is
-- the ONLY thing that actually marks the underlying payment paid — see
-- approveProof in db/database.js. A tenant can't have two pending proofs
-- open on the same payment at once (checked in routes/payments.js, not
-- enforced here in SQL, since "pending" isn't the row's whole identity).
CREATE TABLE IF NOT EXISTS payment_proofs (
  id              TEXT PRIMARY KEY,
  organization_id TEXT NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  payment_id      TEXT NOT NULL REFERENCES payments(id) ON DELETE CASCADE,
  tenant_id       TEXT NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  screenshot      TEXT NOT NULL,
  utr_reference   TEXT NOT NULL DEFAULT '',
  paid_date       TIMESTAMP,
  claimed_amount  NUMERIC(10,2) NOT NULL,
  status          TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'approved', 'rejected')),
  admin_note      TEXT NOT NULL DEFAULT '',
  submitted_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  reviewed_at     TIMESTAMPTZ,
  reviewed_by     TEXT
);
CREATE INDEX IF NOT EXISTS idx_payment_proofs_org_status ON payment_proofs(organization_id, status);
CREATE INDEX IF NOT EXISTS idx_payment_proofs_payment ON payment_proofs(payment_id);
CREATE INDEX IF NOT EXISTS idx_payment_proofs_tenant ON payment_proofs(tenant_id);

-- Row-Level Security is NOT set up here. This file runs (via CREATE TABLE
-- IF NOT EXISTS) against existing databases too, where the organization_id
-- column doesn't exist until db/migrate.js's multi-tenant migration block
-- backfills it — a policy referencing that column would fail on that first
-- pass. See ENABLE_RLS_SQL in db/migrate.js, which runs once organization_id
-- is guaranteed to exist everywhere, on both fresh and upgraded databases.
