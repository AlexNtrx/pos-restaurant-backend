const { after, before, test } = require("node:test");
const assert = require("node:assert/strict");
const { randomUUID } = require("node:crypto");
const { PrismaClient } = require("@prisma/client");
const { OrderDomainError } = require("../lib/order-domain");
const {
  settleOrders,
  submitOrder,
  transitionOrder,
} = require("../lib/order-service");
const { rotateToken, resolveQrAccess } = require("../lib/table-service");
const { cleanupTestFixture, createTestFixture } = require("./helpers");

const prisma = new PrismaClient();
const createdTableIds = [];
let fixture;
let nextTableNo = 910000 + (Date.now() % 80000);

const staffActor = () => ({
  type: "STAFF",
  userId: fixture.admin.id,
  level: "admin",
});

const counterIntent = (overrides = {}) => ({
  channel: "COUNTER",
  tableNo: nextTableNo++,
  items: [
    {
      foodId: fixture.food.id,
      quantity: 2,
      foodSizeId: fixture.size.id,
      tasteId: fixture.taste.id,
    },
  ],
  ...overrides,
});

const submitCounter = (overrides = {}) =>
  submitOrder(prisma, {
    actor: staffActor(),
    idempotencyKey: randomUUID(),
    intent: counterIntent(),
    ...overrides,
  });

const createOpenSession = async () => {
  const table = await prisma.restaurantTable.create({
    data: { tableNo: nextTableNo++, name: "ORD-01 test table" },
  });
  createdTableIds.push(table.id);
  const session = await prisma.tableSession.create({
    data: { restaurantTableId: table.id },
  });
  return { table, session };
};

const moveToServed = async (order) => {
  let current = order;
  for (const nextStatus of ["CONFIRMED", "PREPARING", "READY", "SERVED"]) {
    current = await transitionOrder(prisma, {
      actor: staffActor(),
      orderId: current.id,
      expectedVersion: current.version,
      nextStatus,
    });
  }
  return current;
};

const expectDomainError = async (promise, { status, code }) => {
  await assert.rejects(promise, (error) => {
    assert.ok(error instanceof OrderDomainError);
    assert.equal(error.status, status);
    assert.equal(error.code, code);
    return true;
  });
};

before(async () => {
  fixture = await createTestFixture();
});

after(async () => {
  await cleanupTestFixture(fixture);
  await prisma.tableSession.deleteMany({
    where: { restaurantTableId: { in: createdTableIds } },
  });
  await prisma.restaurantTable.deleteMany({
    where: { id: { in: createdTableIds } },
  });
  await prisma.$disconnect();
});

test("backend builds authoritative immutable food, size, taste, and price snapshots", async () => {
  const order = await submitCounter();
  assert.equal(order.subtotal, 40);
  assert.equal(order.modifierTotal, 10);
  assert.equal(order.total, 50);
  assert.equal(order.Items[0].foodName, fixture.food.name);
  assert.equal(order.Items[0].unitBasePrice, 20);
  assert.equal(order.Items[0].unitModifierTotal, 5);
  assert.deepEqual(
    order.Items[0].Modifiers.map((modifier) => modifier.type).sort(),
    ["SIZE", "TASTE"],
  );
  assert.deepEqual(
    order.StatusHistory.map((history) => [
      history.fromStatus,
      history.toStatus,
      history.version,
    ]),
    [[null, "SUBMITTED", 1]],
  );

  await expectDomainError(
    submitCounter({
      intent: counterIntent({
        total: 1,
        items: [{ foodId: fixture.food.id, quantity: 1, price: 1 }],
      }),
    }),
    { status: 400, code: "CLIENT_FINANCIAL_AUTHORITY_REJECTED" },
  );

  const original = {
    foodName: fixture.food.name,
    foodPrice: fixture.food.price,
    sizeName: fixture.size.name,
    sizePrice: fixture.size.moneyAdded,
  };
  try {
    await prisma.food.update({
      where: { id: fixture.food.id },
      data: { name: `${fixture.food.name}-changed`, price: 999 },
    });
    await prisma.foodSize.update({
      where: { id: fixture.size.id },
      data: { name: `${fixture.size.name}-changed`, moneyAdded: 777 },
    });
    const persisted = await prisma.order.findUnique({
      where: { id: order.id },
      include: { Items: { include: { Modifiers: true } } },
    });
    assert.equal(persisted.total, 50);
    assert.equal(persisted.Items[0].foodName, original.foodName);
    assert.equal(persisted.Items[0].unitBasePrice, original.foodPrice);
    assert.equal(
      persisted.Items[0].Modifiers.find((modifier) => modifier.type === "SIZE")
        .name,
      original.sizeName,
    );
  } finally {
    await prisma.food.update({
      where: { id: fixture.food.id },
      data: { name: original.foodName, price: original.foodPrice },
    });
    await prisma.foodSize.update({
      where: { id: fixture.size.id },
      data: { name: original.sizeName, moneyAdded: original.sizePrice },
    });
  }
});

test("submit idempotency replays the same intent and rejects a different intent", async () => {
  const idempotencyKey = randomUUID();
  const intent = counterIntent();
  const first = await submitCounter({ idempotencyKey, intent });
  const replay = await submitCounter({ idempotencyKey, intent });
  assert.equal(replay.id, first.id);

  await expectDomainError(
    submitCounter({
      idempotencyKey,
      intent: { ...intent, items: [{ ...intent.items[0], quantity: 3 }] },
    }),
    { status: 409, code: "IDEMPOTENCY_CONFLICT" },
  );
});

test("concurrent duplicate submit creates exactly one Order", async () => {
  const idempotencyKey = randomUUID();
  const intent = counterIntent();
  const [left, right] = await Promise.all([
    submitCounter({ idempotencyKey, intent }),
    submitCounter({ idempotencyKey, intent }),
  ]);
  assert.equal(left.id, right.id);
  assert.equal(
    await prisma.order.count({
      where: { idempotencyScope: `USER:${fixture.admin.id}`, idempotencyKey },
    }),
    1,
  );
});

test("QR requires an open matching TableSession and PostgreSQL prevents two open sessions", async () => {
  const { table, session } = await createOpenSession();
  await expectDomainError(
    submitOrder(prisma, {
      actor: { type: "CUSTOMER" },
      idempotencyKey: randomUUID(),
      intent: {
        channel: "QR",
        tableNo: table.tableNo,
        items: [{ foodId: fixture.food.id, quantity: 1 }],
      },
    }),
    { status: 400, code: "QR_SESSION_REQUIRED" },
  );
  const order = await submitOrder(prisma, {
    actor: { type: "CUSTOMER" },
    idempotencyKey: randomUUID(),
    intent: {
      channel: "QR",
      tableNo: table.tableNo,
      tableSessionId: session.id,
      items: [{ foodId: fixture.food.id, quantity: 1 }],
    },
  });
  assert.equal(order.tableSessionId, session.id);
  assert.equal(order.restaurantTableId, table.id);
  await assert.rejects(
    prisma.tableSession.create({ data: { restaurantTableId: table.id } }),
    (error) => error?.code === "P2002",
  );
});

test("state engine enforces transitions, reasons, optimistic versions, and history", async () => {
  const submitted = await submitCounter();
  await expectDomainError(
    transitionOrder(prisma, {
      actor: staffActor(),
      orderId: submitted.id,
      expectedVersion: submitted.version,
      nextStatus: "READY",
    }),
    { status: 409, code: "INVALID_TRANSITION" },
  );
  const confirmed = await transitionOrder(prisma, {
    actor: staffActor(),
    orderId: submitted.id,
    expectedVersion: submitted.version,
    nextStatus: "CONFIRMED",
  });
  await expectDomainError(
    transitionOrder(prisma, {
      actor: staffActor(),
      orderId: submitted.id,
      expectedVersion: submitted.version,
      nextStatus: "PREPARING",
    }),
    { status: 409, code: "STALE_VERSION" },
  );
  const preparing = await transitionOrder(prisma, {
    actor: staffActor(),
    orderId: confirmed.id,
    expectedVersion: confirmed.version,
    nextStatus: "PREPARING",
  });
  assert.equal(preparing.version, 3);
  assert.deepEqual(
    preparing.StatusHistory.map((history) => history.toStatus),
    ["SUBMITTED", "CONFIRMED", "PREPARING"],
  );

  const cancellable = await submitCounter();
  await expectDomainError(
    transitionOrder(prisma, {
      actor: staffActor(),
      orderId: cancellable.id,
      expectedVersion: cancellable.version,
      nextStatus: "CANCELLED",
      reason: "x",
    }),
    { status: 400, code: "INVALID_REASON" },
  );
  const cancelled = await transitionOrder(prisma, {
    actor: staffActor(),
    orderId: cancellable.id,
    expectedVersion: cancellable.version,
    nextStatus: "CANCELLED",
    reason: "Customer cancelled before payment",
  });
  assert.equal(cancelled.status, "CANCELLED");
});

test("order services reload active staff permissions from the database", async () => {
  const actor = { type: "STAFF", userId: fixture.user.id, level: "user" };
  const order = await submitOrder(prisma, {
    actor,
    idempotencyKey: randomUUID(),
    intent: counterIntent(),
  });
  try {
    await prisma.user.update({
      where: { id: fixture.user.id },
      data: { status: "delete" },
    });
    await expectDomainError(
      transitionOrder(prisma, {
        actor,
        orderId: order.id,
        expectedVersion: order.version,
        nextStatus: "CONFIRMED",
      }),
      { status: 403, code: "FORBIDDEN" },
    );
  } finally {
    await prisma.user.update({
      where: { id: fixture.user.id },
      data: { status: "use" },
    });
  }
});

test("failed settlement leaves no BillSale and no PAID state", async () => {
  const served = await moveToServed(await submitCounter());
  const idempotencyKey = randomUUID();
  await expectDomainError(
    settleOrders(prisma, {
      actor: staffActor(),
      idempotencyKey,
      orders: [{ id: served.id, version: served.version }],
      payType: "cash",
      inputMoney: served.total - 1,
    }),
    { status: 409, code: "INSUFFICIENT_CASH" },
  );
  const persisted = await prisma.order.findUnique({ where: { id: served.id } });
  assert.equal(persisted.status, "SERVED");
  assert.equal(persisted.billSaleId, null);
  assert.equal(
    await prisma.billSale.count({
      where: { userId: fixture.admin.id, idempotencyKey },
    }),
    0,
  );
});

test("settlement atomically records PAID and COMPLETED and supports exact replay", async () => {
  const served = await moveToServed(await submitCounter());
  const idempotencyKey = randomUUID();
  const request = {
    actor: staffActor(),
    idempotencyKey,
    orders: [{ id: served.id, version: served.version }],
    payType: "cash",
    inputMoney: served.total + 20,
  };
  const [first, replay] = await Promise.all([
    settleOrders(prisma, request),
    settleOrders(prisma, request),
  ]);
  assert.equal(replay.id, first.id);
  assert.equal(first.amount, served.total);
  assert.equal(first.returnMoney, 20);
  const completed = await prisma.order.findUnique({
    where: { id: served.id },
    include: { StatusHistory: { orderBy: { version: "asc" } } },
  });
  assert.equal(completed.status, "COMPLETED");
  assert.equal(completed.billSaleId, first.id);
  const tail = completed.StatusHistory.slice(-2);
  assert.deepEqual(
    tail.map((history) => [
      history.fromStatus,
      history.toStatus,
      history.version,
    ]),
    [
      ["SERVED", "PAID", served.version + 1],
      ["PAID", "COMPLETED", served.version + 2],
    ],
  );
  await expectDomainError(
    transitionOrder(prisma, {
      actor: staffActor(),
      orderId: completed.id,
      expectedVersion: completed.version,
      nextStatus: "CANCELLED",
      reason: "Cannot cancel after payment",
    }),
    { status: 409, code: "ORDER_NOT_CANCELLABLE" },
  );
  await expectDomainError(
    settleOrders(prisma, { ...request, inputMoney: served.total + 21 }),
    { status: 409, code: "IDEMPOTENCY_CONFLICT" },
  );
});

test("a TableSession settles all payable Orders into one BillSale without partial settlement", async () => {
  const { table, session } = await createOpenSession();
  const issued = await rotateToken(prisma, session.id, 0);
  assert.equal(issued.session.tokenVersion, 1);
  const submitQr = () =>
    submitOrder(prisma, {
      actor: { type: "CUSTOMER" },
      idempotencyKey: randomUUID(),
      intent: {
        channel: "QR",
        tableNo: table.tableNo,
        tableSessionId: session.id,
        items: [{ foodId: fixture.food.id, quantity: 1 }],
      },
    });
  const first = await moveToServed(await submitQr());
  const second = await moveToServed(await submitQr());
  const partialKey = randomUUID();
  await expectDomainError(
    settleOrders(prisma, {
      actor: staffActor(),
      idempotencyKey: partialKey,
      orders: [{ id: first.id, version: first.version }],
      payType: "bank",
    }),
    { status: 409, code: "PARTIAL_SETTLEMENT_FORBIDDEN" },
  );
  assert.equal(
    await prisma.billSale.count({ where: { idempotencyKey: partialKey } }),
    0,
  );

  const bill = await settleOrders(prisma, {
    actor: staffActor(),
    idempotencyKey: randomUUID(),
    orders: [
      { id: first.id, version: first.version },
      { id: second.id, version: second.version },
    ],
    payType: "bank",
  });
  assert.equal(bill.Orders.length, 2);
  assert.equal(bill.tableSessionId, session.id);
  assert.equal(bill.amount, first.total + second.total);
  const closed = await prisma.tableSession.findUnique({
    where: { id: session.id },
  });
  assert.equal(closed.status, "CLOSED");
  assert.ok(closed.closedAt instanceof Date);
  assert.equal(closed.qrTokenHash, null);
  assert.equal(closed.qrTokenNonce, null);
  assert.equal(closed.qrTokenExpiresAt, null);
  assert.equal(closed.tokenVersion, 2);
  assert.equal(await resolveQrAccess(prisma, issued.token), null);
});
