const { before, after, test } = require("node:test");
const assert = require("node:assert/strict");
const {
  prisma,
  createTestFixture,
  cleanupTestFixture,
  startApiServer,
  stopApiServer,
  headersFor,
  signToken,
  bearer,
} = require("./helpers");
let fixture, api;
before(async () => {
  fixture = await createTestFixture();
  api = await startApiServer();
});
after(async () => {
  await stopApiServer(api?.server);
  await cleanupTestFixture(fixture);
  await prisma.$disconnect();
});
test("kassa retains cashier/service APIs and cannot acquire kitchen or administration through stale role claims", async () => {
  const headers = {
    ...bearer(signToken({ id: fixture.user.id, level: "admin" })),
    "Content-Type": "application/json",
  };
  for (const path of [
    "/user/getLevelByToken",
    "/tables",
    "/waiter/menu",
    "/orders?status=READY",
    "/service-calls",
  ]) {
    const response = await fetch(`${api.apiBaseUrl}${path}`, { headers });
    assert.equal(response.status, 200, path);
    if (path === "/user/getLevelByToken")
      assert.equal((await response.json()).level, "kassa");
    else await response.body?.cancel();
  }
  for (const [method, path, body] of [
    ["GET", "/user/list"],
    ["GET", "/organization/info"],
    ["GET", "/qr-mode"],
    ["GET", "/table-sessions/1/qr"],
    ["POST", "/table-sessions/1/rotate-token", { expectedVersion: 1 }],
    ["POST", "/table-sessions/1/close", { expectedVersion: 1 }],
    ["POST", "/billSale/list", {}],
    ["POST", "/report/sumMonthly", {}],
    [
      "PATCH",
      "/kitchen/orders/1/status",
      { expectedVersion: 1, nextStatus: "PREPARING" },
    ],
    ["POST", "/orders/1/refund", {}],
    ["PUT", "/food/update", {}],
    ["POST", "/tables", {}],
  ]) {
    const response = await fetch(`${api.apiBaseUrl}${path}`, {
      method,
      headers,
      ...(body ? { body: JSON.stringify(body) } : {}),
    });
    assert.equal(response.status, 403, path);
    await response.body?.cancel();
  }
  const obsolete = await fetch(`${api.apiBaseUrl}/user/create`, {
    method: "POST",
    headers: headersFor(fixture.admin),
    body: JSON.stringify({
      name: "Legacy role",
      username: "unused-kassa-role-test",
      password: "test-password-1",
      level: "user",
    }),
  });
  assert.equal(obsolete.status, 400);
});
