const { centsToEuros } = require("../lib/money");
const { after, before, test } = require("node:test");
const assert = require("node:assert/strict");
const { randomUUID } = require("node:crypto");
const {
  prisma,
  startApiServer,
  stopApiServer,
  createTestFixture,
  cleanupTestFixture,
  headersFor,
} = require("./helpers");
const { openSession, rotateToken } = require("../lib/table-service");
const { submitOrder } = require("../lib/order-service");

let server;
let apiBaseUrl;
let fixture;
let kitchen;
let originalPolicy;
const tableIds = [];

const request = (path, method = "GET", body) =>
  fetch(`${apiBaseUrl}${path}`, {
    method,
    headers: { "Content-Type": "application/json" },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });

const makeTable = async () => {
  const table = await prisma.restaurantTable.create({
    data: {
      tableNo: 6000 + Math.floor(Math.random() * 3000),
      name: `Public QR ${randomUUID()}`,
    },
  });
  tableIds.push(table.id);
  return { table, access: await openSession(prisma, table.id) };
};

before(async () => {
  ({ server, apiBaseUrl } = await startApiServer());
  fixture = await createTestFixture();
  kitchen = await prisma.user.create({
    data: {
      name: `${fixture.marker}-kitchen`,
      username: `${fixture.marker}-kitchen`,
      password: fixture.admin.password,
      level: "kitchen",
      status: "use",
    },
  });
  originalPolicy = await prisma.qrPolicy.findUnique({ where: { id: 1 } });
  await prisma.qrPolicy.upsert({
    where: { id: 1 },
    create: { id: 1, mode: "ORDERING" },
    update: { mode: "ORDERING" },
  });
});

after(async () => {
  await prisma.order.deleteMany({
    where: { restaurantTableId: { in: tableIds } },
  });
  await prisma.tableSession.deleteMany({
    where: { restaurantTableId: { in: tableIds } },
  });
  await prisma.restaurantTable.deleteMany({ where: { id: { in: tableIds } } });
  if (originalPolicy)
    await prisma.qrPolicy.update({
      where: { id: 1 },
      data: { mode: originalPolicy.mode },
    });
  else await prisma.qrPolicy.deleteMany({ where: { id: 1 } });
  await stopApiServer(server);
  if (kitchen) await prisma.user.delete({ where: { id: kitchen.id } });
  await cleanupTestFixture(fixture);
});

test("anonymous QR menu, bounded submit, idempotent retry and scoped status", async () => {
  const { table, access } = await makeTable();
  const token = access.token;
  await prisma.food.update({
    where: { id: fixture.food.id },
    data: { img: "qr-menu-photo.webp", detailImg: "qr-detail-poster.jpg" },
  });
  const context = await request(`/qr/${token}/context`);
  assert.equal(context.status, 200);
  assert.equal(context.headers.get("cache-control"), "no-store");
  assert.equal((await context.json()).result.tableNo, table.tableNo);
  const menu = await request(`/qr/${token}/menu`);
  assert.equal(menu.status, 200);
  const category = (await menu.json()).result.categories.find(
    (row) => row.id === fixture.category.id,
  );
  assert.equal(category.food[0].id, fixture.food.id);
  assert.equal(category.food[0].price, 20);
  assert.equal(category.food[0].img, "qr-menu-photo.webp");
  assert.equal(category.food[0].detailImg, "qr-detail-poster.jpg");
  const key = randomUUID();
  const body = {
    idempotencyKey: key,
    expectedTotal: 25,
    items: [
      {
        foodId: fixture.food.id,
        foodSizeId: fixture.size.id,
        tasteId: fixture.taste.id,
        quantity: 1,
        note: "Ei chiliä",
      },
    ],
  };
  const tampered = await request(`/qr/${token}/orders`, "POST", {
    ...body,
    items: [{ ...body.items[0], price: 1 }],
  });
  assert.equal(tampered.status, 400);
  assert.equal(
    (await tampered.json()).code,
    "CLIENT_FINANCIAL_AUTHORITY_REJECTED",
  );
  const forgedTable = await request(`/qr/${token}/orders`, "POST", {
    ...body,
    tableSessionId: 999999,
  });
  assert.equal(forgedTable.status, 400);
  assert.equal((await forgedTable.json()).code, "INVALID_INPUT");
  for (const override of [
    { status: "CONFIRMED" },
    { confirmForKitchen: true },
  ]) {
    const forgedStatus = await request(`/qr/${token}/orders`, "POST", {
      ...body,
      ...override,
    });
    assert.equal(forgedStatus.status, 400);
    assert.equal((await forgedStatus.json()).code, "INVALID_INPUT");
  }
  const forgedFood = await request(`/qr/${token}/orders`, "POST", {
    ...body,
    items: [{ foodId: 999999, quantity: 1 }],
  });
  assert.equal(forgedFood.status, 409);
  assert.equal((await forgedFood.json()).code, "FOOD_UNAVAILABLE");
  const wrongTotal = await request(`/qr/${token}/orders`, "POST", {
    ...body,
    expectedTotal: 1,
  });
  assert.equal(wrongTotal.status, 409);
  assert.equal((await wrongTotal.json()).code, "QUOTE_CHANGED");
  assert.equal(
    await prisma.order.count({ where: { tableSessionId: access.session.id } }),
    0,
  );
  const first = await request(`/qr/${token}/orders`, "POST", body);
  assert.equal(first.status, 201);
  const { result } = await first.json();
  assert.equal(result.status, "CONFIRMED");
  assert.equal(result.total, 25);
  const replay = await request(`/qr/${token}/orders`, "POST", body);
  assert.equal((await replay.json()).result.orderId, result.orderId);
  const status = await request(`/qr/${token}/orders/${result.orderId}`);
  assert.equal(status.status, 200);
  const order = (await status.json()).result;
  assert.equal(order.items[0].note, "Ei chiliä");
  assert.equal(order.items[0].lineTotal, 25);
  assert.equal(order.status, "CONFIRMED");
  assert.deepEqual(
    order.history.map((event) => event.status),
    ["SUBMITTED", "CONFIRMED"],
  );
  const persisted = await prisma.order.findUnique({
    where: { id: result.orderId },
    include: { StatusHistory: { orderBy: { version: "asc" } } },
  });
  assert.equal(persisted.version, 2);
  assert.ok(persisted.confirmedAt);
  assert.equal(persisted.createdByUserId, null);
  assert.deepEqual(
    persisted.StatusHistory.map((event) => [
      event.actorType,
      event.actorUserId,
    ]),
    [
      ["CUSTOMER", null],
      ["CUSTOMER", null],
    ],
  );
  const board = await fetch(`${apiBaseUrl}/orders?status=CONFIRMED`, {
    headers: headersFor(kitchen),
  });
  assert.equal(board.status, 200);
  assert.ok(
    (await board.json()).results.some((row) => row.id === result.orderId),
  );
  const inbox = await fetch(`${apiBaseUrl}/orders?status=SUBMITTED`, {
    headers: headersFor(fixture.admin),
  });
  assert.equal(inbox.status, 200);
  assert.ok(
    !(await inbox.json()).results.some((row) => row.id === result.orderId),
  );
  const start = await fetch(
    `${apiBaseUrl}/kitchen/orders/${result.orderId}/status`,
    {
      method: "PATCH",
      headers: headersFor(kitchen),
      body: JSON.stringify({ expectedVersion: 2, nextStatus: "PREPARING" }),
    },
  );
  assert.equal(start.status, 200);
  assert.equal((await start.json()).result.status, "PREPARING");
  const customerStatus = await request(`/qr/${token}/orders/${result.orderId}`);
  assert.equal((await customerStatus.json()).result.status, "PREPARING");
  const retryAfterStart = await request(`/qr/${token}/orders`, "POST", body);
  assert.equal((await retryAfterStart.json()).result.status, "PREPARING");
  const conflict = await request(`/qr/${token}/orders`, "POST", {
    ...body,
    items: [{ ...body.items[0], quantity: 2 }],
  });
  assert.equal(conflict.status, 409);
  assert.equal((await conflict.json()).code, "IDEMPOTENCY_CONFLICT");
  const other = await makeTable();
  const foreign = await request(
    `/qr/${other.access.token}/orders/${result.orderId}`,
  );
  assert.equal(foreign.status, 404);

  await prisma.qrPolicy.update({
    where: { id: 1 },
    data: { mode: "MENU_ONLY" },
  });
  assert.equal((await request(`/qr/${token}/menu`)).status, 200);
  const menuOnlySubmit = await request(`/qr/${token}/orders`, "POST", {
    ...body,
    idempotencyKey: randomUUID(),
  });
  assert.equal(menuOnlySubmit.status, 409);
  await prisma.qrPolicy.update({
    where: { id: 1 },
    data: { mode: "DISABLED" },
  });
  assert.equal(
    (await (await request(`/qr/${token}/context`)).json()).result.state,
    "CLOSED",
  );
  assert.equal((await request(`/qr/${token}/menu`)).status, 409);
  assert.equal(
    (await request(`/qr/${token}/orders/${result.orderId}`)).status,
    200,
  );
  const rotated = await rotateToken(
    prisma,
    access.session.id,
    access.session.tokenVersion,
  );
  assert.equal((await request(`/qr/${token}/context`)).status, 404);
  assert.equal(
    (await request(`/qr/${rotated.token}/orders/${result.orderId}`)).status,
    200,
  );
});

test("sold-out and expired QR cannot create new orders", async () => {
  await prisma.qrPolicy.update({
    where: { id: 1 },
    data: { mode: "ORDERING" },
  });
  const { access } = await makeTable();
  const path = `/qr/${access.token}/orders`;
  const body = {
    idempotencyKey: randomUUID(),
    items: [{ foodId: fixture.food.id, quantity: 1 }],
  };
  await prisma.food.update({
    where: { id: fixture.food.id },
    data: { status: "delete" },
  });
  try {
    const unavailable = await request(path, "POST", body);
    assert.equal(unavailable.status, 409);
    assert.equal((await unavailable.json()).code, "FOOD_UNAVAILABLE");
  } finally {
    await prisma.food.update({
      where: { id: fixture.food.id },
      data: { status: "use" },
    });
  }
  await prisma.tableSession.update({
    where: { id: access.session.id },
    data: { qrTokenExpiresAt: new Date(Date.now() - 1000) },
  });
  assert.equal((await request(path, "POST", body)).status, 404);
  assert.equal((await request(`/qr/${access.token}/menu`)).status, 404);
});

test("concurrent identical public retries persist only one QR Order", async () => {
  await prisma.qrPolicy.update({
    where: { id: 1 },
    data: { mode: "ORDERING" },
  });
  const { access } = await makeTable();
  const body = {
    idempotencyKey: randomUUID(),
    items: [{ foodId: fixture.food.id, quantity: 1 }],
  };
  const [first, second] = await Promise.all([
    request(`/qr/${access.token}/orders`, "POST", body),
    request(`/qr/${access.token}/orders`, "POST", body),
  ]);
  assert.equal(first.status, 201);
  assert.equal(second.status, 201);
  const ids = [
    (await first.json()).result.orderId,
    (await second.json()).result.orderId,
  ];
  assert.equal(ids[0], ids[1]);
  const order = await prisma.order.findUnique({
    where: { id: ids[0] },
    include: { StatusHistory: { orderBy: { version: "asc" } } },
  });
  assert.equal(order.status, "CONFIRMED");
  assert.equal(order.version, 2);
  assert.deepEqual(
    order.StatusHistory.map((event) => event.toStatus),
    ["SUBMITTED", "CONFIRMED"],
  );
  assert.equal(
    await prisma.order.count({
      where: {
        tableSessionId: access.session.id,
        idempotencyKey: body.idempotencyKey,
      },
    }),
    1,
  );
});

test("replaying an older submitted QR order preserves its status and history", async () => {
  const { table, access } = await makeTable();
  const body = {
    idempotencyKey: randomUUID(),
    items: [{ foodId: fixture.food.id, quantity: 1 }],
  };
  const legacy = await submitOrder(prisma, {
    actor: { type: "CUSTOMER" },
    idempotencyKey: body.idempotencyKey,
    intent: {
      channel: "QR",
      tableNo: table.tableNo,
      tableSessionId: access.session.id,
      items: body.items,
    },
  });
  assert.equal(legacy.status, "SUBMITTED");
  const response = await request(`/qr/${access.token}/orders`, "POST", body);
  assert.equal(response.status, 201);
  assert.deepEqual((await response.json()).result, {
    orderId: legacy.id,
    status: "SUBMITTED",
    total: centsToEuros(legacy.total),
  });
  assert.equal(
    await prisma.orderStatusHistory.count({ where: { orderId: legacy.id } }),
    1,
  );
});
