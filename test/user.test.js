const { after, before, test } = require("node:test");
const assert = require("node:assert/strict");
const { randomUUID } = require("node:crypto");
const { once } = require("node:events");
const jwt = require("jsonwebtoken");
const { PrismaClient } = require("@prisma/client");
const { createTestFixture, cleanupTestFixture } = require("./helpers");
const { isPasswordHash } = require("../lib/password");

const prisma = new PrismaClient();
let apiBaseUrl;
let apiServer;
let admin;
let regularUser;
const createdUserIds = [];
let fixture;

// Enforces the existing authentication and session behavior.
const authHeaders = (user) => ({
  Authorization: `Bearer ${jwt.sign({ id: user.id, level: user.level }, process.env.SECRET_KEY, { expiresIn: "5m" })}`,
  "Content-Type": "application/json",
});

// Creates user with the current contract.
const createUser = async (body, user = admin) => {
  const response = await fetch(`${apiBaseUrl}/user/create`, {
    method: "POST",
    headers: authHeaders(user),
    body: JSON.stringify(body),
  });
  return response;
};

before(async () => {
  const { app } = require("../server");
  apiServer = app.listen(0, "127.0.0.1");
  if (!apiServer.listening) await once(apiServer, "listening");
  apiBaseUrl = `http://127.0.0.1:${apiServer.address().port}/api`;

  fixture = await createTestFixture();
  admin = fixture.admin;
  regularUser = fixture.user;
});

after(async () => {
  if (createdUserIds.length)
    await prisma.user.deleteMany({ where: { id: { in: createdUserIds } } });
  if (apiServer?.listening)
    await new Promise((resolve, reject) =>
      apiServer.close((error) => (error ? reject(error) : resolve())),
    );
  await prisma.$disconnect();
  await cleanupTestFixture(fixture);
});

test("only admins can receive a password-safe user list", async () => {
  const [adminResponse, userResponse] = await Promise.all([
    fetch(`${apiBaseUrl}/user/list`, { headers: authHeaders(admin) }),
    fetch(`${apiBaseUrl}/user/list`, { headers: authHeaders(regularUser) }),
  ]);

  assert.equal(adminResponse.status, 200);
  const body = await adminResponse.json();
  assert.ok(Array.isArray(body.results));
  assert.ok(body.results.every((user) => !Object.hasOwn(user, "password")));
  assert.equal(userResponse.status, 403);
});

test("user creation validates inputs, hashes the password, and rejects active duplicates", async () => {
  const username = `wf05-${randomUUID()}`;
  const password = "safe-password-1";

  const invalidResponse = await createUser({
    name: "",
    username,
    password,
    level: "admin",
  });
  assert.equal(invalidResponse.status, 400);

  const createResponse = await createUser({
    name: "WF05 Test",
    username,
    password,
    level: "user",
  });
  assert.equal(createResponse.status, 201);
  const created = await prisma.user.findFirst({
    where: { username, status: "use" },
  });
  assert.ok(created);
  createdUserIds.push(created.id);
  assert.notEqual(created.password, password);
  assert.ok(isPasswordHash(created.password));

  const duplicateResponse = await createUser({
    name: "Duplicate",
    username,
    password: "safe-password-2",
    level: "user",
  });
  assert.equal(duplicateResponse.status, 409);

  const signInResponse = await fetch(`${apiBaseUrl}/user/signIn`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ username, password }),
  });
  assert.equal(signInResponse.status, 200);
});

test("update preserves a blank password and changes it only when a new valid password is supplied", async () => {
  const username = `wf05-update-${randomUUID()}`;
  const firstPassword = "safe-password-1";
  const secondPassword = "safe-password-2";
  const createResponse = await createUser({
    name: "WF05 Update",
    username,
    password: firstPassword,
    level: "user",
  });
  assert.equal(createResponse.status, 201);
  const created = await prisma.user.findFirst({
    where: { username, status: "use" },
  });
  assert.ok(created);
  createdUserIds.push(created.id);
  const originalHash = created.password;

  const withoutPassword = await fetch(`${apiBaseUrl}/user/update`, {
    method: "PUT",
    headers: authHeaders(admin),
    body: JSON.stringify({
      id: created.id,
      name: "Renamed",
      username,
      level: "user",
    }),
  });
  assert.equal(withoutPassword.status, 200);
  assert.equal(
    (await prisma.user.findUnique({ where: { id: created.id } })).password,
    originalHash,
  );

  const withPassword = await fetch(`${apiBaseUrl}/user/update`, {
    method: "PUT",
    headers: authHeaders(admin),
    body: JSON.stringify({
      id: created.id,
      name: "Renamed",
      username,
      level: "user",
      password: secondPassword,
    }),
  });
  assert.equal(withPassword.status, 200);

  const oldSignIn = await fetch(`${apiBaseUrl}/user/signIn`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ username, password: firstPassword }),
  });
  const newSignIn = await fetch(`${apiBaseUrl}/user/signIn`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ username, password: secondPassword }),
  });
  assert.equal(oldSignIn.status, 401);
  assert.equal(newSignIn.status, 200);
});

test("the backend rejects self-deletion even when a client calls it directly", async () => {
  const response = await fetch(`${apiBaseUrl}/user/remove/${admin.id}`, {
    method: "DELETE",
    headers: authHeaders(admin),
  });
  assert.equal(response.status, 400);
  assert.deepEqual(await response.json(), {
    error: "You cannot delete your own account",
  });
});
