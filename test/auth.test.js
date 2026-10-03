const { after, before, test } = require("node:test");
const assert = require("node:assert/strict");
const { randomUUID } = require("node:crypto");
const {
  prisma,
  startApiServer,
  stopApiServer,
  signToken,
  bearer,
  createTestFixture,
  cleanupTestFixture,
} = require("./helpers");

let apiBaseUrl;
let apiServer;
let adminUserId;
let regularUserId;
let fixture;

// Enforces the existing authentication and session behavior.
const signIn = (body, authorization) =>
  fetch(`${apiBaseUrl}/user/signIn`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      ...(authorization ? { Authorization: authorization } : {}),
    },
    body: JSON.stringify(body),
  });

before(async () => {
  const started = await startApiServer();
  apiServer = started.server;
  apiBaseUrl = started.apiBaseUrl;

  fixture = await createTestFixture();
  adminUserId = fixture.admin.id;
  regularUserId = fixture.user.id;
});

after(async () => {
  await stopApiServer(apiServer);
  await cleanupTestFixture(fixture);

  await prisma.$disconnect();
});

// Coordinates token for behavior for this module.
const tokenFor = (id, level) => signToken({ id, level });

test("rejects an empty JSON object before querying for a user", async () => {
  const response = await signIn({});

  assert.equal(response.status, 400);
  assert.deepEqual(await response.json(), {
    error: "Username and password are required",
  });
});

test("rejects a missing username", async () => {
  const response = await signIn({ password: "not-a-real-password" });

  assert.equal(response.status, 400);
});

test("rejects a missing password", async () => {
  const response = await signIn({ username: "not-a-real-user" });

  assert.equal(response.status, 400);
});

test("rejects incorrect credentials", async () => {
  const response = await signIn({
    username: `missing-${randomUUID()}`,
    password: "not-a-real-password",
  });

  assert.equal(response.status, 401);
});

test("a stale bearer header cannot authenticate incorrect credentials", async () => {
  const response = await signIn(
    {
      username: `missing-${randomUUID()}`,
      password: "not-a-real-password",
    },
    "Bearer stale.invalid.token",
  );

  assert.equal(response.status, 401);
});

test("malformed JSON returns a generic JSON error", async () => {
  const response = await fetch(`${apiBaseUrl}/user/signIn`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: "{",
  });

  assert.equal(response.status, 400);
  assert.match(response.headers.get("content-type"), /application\/json/);
  assert.deepEqual(await response.json(), { error: "Invalid JSON" });
});

test("rejects a token whose user no longer exists", async () => {
  const token = tokenFor(2147483647, "admin");
  const response = await fetch(`${apiBaseUrl}/user/getLevelByToken`, {
    headers: bearer(token),
  });

  assert.equal(response.status, 401);
});

test("returns the current database role instead of the JWT role claim", async () => {
  const token = tokenFor(adminUserId, "kassa");
  const response = await fetch(`${apiBaseUrl}/user/getLevelByToken`, {
    headers: bearer(token),
  });

  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), { level: "admin" });
});

test("a stale admin claim cannot authorize a current user as admin", async () => {
  const token = tokenFor(regularUserId, "admin");
  const response = await fetch(`${apiBaseUrl}/report/sumMonthly`, {
    method: "POST",
    headers: {
      ...bearer(token),
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ year: 2026 }),
  });

  assert.equal(response.status, 403);
  assert.deepEqual(await response.json(), { error: "Only admin" });
});

test("an active user can access the sale workflow", async () => {
  const token = tokenFor(regularUserId, "admin");
  const response = await fetch(`${apiBaseUrl}/saleTemp/list/?tableNo=1`, {
    headers: bearer(token),
  });

  assert.equal(response.status, 200);
  await response.body?.cancel();
});

test("staff can load the active POS catalog while only admins can use the management list", async () => {
  const userToken = tokenFor(regularUserId, "admin");
  const adminToken = tokenFor(adminUserId, "kassa");
  const [
    staffCatalogResponse,
    staffManagementResponse,
    adminManagementResponse,
  ] = await Promise.all([
    fetch(`${apiBaseUrl}/food/filter/all`, { headers: bearer(userToken) }),
    fetch(`${apiBaseUrl}/food/list`, { headers: bearer(userToken) }),
    fetch(`${apiBaseUrl}/food/list`, { headers: bearer(adminToken) }),
  ]);

  assert.equal(staffCatalogResponse.status, 200);
  const staffCatalog = await staffCatalogResponse.json();
  assert.ok(Array.isArray(staffCatalog.results));
  assert.ok(staffCatalog.results.every((food) => food.status === "use"));
  assert.equal(staffManagementResponse.status, 403);
  assert.equal(adminManagementResponse.status, 200);
  await adminManagementResponse.body?.cancel();
});

test("user creation and food pagination require authentication", async () => {
  const [createUserResponse, paginateResponse] = await Promise.all([
    fetch(`${apiBaseUrl}/user/create`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({}),
    }),
    fetch(`${apiBaseUrl}/food/paginate`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ page: 1, itemsPerPage: 1 }),
    }),
  ]);

  assert.equal(createUserResponse.status, 401);
  assert.equal(paginateResponse.status, 401);
});

test("food creation and upload require admin", async () => {
  const token = tokenFor(regularUserId, "admin");
  const [createResponse, uploadResponse] = await Promise.all([
    fetch(`${apiBaseUrl}/food/create`, {
      method: "POST",
      headers: {
        ...bearer(token),
        "Content-Type": "application/json",
      },
      body: JSON.stringify({}),
    }),
    fetch(`${apiBaseUrl}/food/upload`, {
      method: "POST",
      headers: bearer(token),
    }),
  ]);

  assert.equal(createResponse.status, 403);
  assert.equal(uploadResponse.status, 403);
});

test("user creation rejects unsupported role values before writing", async () => {
  const token = tokenFor(adminUserId, "kassa");
  const response = await fetch(`${apiBaseUrl}/user/create`, {
    method: "POST",
    headers: {
      ...bearer(token),
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ level: "auditor" }),
  });

  assert.equal(response.status, 400);
  assert.deepEqual(await response.json(), { error: "Invalid user level" });
});
