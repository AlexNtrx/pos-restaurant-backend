const { after, before, test } = require("node:test");
const assert = require("node:assert/strict");
const { randomUUID } = require("node:crypto");
const {
  prisma,
  startApiServer,
  stopApiServer,
  headersFor,
  createTestFixture,
  cleanupTestFixture,
} = require("./helpers");
const { submitOrder, transitionOrder } = require("../lib/order-service");
const { rotateToken, resolveQrAccess } = require("../lib/table-service");

let fixture;
let server;
let apiBaseUrl;
const tableIds = [];

const actor = () => ({
  type: "STAFF",
  userId: fixture.admin.id,
  level: "admin",
});
const request = (path, body, user = fixture.user) =>
  fetch(`${apiBaseUrl}${path}`, {
    method: path.includes("/serve") ? "PATCH" : "POST",
    headers: user ? headersFor(user) : { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
const openSession = async () => {
  const table = await prisma.restaurantTable.create({
    data: { tableNo: 1000 + Math.floor(Math.random() * 8000) },
  });
  tableIds.push(table.id);
  const session = await prisma.tableSession.create({
    data: { restaurantTableId: table.id },
  });
  return { table, session };
};
const qrOrder = async ({ table, session }, status = "SERVED") => {
  let order = await submitOrder(prisma, {
    actor: { type: "CUSTOMER" },
    idempotencyKey: randomUUID(),
    intent: {
      channel: "QR",
      tableNo: table.tableNo,
      tableSessionId: session.id,
      items: [{ foodId: fixture.food.id, quantity: 2 }],
    },
  });
  for (const nextStatus of ["CONFIRMED", "PREPARING", "READY", "SERVED"]) {
    if (order.status === status) break;
    order = await transitionOrder(prisma, {
      actor: actor(),
      orderId: order.id,
      expectedVersion: order.version,
      nextStatus,
    });
  }
  return order;
};
const pay = (sessionId, orders, options = {}) =>
  request(`/table-sessions/${sessionId}/settle`, {
    orders: orders.map((order) => ({ id: order.id, version: order.version })),
    idempotencyKey: options.key ?? randomUUID(),
    payType: options.payType ?? "bank",
    ...(options.inputMoney == null ? {} : { inputMoney: options.inputMoney }),
  });

before(async () => {
  ({ server, apiBaseUrl } = await startApiServer());
  fixture = await createTestFixture();
});
after(async () => {
  await stopApiServer(server);
  await cleanupTestFixture(fixture);
  await prisma.tableSession.deleteMany({
    where: { restaurantTableId: { in: tableIds } },
  });
  await prisma.restaurantTable.deleteMany({ where: { id: { in: tableIds } } });
});

test("staff serves READY once and cannot bypass the transition", async () => {
  const scope = await openSession();
  const ready = await qrOrder(scope, "READY");
  assert.equal(
    (
      await request(
        `/orders/${ready.id}/serve`,
        { expectedVersion: ready.version },
        null,
      )
    ).status,
    401,
  );
  assert.equal(
    (
      await request(`/orders/${ready.id}/serve`, {
        expectedVersion: ready.version,
        nextStatus: "PAID",
      })
    ).status,
    400,
  );
  const served = await request(`/orders/${ready.id}/serve`, {
    expectedVersion: ready.version,
  });
  assert.equal(served.status, 200);
  const result = (await served.json()).result;
  assert.equal(result.status, "SERVED");
  assert.equal(result.version, ready.version + 1);
  assert.equal(result.history.at(-1).toStatus, "SERVED");
  assert.equal(
    (
      await request(`/orders/${ready.id}/serve`, {
        expectedVersion: ready.version,
      })
    ).status,
    409,
  );
});

test("session payment combines orders once, closes session, revokes QR and replays exact retry", async () => {
  const scope = await openSession();
  const issued = await rotateToken(prisma, scope.session.id, 0);
  const first = await qrOrder(scope);
  const second = await qrOrder(scope);
  const key = randomUUID();
  const body = {
    orders: [first, second].map((order) => ({
      id: order.id,
      version: order.version,
    })),
    idempotencyKey: key,
    payType: "cash",
    inputMoney: first.total + second.total + 10,
  };
  const endpoint = `/table-sessions/${scope.session.id}/settle`;
  assert.equal((await request(endpoint, body, null)).status, 401);
  const response = await request(endpoint, body);
  assert.equal(response.status, 200);
  assert.equal(response.headers.get("cache-control"), "no-store");
  const paid = await response.json();
  assert.equal(paid.amount, first.total + second.total);
  assert.equal(paid.returnMoney, 10);
  const replay = await request(endpoint, body);
  assert.equal(replay.status, 200);
  assert.equal((await replay.json()).billId, paid.billId);
  const otherScope = await openSession();
  assert.equal(
    (await request(`/table-sessions/${otherScope.session.id}/settle`, body))
      .status,
    409,
  );
  assert.equal(
    await prisma.billSale.count({
      where: { tableSessionId: scope.session.id },
    }),
    1,
  );
  const bill = await prisma.billSale.findUnique({
    where: { id: paid.billId },
    include: { BillSaleDetails: true, Orders: true },
  });
  assert.equal(bill.Orders.length, 2);
  assert.equal(bill.BillSaleDetails.length, 4);
  assert.equal(bill.amount, first.total + second.total);
  assert.ok(bill.Orders.every((order) => order.status === "COMPLETED"));
  const session = await prisma.tableSession.findUnique({
    where: { id: scope.session.id },
  });
  assert.equal(session.status, "CLOSED");
  assert.equal(session.qrTokenHash, null);
  assert.equal(await resolveQrAccess(prisma, issued.token), null);
  assert.equal(
    (await request(endpoint, { ...body, idempotencyKey: randomUUID() })).status,
    409,
  );
});

test("partial, unserved, wrong-session and insufficient payments never bill or close the table", async () => {
  const scope = await openSession();
  const other = await openSession();
  const first = await qrOrder(scope);
  const second = await qrOrder(scope, "READY");
  const outsider = await qrOrder(other);
  assert.equal((await pay(scope.session.id, [first])).status, 409);
  assert.equal((await pay(scope.session.id, [first, outsider])).status, 404);
  assert.equal((await pay(scope.session.id, [first, second])).status, 409);
  const servedSecond = await transitionOrder(prisma, {
    actor: actor(),
    orderId: second.id,
    expectedVersion: second.version,
    nextStatus: "SERVED",
  });
  assert.equal(
    (
      await pay(scope.session.id, [first, servedSecond], {
        payType: "cash",
        inputMoney: 1,
      })
    ).status,
    409,
  );
  assert.equal(
    await prisma.billSale.count({
      where: { tableSessionId: scope.session.id },
    }),
    0,
  );
  assert.equal(
    (await prisma.tableSession.findUnique({ where: { id: scope.session.id } }))
      .status,
    "OPEN",
  );
});

test("concurrent table payments cannot create two bills and inactive staff cannot act", async () => {
  const scope = await openSession();
  const served = await qrOrder(scope);
  const responses = await Promise.all([
    pay(scope.session.id, [served], { key: randomUUID() }),
    pay(scope.session.id, [served], { key: randomUUID() }),
  ]);
  assert.deepEqual(
    responses.map((response) => response.status).sort(),
    [200, 409],
  );
  assert.equal(
    await prisma.billSale.count({
      where: { tableSessionId: scope.session.id },
    }),
    1,
  );
  await prisma.user.update({
    where: { id: fixture.user.id },
    data: { status: "delete" },
  });
  try {
    const readyScope = await openSession();
    const ready = await qrOrder(readyScope, "READY");
    assert.equal(
      (
        await request(`/orders/${ready.id}/serve`, {
          expectedVersion: ready.version,
        })
      ).status,
      401,
    );
    assert.equal((await pay(readyScope.session.id, [ready])).status, 401);
  } finally {
    await prisma.user.update({
      where: { id: fixture.user.id },
      data: { status: "use" },
    });
  }
});
