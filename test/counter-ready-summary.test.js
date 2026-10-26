const { before, after, beforeEach, test } = require("node:test");
const assert = require("node:assert/strict");
const express = require("express");
const jwt = require("jsonwebtoken");

// EN: Exercise the real HTTP/auth/service chain with an in-memory Prisma boundary; never connect to a database.
// FI: Testaa oikea HTTP-, tunnistus- ja palveluketju muistissa olevalla Prisma-rajalla; älä yhdistä tietokantaan.
let users, orders, reads, failRead, revoked;
const prisma = {
  user: {
    findFirst: async ({ where }) =>
      users.find(
        (user) => user.id === where.id && user.status === where.status,
      ) ?? null,
    findUnique: async ({ where }) =>
      revoked
        ? { id: where.id, level: "waiter", status: "use" }
        : (users.find((user) => user.id === where.id) ?? null),
  },
  order: {
    findFirst: async (query) => {
      reads.push(query);
      if (failRead) throw new Error("private database diagnostic");
      assert.equal(query.where.channel, "COUNTER");
      assert.equal(query.where.tableSessionId, null);
      assert.equal(query.where.status, "READY");
      assert.equal(query.where.OR.length, 3);
      assert.deepEqual(query.select, { id: true });
      const row = orders.find(
        (order) =>
          order.channel === query.where.channel &&
          order.createdByUserId === query.where.createdByUserId &&
          order.tableSessionId === null &&
          order.status === "READY" &&
          (order.confirmedAt ||
            order.idempotencyScope ===
              `COUNTER_KITCHEN_USER:${order.createdByUserId}`),
      );
      return row ? { id: row.id } : null;
    },
  },
};
const prismaPath = require.resolve("../lib/prisma");
require.cache[prismaPath] = {
  id: prismaPath,
  filename: prismaPath,
  loaded: true,
  exports: prisma,
};
process.env.SECRET_KEY = "ready-summary-unit-test-only";
const registerCounterRoutes = require("../routes/counter");
let server, base;
before(async () => {
  const app = express();
  registerCounterRoutes(app);
  server = await new Promise((resolve) => {
    const instance = app.listen(0, "127.0.0.1", () => resolve(instance));
  });
  base = `http://127.0.0.1:${server.address().port}/api/counterOrder/ready-summary`;
});
after(async () => {
  server.closeAllConnections();
  await new Promise((resolve) => server.close(resolve));
});
beforeEach(() => {
  users = ["admin", "kassa", "waiter", "kitchen"].map((level, index) => ({
    id: index + 1,
    name: level,
    level,
    status: "use",
  }));
  users.push({ id: 5, name: "Disabled", level: "kassa", status: "cancelled" });
  orders = [];
  reads = [];
  failRead = false;
  revoked = false;
});
const headers = (id) => ({
  Authorization: `Bearer ${jwt.sign({ id, level: "admin" }, process.env.SECRET_KEY)}`,
});
const ready = (changes = {}) => ({
  id: 10,
  channel: "COUNTER",
  createdByUserId: 2,
  tableSessionId: null,
  status: "READY",
  confirmedAt: new Date(),
  serviceType: "DINE_IN",
  tableNo: 999,
  ...changes,
});

test("registers the summary before the Order id route and returns only the owned boolean without caching", async () => {
  for (const serviceType of ["DINE_IN", "TAKEAWAY"]) {
    orders = [
      ready({ serviceType, tableNo: serviceType === "TAKEAWAY" ? null : 999 }),
    ];
    const response = await fetch(base, { headers: headers(2) });
    assert.equal(response.status, 200);
    assert.equal(response.headers.get("cache-control"), "no-store");
    assert.deepEqual(await response.json(), { result: { hasReady: true } });
    assert.equal(reads.at(-1).where.createdByUserId, 2);
    assert.equal(Object.hasOwn(reads.at(-1).where, "tableNo"), false);
    assert.equal(Object.hasOwn(reads.at(-1).where, "serviceType"), false);
  }
});
test("does not notify another cashier's, table-session, QR, or already served Orders and ignores client ownership filters", async () => {
  orders = [
    ready({ createdByUserId: 1 }),
    ready({ tableSessionId: 9 }),
    ready({ channel: "QR" }),
    ready({ status: "SERVED" }),
  ];
  const response = await fetch(
    `${base}?userId=1&tableNo=999&serviceType=TAKEAWAY`,
    { headers: headers(2) },
  );
  assert.deepEqual(await response.json(), { result: { hasReady: false } });
  orders = [ready({ createdByUserId: 1 })];
  const admin = await fetch(base, { headers: headers(1) });
  assert.deepEqual(await admin.json(), { result: { hasReady: true } });
});
test("rejects missing/invalid tokens, inactive users, waiter and kitchen even with an admin role claim", async () => {
  for (const [requestHeaders, expected] of [
    [{}, 401],
    [{ Authorization: "Bearer invalid" }, 401],
    [headers(5), 401],
    [headers(3), 403],
    [headers(4), 403],
  ]) {
    const response = await fetch(base, { headers: requestHeaders });
    assert.equal(response.status, expected);
    await response.body.cancel();
  }
  assert.equal(reads.length, 0);
});
test("rechecks current cashier authority in the service before querying Orders", async () => {
  revoked = true;
  const response = await fetch(base, { headers: headers(2) });
  assert.equal(response.status, 403);
  assert.equal(reads.length, 0);
});
test("does not turn a query failure into a false no-ready result or expose its diagnostic", async (context) => {
  context.mock.method(console, "error", () => {});
  failRead = true;
  const response = await fetch(base, { headers: headers(2) });
  assert.equal(response.status, 500);
  assert.deepEqual(await response.json(), {
    error: "Unable to process Counter Order",
  });
});
