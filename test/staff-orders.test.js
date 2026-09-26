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
const { openSession } = require("../lib/table-service");
const { submitOrder } = require("../lib/order-service");

let server;
let apiBaseUrl;
let fixture;
let originalPolicy;
let table;
let qrAccess;

const request = (path, method = "GET", body, user = fixture.user) =>
  fetch(`${apiBaseUrl}${path}`, {
    method,
    headers: user ? headersFor(user) : { "Content-Type": "application/json" },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });

const createCounterOrder = () =>
  submitOrder(prisma, {
    actor: { type: "STAFF", userId: fixture.user.id, level: "user" },
    idempotencyKey: randomUUID(),
    intent: {
      channel: "COUNTER",
      tableNo: 91,
      items: [{ foodId: fixture.food.id, quantity: 1 }],
    },
  });

before(async () => {
  ({ server, apiBaseUrl } = await startApiServer());
  fixture = await createTestFixture();
  originalPolicy = await prisma.qrPolicy.findUnique({ where: { id: 1 } });
  let tableNo = 7801;
  while (await prisma.restaurantTable.findUnique({ where: { tableNo } }))
    tableNo += 1;
  table = await prisma.restaurantTable.create({ data: { tableNo } });
  qrAccess = await openSession(prisma, table.id);
  await prisma.qrPolicy.upsert({
    where: { id: 1 },
    create: { id: 1, mode: "ORDERING" },
    update: { mode: "ORDERING" },
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
  if (originalPolicy)
    await prisma.qrPolicy.update({
      where: { id: 1 },
      data: { mode: originalPolicy.mode },
    });
  else await prisma.qrPolicy.deleteMany({ where: { id: 1 } });
  await stopApiServer(server);
  await cleanupTestFixture(fixture);
});

test("staff inbox lists public QR and Counter snapshots with validated filters and pagination", async () => {
  const anonymous = await request("/orders", "GET", undefined, null);
  assert.equal(anonymous.status, 401);
  const updatedAfter = new Date(Date.now() - 1_000).toISOString();
  const counter = await createCounterOrder();
  const qrResponse = await request(
    `/qr/${qrAccess.token}/orders`,
    "POST",
    {
      idempotencyKey: randomUUID(),
      items: [
        {
          foodId: fixture.food.id,
          foodSizeId: fixture.size.id,
          tasteId: fixture.taste.id,
          quantity: 1,
          note: "Ei chiliä",
        },
      ],
    },
    null,
  );
  assert.equal(qrResponse.status, 201);
  const qrId = (await qrResponse.json()).result.orderId;

  const first = await request(
    `/orders?status=SUBMITTED&limit=1&updatedAfter=${encodeURIComponent(updatedAfter)}`,
  );
  assert.equal(first.status, 200);
  assert.equal(first.headers.get("cache-control"), "no-store");
  const firstPage = await first.json();
  assert.equal(firstPage.results.length, 1);
  assert.ok(firstPage.nextCursor);
  const second = await request(
    `/orders?status=SUBMITTED&limit=1&updatedAfter=${encodeURIComponent(updatedAfter)}&cursor=${firstPage.nextCursor}`,
  );
  assert.equal(second.status, 200);
  const secondPage = await second.json();
  assert.notEqual(firstPage.results[0].id, secondPage.results[0].id);
  assert.ok([counter.id, qrId].includes(firstPage.results[0].id));
  assert.ok([counter.id, qrId].includes(secondPage.results[0].id));
  const onlyQr = await request(
    `/orders?status=SUBMITTED&channel=QR&tableSessionId=${qrAccess.session.id}`,
  );
  const qrList = (await onlyQr.json()).results;
  assert.equal(qrList.length, 1);
  assert.equal(qrList[0].id, qrId);
  assert.equal(qrList[0].items[0].note, "Ei chiliä");
  assert.equal(qrList[0].items[0].modifiers.length, 2);
  const detail = await request(`/orders/${qrId}`);
  assert.equal(detail.status, 200);
  assert.deepEqual(
    (await detail.json()).result.history.map((event) => event.toStatus),
    ["SUBMITTED"],
  );
  const changes = await request(
    `/orders?updatedAfter=${encodeURIComponent(new Date(Date.now() - 60_000).toISOString())}&channel=QR`,
  );
  assert.ok((await changes.json()).results.some((order) => order.id === qrId));
  assert.equal((await request("/orders?status=NOT_A_STATUS")).status, 400);
  assert.equal((await request("/orders?tableSessionId=0")).status, 400);
  assert.equal((await request("/orders?cursor=bad")).status, 400);
});

test("one concurrent staff action wins; rejected/cancelled Orders leave inbox but remain in history", async () => {
  const order = await createCounterOrder();
  const path = `/orders/${order.id}/status`;
  const [confirm, reject] = await Promise.all([
    request(
      path,
      "PATCH",
      { expectedVersion: 1, nextStatus: "CONFIRMED" },
      fixture.user,
    ),
    request(
      path,
      "PATCH",
      { expectedVersion: 1, nextStatus: "REJECTED", reason: "Ei saatavilla" },
      fixture.admin,
    ),
  ]);
  assert.deepEqual([confirm.status, reject.status].sort(), [200, 409]);
  const persisted = await prisma.order.findUnique({
    where: { id: order.id },
    include: { StatusHistory: true },
  });
  assert.equal(persisted.version, 2);
  assert.equal(persisted.StatusHistory.length, 2);
  assert.equal(
    (
      await request(path, "PATCH", {
        expectedVersion: 2,
        nextStatus: "PREPARING",
      })
    ).status,
    400,
  );

  const cancelled = await createCounterOrder();
  const invalidReason = await request(
    `/orders/${cancelled.id}/status`,
    "PATCH",
    {
      expectedVersion: 1,
      nextStatus: "REJECTED",
      reason: "no",
    },
  );
  assert.equal(invalidReason.status, 400);
  const cancel = await request(`/orders/${cancelled.id}/status`, "PATCH", {
    expectedVersion: 1,
    nextStatus: "CANCELLED",
    reason: "Asiakas perui",
  });
  assert.equal(cancel.status, 200);
  const active = await request("/orders?status=SUBMITTED");
  assert.ok(
    !(await active.json()).results.some((row) => row.id === cancelled.id),
  );
  const historical = await request(`/orders/${cancelled.id}`);
  assert.equal(
    (await historical.json()).result.history.at(-1).toStatus,
    "CANCELLED",
  );

  await prisma.user.update({
    where: { id: fixture.user.id },
    data: { status: "delete" },
  });
  try {
    assert.equal((await request("/orders")).status, 401);
    assert.equal(
      (
        await request(path, "PATCH", {
          expectedVersion: 2,
          nextStatus: "CANCELLED",
          reason: "Peruttu",
        })
      ).status,
      401,
    );
  } finally {
    await prisma.user.update({
      where: { id: fixture.user.id },
      data: { status: "use" },
    });
  }
});
