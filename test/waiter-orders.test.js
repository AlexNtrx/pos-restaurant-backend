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
const {
  checkoutCounterDraft,
  submitOrder,
  transitionOrder,
} = require("../lib/order-service");

let server;
let apiBaseUrl;
let fixture;
let waiter;
let table;

const request = (path, method = "GET", body, actor = waiter) =>
  fetch(`${apiBaseUrl}${path}`, {
    method,
    headers: actor ? headersFor(actor) : { "Content-Type": "application/json" },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });

before(async () => {
  ({ server, apiBaseUrl } = await startApiServer());
  fixture = await createTestFixture();
  waiter = await prisma.user.update({
    where: { id: fixture.user.id },
    data: { level: "waiter" },
  });
  table = await prisma.restaurantTable.create({
    data: { tableNo: 20000 + Math.floor(Math.random() * 100000) },
  });
});

after(async () => {
  if (table) {
    await prisma.order.deleteMany({ where: { restaurantTableId: table.id } });
    await prisma.tableSession.deleteMany({
      where: { restaurantTableId: table.id },
    });
    await prisma.restaurantTable.delete({ where: { id: table.id } });
  }
  await stopApiServer(server);
  await cleanupTestFixture(fixture);
  await prisma.$disconnect();
});

test("waiter receives a table order, sends it to kitchen, and serves READY without cashier rights", async () => {
  assert.equal(
    (await request("/waiter/menu", "GET", undefined, null)).status,
    401,
  );
  assert.equal((await request("/user/getLevelByToken")).status, 200);
  const signedIn = await request(
    "/user/signIn",
    "POST",
    {
      username: waiter.username,
      password: "test-password-1",
    },
    null,
  );
  assert.equal(signedIn.status, 200);
  assert.equal((await request("/counterOrder/quote", "POST", {})).status, 403);
  assert.equal(
    (await request("/table-sessions/1/settle", "POST", {})).status,
    403,
  );
  assert.equal(
    (await request("/kitchen/orders/1/status", "PATCH", {})).status,
    403,
  );

  const menu = await request("/waiter/menu");
  assert.equal(menu.status, 200);
  assert.ok(
    (await menu.json()).result.categories.some((category) =>
      category.food.some((food) => food.id === fixture.food.id),
    ),
  );

  const opened = await request(`/tables/${table.id}/sessions`, "POST", {});
  assert.equal(opened.status, 201);
  const sessionId = (await opened.json()).result.session.id;
  const key = randomUUID();
  const body = {
    tableSessionId: sessionId,
    idempotencyKey: key,
    expectedTotal: 50,
    items: [
      {
        foodId: fixture.food.id,
        foodSizeId: fixture.size.id,
        quantity: 2,
        note: "No onion",
      },
    ],
  };
  assert.equal(
    (await request("/waiter/orders", "POST", { ...body, total: 1 })).status,
    400,
  );
  assert.equal(
    (await request("/waiter/orders", "POST", { ...body, expectedTotal: 1 }))
      .status,
    409,
  );
  const submitted = await request("/waiter/orders", "POST", body);
  assert.equal(submitted.status, 201);
  const order = (await submitted.json()).result;
  assert.equal(order.channel, "STAFF");
  assert.equal(order.status, "CONFIRMED");
  assert.equal(order.version, 2);
  assert.equal(order.tableNo, table.tableNo);
  assert.equal(order.total, 50);
  assert.equal(order.items[0].note, "No onion");
  const listed = await request("/orders?channel=STAFF");
  assert.equal(listed.status, 200);
  assert.ok((await listed.json()).results.some((row) => row.id === order.id));
  assert.equal(
    (
      await request(`/orders/${order.id}/status`, "PATCH", {
        expectedVersion: order.version,
        nextStatus: "CANCELLED",
        reason: " ",
      })
    ).status,
    400,
  );
  assert.equal((await request("/waiter/orders", "POST", body)).status, 201);
  assert.equal(
    await prisma.order.count({ where: { tableSessionId: sessionId } }),
    1,
  );

  const preparing = await transitionOrder(prisma, {
    actor: { type: "STAFF", userId: fixture.admin.id, level: "admin" },
    orderId: order.id,
    expectedVersion: 2,
    nextStatus: "PREPARING",
  });
  const ready = await transitionOrder(prisma, {
    actor: { type: "STAFF", userId: fixture.admin.id, level: "admin" },
    orderId: order.id,
    expectedVersion: preparing.version,
    nextStatus: "READY",
  });
  assert.equal(
    (
      await request(`/orders/${order.id}/serve`, "PATCH", {
        expectedVersion: 2,
      })
    ).status,
    409,
  );
  const served = await request(`/orders/${order.id}/serve`, "PATCH", {
    expectedVersion: ready.version,
  });
  assert.equal(served.status, 200);
  assert.equal((await served.json()).result.status, "SERVED");
});

const adminActor = () => ({
  type: "STAFF",
  userId: fixture.admin.id,
  level: "admin",
});

const createStageOrder = async (channel, status) => {
  const session = await prisma.tableSession.findFirst({
    where: { restaurantTableId: table.id, status: "OPEN" },
  });
  let order = await submitOrder(prisma, {
    actor: channel === "QR" ? { type: "CUSTOMER" } : adminActor(),
    idempotencyKey: randomUUID(),
    intent: {
      channel,
      tableNo: table.tableNo,
      tableSessionId: session.id,
      items: [{ foodId: fixture.food.id, quantity: 1 }],
    },
  });
  if (status === "SUBMITTED") return order;
  for (const nextStatus of ["CONFIRMED", "PREPARING", "READY", "SERVED"]) {
    order = await transitionOrder(prisma, {
      actor: adminActor(),
      orderId: order.id,
      expectedVersion: order.version,
      nextStatus,
    });
    if (nextStatus === status) return order;
  }
  throw new Error("Unsupported test stage");
};

const cancel = (order, overrides = {}, actor = waiter) =>
  request(
    `/orders/${order.id}/status`,
    "PATCH",
    {
      expectedVersion: order.version,
      nextStatus: "CANCELLED",
      reason: "Customer changed the order",
      ...overrides,
    },
    actor,
  );

test("waiter cancels unpaid QR and STAFF orders only before preparation with an audited reason", async () => {
  for (const channel of ["QR", "STAFF"]) {
    for (const status of ["SUBMITTED", "CONFIRMED"]) {
      const order = await createStageOrder(channel, status);
      assert.equal((await cancel(order, { reason: " " })).status, 400);
      assert.equal(
        (await cancel(order, { expectedVersion: order.version + 1 })).status,
        409,
      );
      const result = await cancel(order);
      assert.equal(result.status, 200);
      const cancelled = (await result.json()).result;
      assert.equal(cancelled.status, "CANCELLED");
      assert.equal(cancelled.version, order.version + 1);
      assert.equal(cancelled.cancellationReason, "Customer changed the order");
      assert.ok(cancelled.cancelledAt);
      const history = await prisma.orderStatusHistory.findFirst({
        where: { orderId: order.id, toStatus: "CANCELLED" },
      });
      assert.equal(history.actorUserId, waiter.id);
      assert.equal(history.fromStatus, status);
      assert.equal((await cancel(cancelled)).status, 409);
      const queue = await request(`/orders?status=${status}`);
      assert.ok(
        !(await queue.json()).results.some((row) => row.id === order.id),
      );
    }
  }
});

test("no role can cancel after preparation and paid cancellation requires a refund", async () => {
  const preparing = await createStageOrder("STAFF", "PREPARING");
  const blocked = await cancel(preparing);
  assert.equal(blocked.status, 409);
  assert.equal((await blocked.json()).code, "ORDER_NOT_CANCELLABLE");
  const unchanged = await prisma.order.findUnique({
    where: { id: preparing.id },
  });
  assert.equal(unchanged.status, "PREPARING");
  assert.equal(unchanged.version, preparing.version);
  assert.equal((await cancel(preparing, {}, fixture.admin)).status, 409);
  for (const status of ["READY", "SERVED"]) {
    const later = await createStageOrder("QR", status);
    assert.equal((await cancel(later)).status, 409);
    assert.equal((await cancel(later, {}, fixture.admin)).status, 409);
  }

  const checkout = await checkoutCounterDraft(prisma, {
    actor: adminActor(),
    idempotencyKey: randomUUID(),
    intent: {
      tableNo: table.tableNo,
      items: [{ foodId: fixture.food.id, quantity: 1 }],
    },
    expectedTotal: 20,
    payType: "bank",
  });
  const prepaid = await prisma.order.findUnique({
    where: { id: checkout.Orders[0].id },
  });
  const paidResult = await cancel(prepaid);
  assert.equal(paidResult.status, 409);
  assert.equal((await paidResult.json()).code, "ORDER_ALREADY_PAID");
});

test("kitchen preparation and waiter cancellation cannot commit the same version", async () => {
  const order = await createStageOrder("STAFF", "CONFIRMED");
  const responses = await Promise.all([
    cancel(order),
    request(
      `/kitchen/orders/${order.id}/status`,
      "PATCH",
      { expectedVersion: order.version, nextStatus: "PREPARING" },
      fixture.admin,
    ),
  ]);
  assert.deepEqual(
    responses.map((response) => response.status).sort(),
    [200, 409],
  );
  const persisted = await prisma.order.findUnique({
    where: { id: order.id },
    include: { StatusHistory: true },
  });
  assert.equal(persisted.version, order.version + 1);
  assert.ok(["CANCELLED", "PREPARING"].includes(persisted.status));
  assert.equal(persisted.StatusHistory.length, 3);
});
