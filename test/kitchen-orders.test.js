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

let server;
let apiBaseUrl;
let fixture;

const request = (id, body, user = fixture.user) =>
  fetch(`${apiBaseUrl}/kitchen/orders/${id}/status`, {
    method: "PATCH",
    headers: user ? headersFor(user) : { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });

const createConfirmedOrder = async () => {
  const submitted = await submitOrder(prisma, {
    actor: { type: "STAFF", userId: fixture.user.id, level: "user" },
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
});

after(async () => {
  await stopApiServer(server);
  await cleanupTestFixture(fixture);
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
    request(order.id, body, fixture.user),
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
    assert.equal((await request(order.id, body)).status, 401);
  } finally {
    await prisma.user.update({
      where: { id: fixture.user.id },
      data: { status: "use" },
    });
  }
});
