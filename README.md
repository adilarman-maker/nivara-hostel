# NIVARA — Hostel Management System

Full-stack app: **Node.js + Express** backend, a real **Postgres** database
(works with Supabase's free tier, or any Postgres host), **JWT** sessions, and
a vanilla HTML/CSS/JS frontend. No build step.

## 1. Set up your database (one-time)

1. Create a free Postgres database — easiest way is [Supabase](https://supabase.com):
   new project → **Project Settings → Database → Connection string → URI** tab
   → copy the **Transaction pooler** string (port `6543`) and fill in your
   database password.
2. Copy `.env.example` to `.env` and paste your connection string in:
   ```
   DATABASE_URL=postgresql://postgres.xxxx:YOUR-PASSWORD@aws-0-xxxx.pooler.supabase.com:6543/postgres
   JWT_SECRET=<generate one — see comment in .env.example>
   ```
3. Create the tables and seed the 5 default admin accounts:
   ```bash
   npm install
   npm run migrate
   ```
   You only need to run `migrate` once per database (running it again is
   safe — it won't duplicate data, it just skips seeding if admins already
   exist).

## 2. Run it

```bash
npm start          # http://localhost:3000
```

## 2. How login works

**Step 1 — everyone enters a UID + phone number.** Every tenant AND every
admin now has their own unique UID + phone (no more shared "gate" — that was
the old design). The server checks it against both the tenants and admins
tables:
- Matches a **tenant** → logs them straight into their tenant dashboard.
- Matches an **admin** → shows a password field (their UID+phone already told
  the server exactly who they are, so there's no username to type).
- Matches neither → rejected.

**Step 2 (admins only) — password.** Confirms it's really them. On success,
the server issues a token carrying their role (`super`/`sub`) and, for
sub-admins, their assigned block — that's what drives every permission check.

### Starter login values (change these immediately)

| Account | Starter UID | Starter phone | Starter password |
|---|---|---|---|
| Super Admin | `00001` | `6302126347` | `Super@123` |
| Sub-Admin — Veera | `90001` | `9000000001` | `Veera@123` |
| Sub-Admin — Dheera | `90002` | `9000000002` | `Dheera@123` |
| Sub-Admin — Shakthi | `90003` | `9000000003` | `Shakthi@123` |
| Sub-Admin — Karuna | `90004` | `9000000004` | `Karuna@123` |

Log in as Super Admin with the starter values above, then go to **Admin
Accounts** and set each admin's real UID/phone/password — including your
own. Nothing is hardcoded anymore; it's all editable from the app.

**Admin UID rule:** always 5 digits, but the **first digit can never be 1-4**
— those are reserved for tenant blocks. This guarantees an admin's UID can
never collide with a real tenant room code. The server enforces this on
every save.

## 3. UID structure (enforced by `db/database.js: parseUid`)

```
 1     0      2  3      1
[Block][Floor][ Room  ][Bed]
  digit  digit  2 digits digit
```

| Digit | Meaning | Valid values |
|---|---|---|
| 1st | Block | `1` Veera (Boys) · `2` Dheera (Boys Premium) · `3` Shakthi (Girls) · `4` Karuna (Lodge) |
| 2nd | Floor | `0`–`9` |
| 3rd–4th | Room number | `01`–`99` |
| 5th | Bed number | `1`–`9` |

Example: `10231` → Veera, Floor 0, Room 23, Bed 1.

Enforced server-side (`routes/tenants.js`):
- UID must match the 5-digit pattern above, or the request is rejected.
- **UID must be globally unique** across all tenants/blocks — the server
  checks this on every create/update.
- **Phone number must also be globally unique.**
- A Sub-Admin can only insert/update/delete tenants whose UID's block digit
  matches their assigned block. The Super Admin has no such restriction.
- Every insert/update/delete is written to an audit log, visible to the
  Super Admin.

## 4. Project layout

```
server.js              Express entry point (loads .env, mounts routes)
db/pool.js               Postgres connection pool (works locally & on Supabase/Vercel)
db/schema.sql             Table definitions
db/migrate.js              Creates tables + seeds default admin accounts — run once
db/database.js             All SQL queries + UID parsing/validation helpers
middleware/auth.js        JWT signing/verification, role & block-permission guards
routes/auth.js             /api/auth/check, /api/auth/admin-login, /api/auth/me
routes/tenants.js          /api/tenants  (list/create/update/delete/validate)
routes/admin.js            /api/admin/summary, /admins (super-admin only)
public/index.html          Login (2-step: UID+phone → admin password)
public/admin.html + js/admin.js   Admin/Sub-admin console (tenants, admin accounts, audit)
public/tenant.html          Tenant's own "keycard" dashboard
public/css/style.css         Design system (see below)
.env.example                  Template for your DATABASE_URL / JWT_SECRET
```

## 5. Design notes

The visual identity treats the 5-digit UID itself as a **keycard** — a dark
chip-styled badge broken into four labeled segments (Block / Floor / Room /
Bed) — reused on the login flow, tenant table rows, and the tenant's own
dashboard, so the numbering scheme is always legible, not just a raw digit
string. Palette pulls from the original Nivara brochure's forest/nature
positioning (deep pine green, sand, a keycard-gold accent) rather than a
generic admin-panel blue. Fonts: **Fraunces** (display), **Work Sans**
(body/UI), **IBM Plex Mono** (all UID/phone digits, for scannability).

## 6. Security notes for production

- Set a real, random `JWT_SECRET` in `.env` (see the generator command in
  `.env.example`) — don't ship the dev fallback.
- Change every starter admin password AND every starter UID/phone
  immediately after your first login (see Part 2 above).
- Never commit `.env` — it's already in `.gitignore`.
- Put this behind HTTPS (Vercel gives you this automatically); add
  rate-limiting on `/api/auth/*` to slow down UID/phone or password guessing.
- Back up your database — Supabase's free tier includes daily backups on some
  plans, but check current limits on their pricing page.

## 7. Performance & monitoring

For load testing, reading production logs, and what to watch in the Vercel
and Supabase dashboards, see **[MONITORING.md](./MONITORING.md)**.

Quick start for a load test against your local dev server:
```bash
npm run loadtest
```

## 8. Online payments (Razorpay)

Tenants can pay their advance/rent directly in the app via card, UPI, or
netbanking, with **automatic confirmation** — no admin has to manually check
whether a payment came through.

**How it works:** when a tenant pays, Razorpay's own servers call a webhook
endpoint (`/api/payments/razorpay/webhook`) directly — this is the
authoritative confirmation, independent of whether the tenant's browser is
even still open. A second, faster confirmation also happens right in the
browser immediately after checkout, purely for instant UI feedback; the
webhook is what actually guarantees correctness.

**Setup (Super Admin only, all from the app — no code editing):**
1. Create a Razorpay account at [razorpay.com](https://razorpay.com) (Test Mode is fine to start)
2. Settings → API Keys → generate a key, save the Key ID and Key Secret
3. Settings → Webhooks → Add New Webhook:
   - URL: paste the URL shown on Nivara's **Payments → Razorpay settings** panel
   - Events: select `payment.captured`
   - Set a Webhook Secret (any long random string) and save it
4. In Nivara, go to **Payments → Razorpay settings** and paste in all three values

Until this is configured, tenants automatically fall back to the UPI QR code
/ manual "I've paid" declaration — nothing breaks if you haven't set this up
yet.

**Security notes:**
- The Key Secret and Webhook Secret are never sent to any browser once
  saved — `GET /api/payments/config` only ever returns the public Key ID.
- The webhook signature is verified with `crypto.timingSafeEqual` against
  the raw request body (not the parsed JSON), matching Razorpay's own
  verification requirements exactly.
- Both the client-side verify endpoint and the webhook are idempotent — if
  both fire for the same payment (normal — that's the redundancy that makes
  this reliable), the second one is a safe no-op, not a double-charge or error.
- Switch from Test Mode keys to Live Mode keys (and update the webhook URL's
  keys accordingly) only once you're ready for real transactions — Razorpay
  requires completing their business KYC first for Live Mode.
