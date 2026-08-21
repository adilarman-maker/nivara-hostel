-- NIVARA schema. Run once via `npm run migrate`.

CREATE TABLE IF NOT EXISTS admins (
  id            TEXT PRIMARY KEY,
  uid           CHAR(5) UNIQUE,        -- admin's own individual login UID
  phone         CHAR(10) UNIQUE,       -- admin's own individual login phone
  username      TEXT UNIQUE NOT NULL,
  password_hash TEXT NOT NULL,
  role          TEXT NOT NULL CHECK (role IN ('super', 'sub')),
  block_code    INTEGER,               -- NULL for super admin, 1-4 for sub-admins
  name          TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS tenants (
  id           TEXT PRIMARY KEY,
  uid          CHAR(5) UNIQUE NOT NULL,
  phone        CHAR(10) UNIQUE NOT NULL,
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
  created_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at   TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- A room is a physical slot that can exist BEFORE any tenant is assigned to
-- it — created in bulk via "Add floor". bed_count is how many bed slots
-- currently exist in that room; the "+" button in the UI increments it.
CREATE TABLE IF NOT EXISTS rooms (
  id           TEXT PRIMARY KEY,
  block_code   INTEGER NOT NULL CHECK (block_code BETWEEN 1 AND 4),
  floor_number INTEGER NOT NULL CHECK (floor_number BETWEEN 0 AND 9),
  room_number  INTEGER NOT NULL CHECK (room_number BETWEEN 1 AND 99),
  bed_count    INTEGER NOT NULL DEFAULT 1 CHECK (bed_count BETWEEN 1 AND 9),
  created_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (block_code, floor_number, room_number)
);

-- Kept for forward-compatibility / general key-value settings; no longer
-- used for admin gates now that every admin has their own individual UID+phone.
-- Also stores the 'paymentConfig' key (UPI id, payee name, advance amount,
-- monthly rent per sharing size).
CREATE TABLE IF NOT EXISTS settings (
  key   TEXT PRIMARY KEY,
  value JSONB NOT NULL
);

-- One row per tenant per calendar month (period = 'YYYY-MM'). The first
-- period a tenant is created in gets the one-time advance amount (type
-- 'advance'); every period after that gets their monthly_rent (type 'rent').
CREATE TABLE IF NOT EXISTS payments (
  id                TEXT PRIMARY KEY,
  tenant_id         TEXT NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  period            CHAR(7) NOT NULL,           -- e.g. '2026-08'
  amount            NUMERIC NOT NULL,
  type              TEXT NOT NULL DEFAULT 'rent' CHECK (type IN ('advance', 'rent')),
  status            TEXT NOT NULL DEFAULT 'due' CHECK (status IN ('due', 'paid')),
  method            TEXT DEFAULT '',            -- 'self_declared' | 'admin_marked' | 'razorpay'
  gateway_order_id  TEXT,                       -- Razorpay order id, set when checkout starts
  gateway_payment_id TEXT,                      -- Razorpay payment id, set once paid
  paid_at           TIMESTAMPTZ,
  created_at        TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, period)
);

-- Tenant complaints. Visible to the Super Admin and the tenant's own block admin.
CREATE TABLE IF NOT EXISTS complaints (
  id          TEXT PRIMARY KEY,
  tenant_id   TEXT NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  message     TEXT NOT NULL,
  status      TEXT NOT NULL DEFAULT 'open' CHECK (status IN ('open', 'resolved')),
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  resolved_at TIMESTAMPTZ
);

CREATE TABLE IF NOT EXISTS audit_log (
  id      SERIAL PRIMARY KEY,
  ts      TIMESTAMPTZ NOT NULL DEFAULT now(),
  by_name TEXT NOT NULL,
  action  TEXT NOT NULL,
  details TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_tenants_uid ON tenants(uid);
CREATE INDEX IF NOT EXISTS idx_tenants_phone ON tenants(phone);
CREATE INDEX IF NOT EXISTS idx_audit_ts ON audit_log(ts DESC);
CREATE INDEX IF NOT EXISTS idx_rooms_block_floor ON rooms(block_code, floor_number);
CREATE INDEX IF NOT EXISTS idx_payments_tenant ON payments(tenant_id);
CREATE INDEX IF NOT EXISTS idx_payments_period ON payments(period);
CREATE INDEX IF NOT EXISTS idx_payments_status ON payments(status);
-- Note: idx_payments_gateway_order is created in migrate.js AFTER the
-- ALTER TABLE step, since older databases won't have gateway_order_id yet
-- when this file first runs against them (same reasoning as admins.uid above).
CREATE INDEX IF NOT EXISTS idx_complaints_tenant ON complaints(tenant_id);
CREATE INDEX IF NOT EXISTS idx_complaints_status ON complaints(status);
-- Note: admins.uid / admins.phone indexes are created in migrate.js AFTER
-- the ALTER TABLE step, since older databases won't have those columns yet
-- when this file first runs against them. Same reasoning applies to the
-- new tenants profile columns (college/hometown/parent_phone/age/gender) —
-- migrate.js ALTER-TABLEs those in too, for anyone upgrading an existing DB.
