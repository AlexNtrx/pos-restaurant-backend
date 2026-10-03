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
  signToken,
  bearer,
} = require("./helpers");
const { submitOrder, transitionOrder } = require("../lib/order-service");

let server;
let apiBaseUrl;
let fixture;
let kitchen;
let kitchenToken;

const request = (id, body, user = fixture.admin) =>
  fetch(`${apiBaseUrl}/kitchen/orders/${id}/status`, {
    method: "PATCH",
    headers: user ? headersFor(user) : { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });

const createConfirmedOrder = async () => {
  const submitted = await submitOrder(prisma, {
    actor: { type: "STAFF", userId: fixture.user.id, level: "kassa" },
    idempotencyKey: randomUUID(),
    intent: {
      channel: "COUNTER",
      tableNo: 92,
      items: [{ foodId: fixture.food.id, quantity: 1 }],
    },
  });
  return transitionOrder(prisma, {
    actor: { type: "STAFF", userId: fixture.admin.id, level: "admin" },
    orderId: submitted.id,
    expectedVersion: submitted.version,
    nextStatus: "CONFIRMED",
  });
};

before(async () => {
  ({ server, apiBaseUrl } = await startApiServer());
  fixture = await createTestFixture();
  const username = `${fixture.marker}-kitchen`;
  const created = await fetch(`${apiBaseUrl}/user/create`, {
    method: "POST",
    headers: headersFor(fixture.admin),
    body: JSON.stringify({
      name: "Cook",
      username,
      password: "test-password-1",
      level: "kitchen",
    }),
  });
  assert.equal(created.status, 201);
  kitchen = await prisma.user.findFirst({ where: { username } });
  const login = await fetch(`${apiBaseUrl}/user/signIn`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ username, password: "test-password-1" }),
  });
  assert.equal(login.status, 200);
  kitchenToken = (await login.json()).token;
  assert.ok(kitchenToken);
});

after(async () => {
  await stopApiServer(server);
  await cleanupTestFixture(fixture);
  if (kitchen) await prisma.user.delete({ where: { id: kitchen.id } });
});

test("admin can list/update kitchen staff and their login reads the current role", async () => {
  const list = await fetch(`${apiBaseUrl}/user/list`, {
    headers: headersFor(fixture.admin),
  });
  assert.equal(list.status, 200);
  assert.equal(
    (await list.json()).results.find((user) => user.id === kitchen.id).level,
    "kitchen",
  );
  const update = await fetch(`${apiBaseUrl}/user/update`, {
    method: "PUT",
    headers: headersFor(fixture.admin),
    body: JSON.stringify({
      id: kitchen.id,
      name: "Updated Cook",
      username: kitchen.username,
      level: "kitchen",
    }),
  });
  assert.equal(update.status, 200);
  const role = await fetch(`${apiBaseUrl}/user/getLevelByToken`, {
    headers: bearer(kitchenToken),
  });
  assert.equal(role.status, 200);
  assert.deepEqual(await role.json(), { level: "kitchen" });
});

test("kitchen can read the board, start and finish preparation with versioned history", async () => {
  const order = await createConfirmedOrder();
  const list = await fetch(`${apiBaseUrl}/orders?status=CONFIRMED`, {
    headers: bearer(kitchenToken),
  });
  assert.equal(list.status, 200);
  assert.ok((await list.json()).results.some((row) => row.id === order.id));
  const detail = await fetch(`${apiBaseUrl}/orders/${order.id}`, {
    headers: bearer(kitchenToken),
  });
  assert.equal(detail.status, 200);
  await detail.body?.cancel();
  const start = await request(
    order.id,
    { expectedVersion: 2, nextStatus: "PREPARING" },
    kitchen,
  );
  assert.equal(start.status, 200);
  assert.equal(
    (
      await request(
        order.id,
        { expectedVersion: 2, nextStatus: "READY" },
        kitchen,
      )
    ).status,
    409,
  );
  const ready = await request(
    order.id,
    { expectedVersion: 3, nextStatus: "READY" },
    kitchen,
  );
  assert.equal(ready.status, 200);
  assert.equal((await ready.json()).result.status, "READY");
  const history = await prisma.orderStatusHistory.findMany({
    where: { orderId: order.id },
    orderBy: { version: "asc" },
  });
  assert.deepEqual(
    history.slice(-2).map((event) => [event.toStatus, event.actorUserId]),
    [
      ["PREPARING", kitchen.id],
      ["READY", kitchen.id],
    ],
  );
});

test("kitchen cannot acquire cashier, waiter, payment or administration rights through a stale admin claim", async () => {
  const forgedRole = {
    ...bearer(signToken({ id: kitchen.id, level: "admin" })),
    "Content-Type": "application/json",
  };
  const order = await createConfirmedOrder();
  for (const [method, path, body] of [
    ["GET", "/user/list"],
    [
      "POST",
      "/user/create",
      {
        name: "Forbidden",
        username: "forbidden",
        password: "test-password-1",
        level: "kitchen",
      },
    ],
    [
      "PUT",
      "/user/update",
      {
        id: kitchen.id,
        name: "Escalation",
        username: kitchen.username,
        level: "admin",
      },
    ],
    ["GET", "/food/filter/all"],
    ["GET", "/saleTemp/list/?tableNo=1"],
    ["POST", "/counterOrder/checkout", {}],
    ["GET", "/waiter/menu"],
    ["POST", "/waiter/orders", {}],
    ["GET", "/tables"],
    ["GET", "/service-calls"],
    ["GET", "/dashboard/operations"],
    ["POST", "/report/sumMonthly", { year: 2026 }],
    ["POST", "/table-sessions/1/settle", {}],
    [
      "PATCH",
      `/orders/${order.id}/status`,
      { expectedVersion: 2, nextStatus: "CANCELLED", reason: "not allowed" },
    ],
    ["PATCH", `/orders/${order.id}/serve`, { expectedVersion: 2 }],
  ]) {
    const response = await fetch(`${apiBaseUrl}${path}`, {
      method,
      headers: forgedRole,
      ...(body ? { body: JSON.stringify(body) } : {}),
    });
    assert.equal(response.status, 403, `${method} ${path}`);
    await response.body?.cancel();
  }
  await assert.rejects(
    transitionOrder(prisma, {
      actor: { type: "STAFF", userId: kitchen.id, level: "admin" },
      orderId: order.id,
      expectedVersion: 2,
      nextStatus: "CANCELLED",
      reason: "not allowed",
    }),
    (error) => error.status === 403,
  );
});

test("kitchen actions recheck role changes and disabled accounts", async () => {
  const order = await createConfirmedOrder();
  try {
    await prisma.user.update({
      where: { id: kitchen.id },
      data: { level: "waiter" },
    });
    assert.equal(
      (
        await request(
          order.id,
          { expectedVersion: 2, nextStatus: "PREPARING" },
          kitchen,
        )
      ).status,
      403,
    );
    await assert.rejects(
      transitionOrder(prisma, {
        actor: { type: "STAFF", userId: kitchen.id, level: "kitchen" },
        orderId: order.id,
        expectedVersion: 2,
        nextStatus: "PREPARING",
      }),
      (error) => error.status === 403,
    );
    await prisma.user.update({
      where: { id: kitchen.id },
      data: { level: "kitchen", status: "delete" },
    });
    assert.equal(
      (
        await request(
          order.id,
          { expectedVersion: 2, nextStatus: "PREPARING" },
          kitchen,
        )
      ).status,
      401,
    );
  } finally {
    await prisma.user.update({
      where: { id: kitchen.id },
      data: { level: "kitchen", status: "use" },
    });
  }
});

test("kitchen only starts confirmed Orders and marks preparing Orders ready", async () => {
  const order = await createConfirmedOrder();
  const anonymous = await request(
    order.id,
    { expectedVersion: 2, nextStatus: "PREPARING" },
    null,
  );
  assert.equal(anonymous.status, 401);
  const invalid = await request(order.id, {
    expectedVersion: 2,
    nextStatus: "SERVED",
  });
  assert.equal(invalid.status, 400);
  assert.equal(
    (
      await request(order.id, {
        expectedVersion: 2,
        nextStatus: "READY",
      })
    ).status,
    409,
  );
  const started = await request(order.id, {
    expectedVersion: 2,
    nextStatus: "PREPARING",
  });
  assert.equal(started.status, 200);
  assert.equal(started.headers.get("cache-control"), "no-store");
  const startBody = (await started.json()).result;
  assert.equal(startBody.status, "PREPARING");
  assert.equal(startBody.version, 3);
  assert.equal(startBody.items[0].name, fixture.food.name);
  assert.equal(
    (
      await request(order.id, {
        expectedVersion: 2,
        nextStatus: "READY",
      })
    ).status,
    409,
  );
  const ready = await request(order.id, {
    expectedVersion: 3,
    nextStatus: "READY",
  });
  assert.equal(ready.status, 200);
  const readyBody = (await ready.json()).result;
  assert.deepEqual(
    readyBody.history.map((event) => event.toStatus),
    ["SUBMITTED", "CONFIRMED", "PREPARING", "READY"],
  );
  const persisted = await prisma.order.findUnique({ where: { id: order.id } });
  assert.ok(persisted.preparingAt);
  assert.ok(persisted.readyAt);
});

test("two kitchen devices cannot start the same version twice; inactive staff cannot act", async () => {
  const order = await createConfirmedOrder();
  const body = { expectedVersion: 2, nextStatus: "PREPARING" };
  const responses = await Promise.all([
    request(order.id, body, kitchen),
    request(order.id, body, fixture.admin),
  ]);
  assert.deepEqual(
    responses.map((response) => response.status).sort(),
    [200, 409],
  );
  const persisted = await prisma.order.findUnique({
    where: { id: order.id },
    include: { StatusHistory: true },
  });
  assert.equal(persisted.version, 3);
  assert.equal(persisted.StatusHistory.length, 3);
  const noReason = await request(order.id, {
    expectedVersion: 3,
    nextStatus: "READY",
    reason: "should not be accepted",
  });
  assert.equal(noReason.status, 400);

  await prisma.user.update({
    where: { id: fixture.user.id },
    data: { status: "delete" },
  });
  try {
    assert.equal((await request(order.id, body, fixture.user)).status, 401);
  } finally {
    await prisma.user.update({
      where: { id: fixture.user.id },
      data: { status: "use" },
    });
  }
});
