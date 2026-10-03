const { after, before, test } = require("node:test");
const assert = require("node:assert/strict");
const { once } = require("node:events");
const path = require("node:path");
const jwt = require("jsonwebtoken");
const { PrismaClient } = require("@prisma/client");
const { png } = require("./image-fixture");
const { removeImageArtifacts } = require("../lib/image-variants");
const {
  beginOrganizationFixture,
  restoreOrganizationFixture,
  createTestFixture,
  cleanupTestFixture,
} = require("./helpers");

const prisma = new PrismaClient();
let apiBaseUrl;
let apiServer;
let admin;
let regularUser;
let organization;
const uploadedFiles = [];
let organizationFixture;
let fixture;
// Coordinates headers for behavior for this module.
const headersFor = (user) => ({
  Authorization: `Bearer ${jwt.sign({ id: user.id, level: user.level }, process.env.SECRET_KEY, { expiresIn: "5m" })}`,
  "Content-Type": "application/json",
});

before(async () => {
  const { app } = require("../server");
  apiServer = app.listen(0, "127.0.0.1");
  if (!apiServer.listening) await once(apiServer, "listening");
  apiBaseUrl = `http://127.0.0.1:${apiServer.address().port}/api`;
  fixture = await createTestFixture();
  admin = fixture.admin;
  regularUser = fixture.user;
  organizationFixture = await beginOrganizationFixture();
  organization = organizationFixture.organization;
  assert.ok(
    admin && regularUser && organization,
    "organization tests require active admin, user, and organization",
  );
});
after(async () => {
  await Promise.all(
    uploadedFiles.map((fileName) =>
      removeImageArtifacts(path.resolve("uploads"), fileName),
    ),
  );
  if (apiServer?.listening)
    await new Promise((resolve, reject) =>
      apiServer.close((error) => (error ? reject(error) : resolve())),
    );
  await prisma.$disconnect();
  await restoreOrganizationFixture(organizationFixture);
  await cleanupTestFixture(fixture);
});

test("organization endpoints are admin-only and info has a stable result", async () => {
  const [adminResponse, userResponse] = await Promise.all([
    fetch(`${apiBaseUrl}/organization/info`, { headers: headersFor(admin) }),
    fetch(`${apiBaseUrl}/organization/info`, {
      headers: headersFor(regularUser),
    }),
  ]);
  assert.equal(adminResponse.status, 200);
  const body = await adminResponse.json();
  assert.equal(body.result.id, organization.id);
  assert.equal(userResponse.status, 403);
});

test("organization save validates required receipt fields without changing valid settings", async () => {
  const invalidResponse = await fetch(`${apiBaseUrl}/organization/create`, {
    method: "POST",
    headers: headersFor(admin),
    body: JSON.stringify({}),
  });
  assert.equal(invalidResponse.status, 400);
  const saveResponse = await fetch(`${apiBaseUrl}/organization/create`, {
    method: "POST",
    headers: headersFor(admin),
    body: JSON.stringify({
      name: organization.name,
      address: organization.address,
      phone: organization.phone,
      email: organization.email,
      website: organization.website,
      bankNo: organization.bankNo,
      logo: organization.logo,
      taxCode: organization.taxCode,
    }),
  });
  assert.equal(saveResponse.status, 200);
});

test("logo upload requires one signed image and does not mutate organization before save", async () => {
  const noFileResponse = await fetch(`${apiBaseUrl}/organization/upload`, {
    method: "POST",
    headers: { Authorization: headersFor(admin).Authorization },
  });
  assert.equal(noFileResponse.status, 400);
  const spoofedForm = new FormData();
  spoofedForm.append(
    "file",
    new Blob(["not an image"], { type: "image/png" }),
    "spoof.png",
  );
  const spoofedResponse = await fetch(`${apiBaseUrl}/organization/upload`, {
    method: "POST",
    headers: { Authorization: headersFor(admin).Authorization },
    body: spoofedForm,
  });
  assert.equal(spoofedResponse.status, 400);
  const validForm = new FormData();
  validForm.append("file", new Blob([png], { type: "image/png" }), "logo.png");
  const uploadResponse = await fetch(`${apiBaseUrl}/organization/upload`, {
    method: "POST",
    headers: { Authorization: headersFor(admin).Authorization },
    body: validForm,
  });
  const upload = await uploadResponse.json();
  assert.equal(uploadResponse.status, 201);
  assert.match(upload.fileName, /^logo_[0-9a-f-]+\.png$/);
  uploadedFiles.push(upload.fileName);
  assert.equal(
    (await prisma.organization.findUnique({ where: { id: organization.id } }))
      .logo,
    organization.logo,
  );
});
