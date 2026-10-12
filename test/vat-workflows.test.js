const { test, before, after } = require("node:test");
const assert = require("node:assert/strict");
const { randomUUID } = require("node:crypto");
const {
  prisma,
  createTestFixture,
  cleanupTestFixture,
  beginOrganizationFixture,
  restoreOrganizationFixture,
  startApiServer,
  stopApiServer,
  headersFor,
} = require("./helpers");
const {
  checkoutCounterDraft,
  submitOrder,
  transitionOrder,
  settleTableSession,
} = require("../lib/order-service");
const { reserveRefund, finishRefund } = require("../lib/order-refund-service");
const { endSale } = require("../lib/legacy-checkout-service");
let fixture, api;
const tables = [];
const priorDemo = process.env.VAT_DEMO_ENABLED;
const actor = () => ({
  type: "STAFF",
  userId: fixture.admin.id,
  level: "admin",
});
let organizationFixture;
before(async () => {
  fixture = await createTestFixture();
  organizationFixture = await beginOrganizationFixture();
  api = await startApiServer();
  process.env.VAT_DEMO_ENABLED = "true";
});
after(async () => {
  if (priorDemo === undefined) delete process.env.VAT_DEMO_ENABLED;
  else process.env.VAT_DEMO_ENABLED = priorDemo;
  await stopApiServer(api?.server);
  await restoreOrganizationFixture(organizationFixture);
  await cleanupTestFixture(fixture);
  await prisma.tableSession.deleteMany({
    where: { restaurantTableId: { in: tables } },
  });
  await prisma.restaurantTable.deleteMany({ where: { id: { in: tables } } });
  await prisma.$disconnect();
});
const setFood = (data) =>
  prisma.food.update({ where: { id: fixture.food.id }, data });
const payDraft = (overrides = {}) =>
  checkoutCounterDraft(prisma, {
    actor: actor(),
    idempotencyKey: randomUUID(),
    intent: {
      serviceType: "TAKEAWAY",
      items: [
        { foodId: fixture.food.id, quantity: 2, foodSizeId: fixture.size.id },
      ],
    },
    expectedTotal: 28.8,
    payType: "cash",
    inputMoney: 50,
    ...overrides,
  });

test("Counter captures mixed VAT atomically, preserves cash, retries and full refund snapshots", async () => {
  await setFood({ price: 1290n, taxCategory: "FOOD_NON_ALCOHOLIC" });
  await prisma.foodSize.update({
    where: { id: fixture.size.id },
    data: { moneyAdded: 150n },
  });
  const alcohol = await prisma.food.create({
    data: {
      name: "Olut demo",
      price: 650n,
      remark: "",
      img: "",
      foodTypeId: fixture.category.id,
      foodType: "drink",
      taxCategory: "ALCOHOL",
    },
  });
  const request = {
    actor: actor(),
    idempotencyKey: randomUUID(),
    intent: {
      serviceType: "TAKEAWAY",
      items: [
        { foodId: fixture.food.id, quantity: 2, foodSizeId: fixture.size.id },
        { foodId: alcohol.id, quantity: 2 },
      ],
    },
    expectedTotal: 41.8,
    payType: "cash",
    inputMoney: 50,
  };
  const results = await Promise.allSettled([
    checkoutCounterDraft(prisma, request),
    checkoutCounterDraft(prisma, request),
  ]);
  for (const result of results)
    if (result.status === "rejected")
      assert.equal(result.reason.code, "CHECKOUT_CONFLICT");
  const bill = results.find((result) => result.status === "fulfilled").value;
  assert.equal(bill.amount, 4180n);
  assert.equal(bill.returnMoney, 820n);
  assert.equal(bill.vatSnapshot.taxCents, "607");
  assert.equal(bill.vatSnapshot.netCents, "3573");
  assert.equal(
    bill.BillSaleDetails.reduce(
      (sum, line) => sum + BigInt(line.vatSnapshot.taxCents),
      0n,
    ),
    607n,
  );
  const item = await prisma.orderItem.findFirst({
    where: { orderId: bill.Orders[0].id, foodId: fixture.food.id },
  });
  assert.equal(item.vatSnapshot.rateBps, 1350);
  await setFood({ price: 9999n, taxCategory: "ALCOHOL" });
  process.env.VAT_DEMO_ENABLED = "false";
  const replay = await checkoutCounterDraft(prisma, request);
  assert.equal(replay.id, bill.id);
  assert.deepEqual(replay.vatSnapshot, bill.vatSnapshot);
  assert.equal(
    await prisma.billSale.count({
      where: {
        userId: fixture.admin.id,
        idempotencyKey: request.idempotencyKey,
      },
    }),
    1,
  );
  const order = await prisma.order.findUniqueOrThrow({
    where: { id: bill.Orders[0].id },
  });
  const key = randomUUID();
  const reservation = await reserveRefund(prisma, {
    actor: actor(),
    orderId: order.id,
    body: {
      expectedVersion: order.version,
      idempotencyKey: key,
      method: "cash",
      reason: "Demo cancellation",
    },
  });
  assert.equal(reservation.vatSnapshot.taxCents, "-607");
  const refundRequest = {
    actor: actor(),
    orderId: order.id,
    body: { idempotencyKey: key, reference: "Demo returned cash" },
  };
  const completed = await finishRefund(prisma, refundRequest);
  assert.deepEqual(
    (await finishRefund(prisma, refundRequest)).vatSnapshot,
    completed.vatSnapshot,
  );
  assert.equal(completed.status, "COMPLETED");
  assert.deepEqual(
    (await prisma.billSale.findUniqueOrThrow({ where: { id: bill.id } }))
      .vatSnapshot,
    bill.vatSnapshot,
  );
  process.env.VAT_DEMO_ENABLED = "true";
});

test("HTTP catalog edits persist explicit categories, preserve omission, reject invalid categories and stale quote", async () => {
  await setFood({ price: 1290n, taxCategory: "FOOD_NON_ALCOHOLIC" });
  const payload = {
    id: fixture.food.id,
    name: "Demo food",
    foodTypeId: fixture.category.id,
    foodType: "food",
    price: 12.9,
    img: "",
    remark: "",
  };
  for (const [extra, status] of [
    [{ taxCategory: "invalid" }, 400],
    [{}, 200],
  ]) {
    const response = await fetch(api.apiBaseUrl + "/food/update", {
      method: "PUT",
      headers: headersFor(fixture.admin),
      body: JSON.stringify({ ...payload, ...extra }),
    });
    assert.equal(response.status, status, await response.text());
  }
  assert.equal(
    (await prisma.food.findUniqueOrThrow({ where: { id: fixture.food.id } }))
      .taxCategory,
    "FOOD_NON_ALCOHOLIC",
  );
  const page = await fetch(
    api.apiBaseUrl + "/food/page?categoryId=" + fixture.category.id,
    { headers: headersFor(fixture.admin) },
  );
  assert.equal(
    (await page.json()).results.find((food) => food.id === fixture.food.id)
      .taxCategory,
    "FOOD_NON_ALCOHOLIC",
  );
  await assert.rejects(
    payDraft({ expectedTotal: 28.79 }),
    (error) => error.code === "QUOTE_CHANGED",
  );
  await setFood({ taxCategory: null });
  await assert.rejects(
    payDraft(),
    (error) => error.code === "VAT_CATEGORY_REQUIRED",
  );
});

test("QR and STAFF capture category before edits and table payment rounds across Orders", async () => {
  await setFood({ price: 10n, taxCategory: "FOOD_NON_ALCOHOLIC" });
  const table = await prisma.restaurantTable.create({
    data: { tableNo: 900000 + Math.floor(Math.random() * 90000) },
  });
  tables.push(table.id);
  const session = await prisma.tableSession.create({
    data: { restaurantTableId: table.id },
  });
  const orders = [];
  for (const [channel, quantity] of [
    ["QR", 1],
    ["STAFF", 2],
  ]) {
    let order = await submitOrder(prisma, {
      actor: channel === "QR" ? { type: "CUSTOMER" } : actor(),
      idempotencyKey: randomUUID(),
      intent: {
        channel,
        tableNo: table.tableNo,
        tableSessionId: session.id,
        items: [{ foodId: fixture.food.id, quantity }],
      },
    });
    assert.equal(order.Items[0].vatSnapshot.rateBps, 1350);
    for (const nextStatus of ["CONFIRMED", "PREPARING", "READY", "SERVED"])
      order = await transitionOrder(prisma, {
        actor: actor(),
        orderId: order.id,
        expectedVersion: order.version,
        nextStatus,
      });
    orders.push(order);
  }
  await setFood({ taxCategory: "ALCOHOL", price: 1000n });
  const request = {
    actor: actor(),
    sessionId: session.id,
    orders: orders.map(({ id, version }) => ({ id, version })),
    idempotencyKey: randomUUID(),
    payType: "bank",
  };
  const bill = await settleTableSession(prisma, request);
  assert.equal(bill.amount, 30n);
  assert.equal(bill.vatSnapshot.taxCents, "4");
  assert.deepEqual(
    (
      await prisma.billSaleDetail.findMany({
        where: { billSaleId: bill.id },
        orderBy: { id: "asc" },
      })
    ).map((line) => line.vatSnapshot.taxCents),
    ["2", "1", "1"],
  );
  assert.equal((await settleTableSession(prisma, request)).id, bill.id);
});

test("legacy bridge enabled and disabled both capture VAT while old records remain unknown", async () => {
  await setFood({ price: 10n, taxCategory: "FOOD_NON_ALCOHOLIC" });
  const prior = process.env.ORD02_COUNTER_CHECKOUT_ENABLED;
  try {
    for (const bridge of ["true", "false"]) {
      process.env.ORD02_COUNTER_CHECKOUT_ENABLED = bridge;
      const tableNo = bridge === "true" ? 910001 : 910002;
      await prisma.saleTemp.create({
        data: {
          userId: fixture.admin.id,
          tableNo,
          foodId: fixture.food.id,
          qty: 3,
          saleTempDetails: {
            create: Array.from({ length: 3 }, () => ({
              foodId: fixture.food.id,
            })),
          },
        },
      });
      const result = await endSale({
        user: fixture.admin,
        body: { tableNo, payType: "bank", idempotencyKey: randomUUID() },
      });
      const bill = await prisma.billSale.findUniqueOrThrow({
        where: { id: result.billId },
      });
      assert.equal(bill.amount, 30n);
      assert.equal(bill.vatSnapshot.taxCents, "4");
    }
    process.env.VAT_DEMO_ENABLED = "false";
    const bill = await payDraft({ expectedTotal: 3.2 });
    assert.equal(bill.vatSnapshot, null);
    assert.equal(bill.BillSaleDetails[0].vatSnapshot, null);
  } finally {
    if (prior === undefined) delete process.env.ORD02_COUNTER_CHECKOUT_ENABLED;
    else process.env.ORD02_COUNTER_CHECKOUT_ENABLED = prior;
    process.env.VAT_DEMO_ENABLED = "true";
  }
});

test("mixed pre-VAT and new table Orders settle without guessing or a partial breakdown", async () => {
  await setFood({ price: 10n, taxCategory: "FOOD_NON_ALCOHOLIC" });
  const table = await prisma.restaurantTable.create({
    data: { tableNo: 990000 + Math.floor(Math.random() * 9000) },
  });
  tables.push(table.id);
  const session = await prisma.tableSession.create({
    data: { restaurantTableId: table.id },
  });
  const orders = [];
  for (const enabled of ["false", "true"]) {
    process.env.VAT_DEMO_ENABLED = enabled;
    let order = await submitOrder(prisma, {
      actor: { type: "CUSTOMER" },
      idempotencyKey: randomUUID(),
      intent: {
        channel: "QR",
        tableNo: table.tableNo,
        tableSessionId: session.id,
        items: [{ foodId: fixture.food.id, quantity: 1 }],
      },
    });
    for (const nextStatus of ["CONFIRMED", "PREPARING", "READY", "SERVED"])
      order = await transitionOrder(prisma, {
        actor: actor(),
        orderId: order.id,
        expectedVersion: order.version,
        nextStatus,
      });
    orders.push(order);
  }
  const bill = await settleTableSession(prisma, {
    actor: actor(),
    sessionId: session.id,
    orders: orders.map(({ id, version }) => ({ id, version })),
    payType: "bank",
    idempotencyKey: randomUUID(),
  });
  assert.equal(bill.amount, 20n);
  assert.equal(bill.vatSnapshot, null);
  assert.ok(bill.BillSaleDetails.every((line) => line.vatSnapshot === null));
  assert.equal(
    (await prisma.tableSession.findUniqueOrThrow({ where: { id: session.id } }))
      .status,
    "CLOSED",
  );
});
