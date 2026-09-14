// ============================================================================
// GETNESTY — SMOKE TEST SUITE
// ============================================================================
// What this is: a small set of end-to-end checks that hit your ACTUAL running
// server over HTTP, the same way a browser would — not mocks, not stubs.
// They create a real (temporary) test hostel, log in as a real tenant and a
// real admin, and walk through the real flows: login, payments, permissions,
// rooms. At the end, the test hostel is deleted again.
//
// What this catches: the class of bug we hit this week — a login response
// silently missing a field, a permission check that's too loose or too
// strict, a route that forgot to check who's allowed to do something. It does
// NOT catch visual/CSS bugs (like a button becoming invisible on a phone) —
// that needs an actual browser looking at actual pixels, which is a
// different, heavier kind of test. This is the fast, cheap layer underneath
// that one.
//
// HOW TO RUN THIS:
//   1. Start your server locally:      npm start
//   2. In another terminal, run:       npm test
//   (or: node --test tests/)
//
// Needs a real database behind your local server — run this against your
// DEV database, never production, since it creates and deletes real rows
// (in its own temporary test organization, never touching your real hostels).
//
// Environment variables (all optional, sensible defaults shown):
//   TEST_BASE_URL              default http://localhost:3000
//   TEST_PLATFORM_USERNAME     default platform-owner
//   TEST_PLATFORM_PASSWORD     default ChangeMe@123
// ============================================================================

const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { req, buildUid, TINY_PNG_BASE64 } = require('./helpers');

const PLATFORM_USERNAME = process.env.TEST_PLATFORM_USERNAME || 'platform-owner';
const PLATFORM_PASSWORD = process.env.TEST_PLATFORM_PASSWORD || 'ChangeMe@123';

// Unique every run, so tests never collide with a previous (or concurrent) run.
const RUN_ID = Date.now().toString(36);
const TEST_SLUG = `smoketest-${RUN_ID}`;
const SUPER_UID = '00001';
const SUPER_PHONE = '9000000001';
const SUPER_PASSWORD = 'Test@12345';

// Shared state, filled in as the tests run in order.
let platformToken;
let testOrgId;
let superToken;
let blockCode;
let tenantAUid, tenantAId;

function decodeJwtPayload(token) {
  const payload = token.split('.')[1];
  return JSON.parse(Buffer.from(payload, 'base64url').toString('utf8'));
}

before(async () => {
  const login = await req('/platform/login', { method: 'POST', body: { username: PLATFORM_USERNAME, password: PLATFORM_PASSWORD } });
  assert.equal(login.status, 200, `Platform login failed — is the server running, and are TEST_PLATFORM_USERNAME/PASSWORD correct? ${JSON.stringify(login.data)}`);
  platformToken = login.data.token;

  const create = await req('/platform/organizations', {
    method: 'POST', token: platformToken,
    body: {
      name: `Smoke Test Hostel ${RUN_ID}`, slug: TEST_SLUG,
      superAdminName: 'Test Super Admin', superAdminUid: SUPER_UID,
      superAdminPhone: SUPER_PHONE, superAdminPassword: SUPER_PASSWORD,
    },
  });
  assert.equal(create.status, 201, `Failed to create test organization: ${JSON.stringify(create.data)}`);
  testOrgId = create.data.organization.id;
});

after(async () => {
  // Always clean up, even if a test above failed — leaving temp test
  // hostels behind would clutter your real Platform Registry.
  if (testOrgId && platformToken) {
    await req(`/platform/organizations/${testOrgId}`, { method: 'DELETE', token: platformToken });
  }
});

test('Super Admin can log in to the freshly created hostel', async () => {
  const check = await req('/auth/check', { method: 'POST', body: { hostelId: TEST_SLUG, uid: SUPER_UID, phone: SUPER_PHONE } });
  assert.equal(check.status, 200);
  assert.equal(check.data.mode, 'admin_verify');

  const login = await req('/auth/admin-login', { method: 'POST', body: { hostelId: TEST_SLUG, uid: SUPER_UID, phone: SUPER_PHONE, password: SUPER_PASSWORD } });
  assert.equal(login.status, 200, JSON.stringify(login.data));
  assert.ok(login.data.token);
  superToken = login.data.token;
});

test('Super Admin can create a block, a floor, and a tenant', async () => {
  const block = await req('/blocks', { method: 'POST', token: superToken, body: { name: 'Test Block' } });
  assert.equal(block.status, 201, JSON.stringify(block.data));
  blockCode = block.data.block.code;

  const floor = await req('/rooms/floor', { method: 'POST', token: superToken, body: { blockCode, floorNumber: 1, roomCount: 1 } });
  assert.equal(floor.status, 201, JSON.stringify(floor.data));
  const roomNumber = floor.data.rooms[0].roomNumber;

  tenantAUid = buildUid(blockCode, 1, roomNumber, 1);
  const tenant = await req('/tenants', {
    method: 'POST', token: superToken,
    body: { uid: tenantAUid, phone: '9111111111', name: 'Test Tenant A', advanceAmount: 1000, monthlyRent: 5000 },
  });
  assert.equal(tenant.status, 201, JSON.stringify(tenant.data));
  tenantAId = tenant.data.tenant.id;
});

// This is a direct regression test for the exact bug we shipped and had to
// fix this week: a tenant's login token silently missing organizationId,
// which made every org-scoped page (payments, announcements, stay details)
// fail with "No organization context" right after a successful-looking login.
test('REGRESSION: tenant login token actually carries an organization', async () => {
  const check = await req('/auth/check', { method: 'POST', body: { hostelId: TEST_SLUG, uid: tenantAUid, phone: '9111111111' } });
  assert.equal(check.status, 200, JSON.stringify(check.data));
  assert.equal(check.data.mode, 'tenant');
  assert.ok(check.data.token, 'Login succeeded but returned no token at all');

  const payload = decodeJwtPayload(check.data.token);
  assert.ok(payload.organizationId, 'Tenant token is missing organizationId — this is exactly the bug that broke payments/announcements/stay-details this week');

  // And prove it actually works end-to-end, not just that the field exists:
  const org = await req('/auth/organization', { token: check.data.token });
  assert.equal(org.status, 200, `A tenant with a token should be able to fetch their org name, got: ${JSON.stringify(org.data)}`);
  assert.ok(org.data.name);
});

test('Tenant can see the hostel-wide payment scanner', async () => {
  const scanner = await req('/payments/scanners', {
    method: 'POST', token: superToken,
    body: { accountName: 'Test Hostel Owner', accountDetails: 'UPI: test@upi', contactPhone: '9000000000' },
  });
  assert.equal(scanner.status, 201, JSON.stringify(scanner.data));

  const check = await req('/auth/check', { method: 'POST', body: { hostelId: TEST_SLUG, uid: tenantAUid, phone: '9111111111' } });
  const tenantToken = check.data.token;

  const seen = await req('/payments/scanner', { token: tenantToken });
  assert.equal(seen.status, 200, JSON.stringify(seen.data));
  assert.equal(seen.data.scanner.accountName, 'Test Hostel Owner');
});

test('Tenant can submit a payment proof, and Super Admin confirming it clears the due', async () => {
  const check = await req('/auth/check', { method: 'POST', body: { hostelId: TEST_SLUG, uid: tenantAUid, phone: '9111111111' } });
  const tenantToken = check.data.token;

  const before1 = await req('/payments/me', { token: tenantToken });
  assert.equal(before1.status, 200);
  assert.ok(before1.data.dues.length > 0, 'Expected at least one due (the advance payment) right after tenant creation');
  const duePaymentId = before1.data.dues[0].id;

  const submit = await req(`/payments/${duePaymentId}/submit-proof`, {
    method: 'POST', token: tenantToken,
    body: { screenshot: TINY_PNG_BASE64, utrReference: 'TESTUTR123', paidDate: new Date().toISOString().slice(0, 16), claimedAmount: 1000 },
  });
  assert.equal(submit.status, 201, JSON.stringify(submit.data));
  const proofId = submit.data.proof.id;

  const pending = await req('/payments/proofs/pending', { token: superToken });
  assert.equal(pending.status, 200);
  assert.ok(pending.data.proofs.some((p) => p.id === proofId), 'Submitted proof should appear in the Super Admin\'s pending list');

  const approve = await req(`/payments/proofs/${proofId}/approve`, { method: 'POST', token: superToken, body: {} });
  assert.equal(approve.status, 200, JSON.stringify(approve.data));

  const after1 = await req('/payments/me', { token: tenantToken });
  const stillDue = after1.data.dues.find((d) => d.id === duePaymentId);
  assert.ok(!stillDue || stillDue.remaining <= 0, 'Due should be cleared (or reduced to zero) after the Super Admin approves the proof');
});

test('A sub-admin cannot confirm payments until explicitly granted access, then can', async () => {
  // Second tenant + a fresh due, so this test doesn't depend on the previous one's state.
  const room = await req('/rooms/floor', { method: 'POST', token: superToken, body: { blockCode, floorNumber: 2, roomCount: 1 } });
  assert.equal(room.status, 201, JSON.stringify(room.data));
  const uidB = buildUid(blockCode, 2, room.data.rooms[0].roomNumber, 1);
  const tenantB = await req('/tenants', {
    method: 'POST', token: superToken,
    body: { uid: uidB, phone: '9222222222', name: 'Test Tenant B', advanceAmount: 1000, monthlyRent: 5000 },
  });
  assert.equal(tenantB.status, 201, JSON.stringify(tenantB.data));

  const subCreate = await req('/admin/admins', {
    method: 'POST', token: superToken,
    body: { uid: '00002', phone: '9333333333', password: 'SubPass@1', name: 'Test Sub Admin', blockCode },
  });
  assert.equal(subCreate.status, 201, JSON.stringify(subCreate.data));
  const subAdminId = subCreate.data.admin.id;

  const subCheck = await req('/auth/check', { method: 'POST', body: { hostelId: TEST_SLUG, uid: '00002', phone: '9333333333' } });
  const subLogin = await req('/auth/admin-login', { method: 'POST', body: { hostelId: TEST_SLUG, uid: '00002', phone: '9333333333', password: 'SubPass@1' } });
  assert.equal(subLogin.status, 200, JSON.stringify(subLogin.data));
  const subToken = subLogin.data.token;

  const tenantBCheck = await req('/auth/check', { method: 'POST', body: { hostelId: TEST_SLUG, uid: uidB, phone: '9222222222' } });
  const tenantBToken = tenantBCheck.data.token;
  const dues = await req('/payments/me', { token: tenantBToken });
  const submit = await req(`/payments/${dues.data.dues[0].id}/submit-proof`, {
    method: 'POST', token: tenantBToken,
    body: { screenshot: TINY_PNG_BASE64, utrReference: 'TESTUTR456', paidDate: new Date().toISOString().slice(0, 16), claimedAmount: 1000 },
  });
  const proofId = submit.data.proof.id;

  // Before any grant: sub-admin must be refused.
  const deniedAttempt = await req(`/payments/proofs/${proofId}/approve`, { method: 'POST', token: subToken, body: {} });
  assert.equal(deniedAttempt.status, 403, 'A sub-admin with no payment-confirmation grant should be refused, not allowed through');

  // Grant access, then it should work.
  const grant = await req(`/admin/admins/${subAdminId}/payment-scope`, { method: 'PUT', token: superToken, body: { scope: 'all' } });
  assert.equal(grant.status, 200, JSON.stringify(grant.data));

  const allowedAttempt = await req(`/payments/proofs/${proofId}/approve`, { method: 'POST', token: subToken, body: {} });
  assert.equal(allowedAttempt.status, 200, `Sub-admin was granted access but still got refused: ${JSON.stringify(allowedAttempt.data)}`);
});

test('Room management: add, reset, and delete a room (with the occupied-room safety check)', async () => {
  const add = await req('/rooms', { method: 'POST', token: superToken, body: { blockCode, floorNumber: 3, roomNumber: 1, bedCount: 1 } });
  assert.equal(add.status, 201, JSON.stringify(add.data));
  const roomId = add.data.room.id;

  const reset = await req(`/rooms/${roomId}/reset`, { method: 'POST', token: superToken });
  assert.equal(reset.status, 200, JSON.stringify(reset.data));
  assert.equal(reset.data.cleared, 0, 'A brand-new empty room should have nothing to clear');

  const del = await req(`/rooms/${roomId}`, { method: 'DELETE', token: superToken });
  assert.equal(del.status, 200, JSON.stringify(del.data));

  // Safety check: deleting a room that still has an active tenant must be refused.
  const occupiedRoom = await req('/rooms/floor', { method: 'POST', token: superToken, body: { blockCode, floorNumber: 4, roomCount: 1 } });
  const occUid = buildUid(blockCode, 4, occupiedRoom.data.rooms[0].roomNumber, 1);
  await req('/tenants', { method: 'POST', token: superToken, body: { uid: occUid, phone: '9444444444', name: 'Occupant', advanceAmount: 1000, monthlyRent: 5000 } });
  const occupiedDelete = await req(`/rooms/${occupiedRoom.data.rooms[0].id}`, { method: 'DELETE', token: superToken });
  assert.equal(occupiedDelete.status, 409, 'Deleting a room with an active tenant should be refused, not silently succeed');
});
