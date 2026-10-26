const { test } = require("node:test");
const assert = require("node:assert/strict");
const express = require("express");
const jwt = require("jsonwebtoken");

// EN: Verify the released settings workflow against a Prisma boundary without commercial tax models or a database.
// FI: Tarkista julkaistava asetuspolku Prisma-rajalla ilman kaupallisia veromalleja tai tietokantaa.
let organization = null;
let writes = 0;
const prisma = {
  user: {
    findFirst: async ({ where }) => ({
      id: where.id,
      name: "Test user",
      level: where.id === 1 ? "admin" : "kassa",
    }),
  },
  organization: {
    findFirst: async () => organization,
    create: async ({ data }) => {
      assert.deepEqual(Object.keys(data).sort(), [
        "address",
        "bankNo",
        "email",
        "logo",
        "name",
        "phone",
        "taxCode",
        "website",
      ]);
      writes += 1;
      organization = { id: 1, ...data };
      return organization;
    },
  },
  $transaction: async (action) => action(prisma),
};
const prismaPath = require.resolve("../lib/prisma");
require.cache[prismaPath] = {
  id: prismaPath,
  filename: prismaPath,
  loaded: true,
  exports: prisma,
};
process.env.SECRET_KEY = "organization-release-test-only";
const registerOrganizationRoutes = require("../routes/organization");

test("restaurant setup remains admin-only and needs no commercial tax storage", async (t) => {
  const app = express();
  app.use(express.json());
  registerOrganizationRoutes(app);
  const server = app.listen(0, "127.0.0.1");
  await new Promise((resolve) => server.once("listening", resolve));
  t.after(() => new Promise((resolve) => server.close(resolve)));
  const base = `http://127.0.0.1:${server.address().port}/api/organization`;
  const headers = (id = 1) => ({
    Authorization: `Bearer ${jwt.sign({ id }, process.env.SECRET_KEY)}`,
    "Content-Type": "application/json",
  });
  const body = JSON.stringify({
    name: "Test restaurant",
    address: "Test street",
    phone: "123",
    taxCode: "TEST-1",
  });
  assert.equal((await fetch(`${base}/info`)).status, 401);
  assert.equal(
    (
      await fetch(`${base}/create`, {
        method: "POST",
        headers: headers(2),
        body,
      })
    ).status,
    403,
  );
  const saved = await fetch(`${base}/create`, {
    method: "POST",
    headers: headers(),
    body,
  });
  assert.equal(saved.status, 200);
  assert.deepEqual(await saved.json(), { message: "success" });
  const info = await fetch(`${base}/info`, { headers: headers() });
  assert.equal(info.status, 200);
  assert.equal((await info.json()).result.taxCode, "TEST-1");
  for (const [route, method] of [
    ["tax-draft", "GET"],
    ["tax-draft", "PUT"],
    ["tax-policy-review", "GET"],
    ["tax-policy-revisions", "POST"],
    ["tax-policy-approvals", "POST"],
    ["tax-policy-publication-readiness", "GET"],
    ["tax-control", "GET"],
  ]) {
    const response = await fetch(`${base}/${route}`, {
      method,
      headers: headers(),
    });
    assert.equal(response.status, 404, `${method} ${route}`);
  }
  assert.equal(writes, 1);
});
