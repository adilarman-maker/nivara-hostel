# GETNESTY — Hostel Management System

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
| 1st | Block | `1`-`9` — whichever blocks the Super Admin has created (see below) |
| 2nd | Floor | `0`–`9` |
| 3rd–4th | Room number | `01`–`99` |
| 5th | Bed number | `1`–`9` |

Example: `10231` → Block 1, Floor 0, Room 23, Bed 1.

Enforced server-side (`routes/tenants.js`):
- UID must match the 5-digit pattern above, or the request is rejected.
- **UID must be globally unique** across all tenants/blocks — the server
  checks this on every create/update.
- **Phone number must also be globally unique.**
- A Sub-Admin can only insert/update/delete tenants whose UID's block digit
  matches their assigned block. The Super Admin has no such restriction.
- Every insert/update/delete is written to an audit log, visible to the
  Super Admin.

## 3a. Blocks are admin-created, not hardcoded

There is **no fixed set of blocks** — the Super Admin creates them from the
**Blocks & Rooms** screen ("+ Create block"), giving each one a name,
address, owner, and description. A block's sub-admin can be set up in that
same step, or added later from **Admin Accounts**.

**Hard limit: 9 blocks total, ever.** Since the block digit is a single
character in the UID (`1`-`9`), that's the absolute ceiling — the app will
refuse to create a 10th block. This is intentional, not a bug — very
unlikely to matter for a real hostel, but worth knowing.

**Admin login UIDs must start with `0`.** Since blocks now occupy every
digit `1`-`9`, `0` is the only digit left that can never be mistaken for a
real tenant room code. This still gives 10,000 possible admin UID
combinations (`00000`-`09999`), more than enough for any number of admins.

**Deleting a block** is blocked if it still has rooms or an assigned
sub-admin — remove/reassign those first. This is a deliberate safety net
against silently orphaning tenant data.

> ⚠️ **If you're updating from an older version of this app** that had the
> fixed Veera/Dheera/Shakthi/Karuna blocks: running `npm run migrate` will
> **wipe all rooms, tenants, payments, and complaints**, and remove those 4
> sub-admin accounts (the Super Admin account is kept). This runs
> automatically, exactly once, the first time you migrate to this version —
> back up your database first if you want to keep that data.

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
string. Palette pulls from the original Getnesty brochure's forest/nature
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

## 8. Manual payment confirmation

There's no payment gateway in this app — tenants pay via a UPI/bank scanner
the Super Admin sets up, then upload proof; an admin reviews it and confirms
it themselves. No transaction fees, no gateway account, no KYC — the
trade-off is that confirmation takes a human, not milliseconds.

**Setup (Super Admin only, all from the app):**
1. Go to **Payments → Payment scanners**
2. Add a scanner: account holder name, UPI ID or bank details, a QR code
   image, and a contact phone number
3. Choose its scope — either the whole hostel, or one specific block (a
   block can have its own collection account; anything without a
   block-specific scanner falls back to the whole-hostel one)

**How it works, end to end:**
1. A tenant sees their applicable scanner on their dashboard, scans it, pays
2. They upload a screenshot along with the UTR/reference number, date paid,
   and amount — this creates a submission with status `pending`, and does
   **not** mark anything paid yet
3. It appears under **Payments → Payment confirmations** for the admin
   (Super Admin sees everyone's; a Sub Admin only sees their own block's)
4. The admin reviews the screenshot, can adjust the amount if it doesn't
   exactly match what was typed, then confirms or rejects it
5. Confirming immediately marks the tenant's due paid (or partially paid, if
   the confirmed amount is less than what's owed) and updates the dues/
   collection totals on the admin's own screen right away, since that's the
   same request-response cycle

**How the tenant sees it update without refreshing:** the tenant's dashboard
polls their own submission status every 6 seconds *only* while one is
pending — not continuously, and not for anyone else's data. The moment an
admin confirms it, the next poll picks up the change and shows a short
confirmation animation before refreshing their dues. This is polling, not a
real-time push connection — there's a few seconds of latency, not
instant, but no websocket infrastructure to run either.
