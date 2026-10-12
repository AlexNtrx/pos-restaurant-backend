const { test, before, after } = require("node:test");
const assert = require("node:assert/strict");
const { randomUUID, createHash } = require("node:crypto");
const {
  prisma,
  createTestFixture,
  cleanupTestFixture,
  startApiServer,
  stopApiServer,
  headersFor,
  beginOrganizationFixture,
  restoreOrganizationFixture,
} = require("./helpers");
const { transitionOrder } = require("../lib/order-service");
const { rotateToken } = require("../lib/table-service");

let fixture, api, organization, originalPolicy;
const tables = [];
before(async () => {
  fixture = await createTestFixture();
  organization = await beginOrganizationFixture();
  originalPolicy = await prisma.qrPolicy.findUnique({ where: { id: 1 } });
  api = await startApiServer();
});
after(async () => {
  await stopApiServer(api?.server);
  await cleanupTestFixture(fixture);
  await prisma.tableSession.deleteMany({
    where: { restaurantTableId: { in: tables } },
  });
  await prisma.restaurantTable.deleteMany({ where: { id: { in: tables } } });
  await restoreOrganizationFixture(organization);
  if (originalPolicy)
    await prisma.qrPolicy.update({ where: { id: 1 }, data: originalPolicy });
  else await prisma.qrPolicy.deleteMany({ where: { id: 1 } });
  await prisma.$disconnect();
});
const actor = () => ({
  type: "STAFF",
  userId: fixture.admin.id,
  level: "admin",
});
async function request(route, body, expected = 200, anonymous = false) {
  const response = await fetch(api.apiBaseUrl + route, {
    method: body === undefined ? "GET" : "POST",
    headers: anonymous
      ? { "Content-Type": "application/json" }
      : headersFor(fixture.admin),
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  const data = await response.json();
  assert.equal(response.status, expected, JSON.stringify(data));
  return data;
}
async function price(price, extra = 0.5) {
  for (const [route, body] of [
    [
      "/food/update",
      {
        ...fixture.food,
        price,
        img: "",
        foodType: "food",
        foodTypeId: fixture.category.id,
        remark: "",
      },
    ],
    [
      "/foodSize/update",
      {
        ...fixture.size,
        moneyAdded: extra,
        foodTypeId: fixture.category.id,
        remark: "",
      },
    ],
  ]) {
    const response = await fetch(api.apiBaseUrl + route, {
      method: "PUT",
      headers: headersFor(fixture.admin),
      body: JSON.stringify(body),
    });
    assert.equal(response.status, 200, await response.text());
  }
}

test("fractional Counter checkout, concurrent replay, immutable receipt, refund and reports reconcile", async () => {
  await price(12.9);
  const items = [
    {
      foodId: fixture.food.id,
      foodSizeId: fixture.size.id,
      tasteId: null,
      quantity: 3,
    },
  ];
  const quoted = await request("/counterOrder/quote", {
    serviceType: "TAKEAWAY",
    items,
  });
  assert.equal(quoted.results.total, 40.2);
  assert.equal(quoted.results.subtotal, 38.7);
  const body = {
    serviceType: "TAKEAWAY",
    items,
    expectedTotal: 40.2,
    inputMoney: 50,
    payType: "cash",
    idempotencyKey: randomUUID(),
  };
  const savedBody = JSON.stringify(body);
  await request("/counterOrder/checkout", { ...body, inputMoney: 50.001 }, 400);
  await request(
    "/counterOrder/checkout",
    { ...body, expectedTotal: 40.201 },
    400,
  );
  const [first, duplicate] = await Promise.all([
    request("/counterOrder/checkout", body),
    request("/counterOrder/checkout", body),
  ]);
  assert.equal(first.billId, duplicate.billId);
  assert.equal(first.amount, 40.2);
  assert.equal(first.returnMoney, 9.8);
  const bill = await prisma.billSale.findUniqueOrThrow({
    where: { id: first.billId },
    include: { Orders: true, BillSaleDetails: true },
  });
  assert.equal(bill.amount, 4020n);
  assert.equal(bill.inputMoney, 5000n);
  assert.equal(bill.returnMoney, 980n);
  assert.equal(bill.BillSaleDetails[0].price, 1290n);
  assert.equal(bill.BillSaleDetails[0].moneyAdded, 50n);
  assert.equal(
    await prisma.billSale.count({
      where: { userId: fixture.admin.id, idempotencyKey: body.idempotencyKey },
    }),
    1,
  );
  await price(13.01);
  assert.equal(
    (await request("/counterOrder/checkout", JSON.parse(savedBody))).amount,
    40.2,
  );
  assert.equal(JSON.stringify(body), savedBody);
  const pdf = await fetch(api.apiBaseUrl + "/saleTemp/printBillAfterPay", {
    method: "POST",
    headers: headersFor(fixture.admin),
    body: JSON.stringify({ billId: bill.id }),
  });
  assert.equal(pdf.status, 200);
  assert.equal(
    Buffer.from(await pdf.arrayBuffer())
      .subarray(0, 4)
      .toString(),
    "%PDF",
  );
  await prisma.billSale.update({
    where: { id: bill.id },
    data: { payDate: new Date("2040-02-10T12:00:00Z") },
  });
  const order = bill.Orders[0];
  const detail = await request(`/orders/${order.id}`);
  assert.equal(detail.result.total, 40.2);
  assert.equal(detail.result.receipt.amount, 40.2);
  const reserved = await request(`/orders/${order.id}/refund`, {
    expectedVersion: order.version,
    idempotencyKey: randomUUID(),
    reason: "Synthetic cents refund",
    method: "cash",
  });
  assert.equal(reserved.result.amount, 40.2);
  const reportBody = { year: 2040, month: 2 };
  const pending = await request("/report/dailySales", reportBody);
  assert.equal(pending.summary.grossAmount, 40.2);
  assert.equal(pending.summary.pendingRefundAmount, 40.2);
  const completion = {
    idempotencyKey: reserved.result.idempotencyKey,
    reference: "Synthetic refund confirmation",
  };
  const completed = await request(
    `/orders/${order.id}/refund/complete`,
    completion,
  );
  assert.equal(
    (await request(`/orders/${order.id}/refund/complete`, completion)).result
      .id,
    completed.result.id,
  );
  const report = await request("/report/dailySales", reportBody);
  assert.equal(report.summary.refundedAmount, 40.2);
  assert.equal(report.totalAmount, 0);
  assert.equal(
    (await request("/report/sumMonthly", { year: 2040 })).totalAmount,
    0,
  );
  assert.deepEqual(
    await prisma.billSaleDetail.findMany({ where: { billSaleId: bill.id } }),
    bill.BillSaleDetails,
  );
});

test("settlement overflow is a recoverable conflict and cannot commit a bill or close a session", async () => {
  const table = await prisma.restaurantTable.create({
    data: { tableNo: 987670 },
  });
  tables.push(table.id);
  const session = await prisma.tableSession.create({
    data: { restaurantTableId: table.id },
  });
  const orders = [];
  for (const total of [9007199254740000n, 100000n]) {
    const order = await prisma.order.create({
      data: {
        channel: "STAFF",
        status: "SERVED",
        tableNo: table.tableNo,
        restaurantTableId: table.id,
        tableSessionId: session.id,
        createdByUserId: fixture.admin.id,
        subtotal: total,
        modifierTotal: 0n,
        total,
        idempotencyScope: "SYNTHETIC_OVERFLOW",
        idempotencyKey: randomUUID(),
        idempotencyFingerprint: "a".repeat(64),
        Items: {
          create: {
            foodId: fixture.food.id,
            foodName: "Synthetic overflow",
            quantity: 1,
            unitBasePrice: total,
            unitModifierTotal: 0n,
            unitTotal: total,
            lineTotal: total,
          },
        },
      },
    });
    orders.push({ id: order.id, version: order.version });
  }
  const response = await request(
    `/table-sessions/${session.id}/settle`,
    { orders, idempotencyKey: randomUUID(), payType: "bank" },
    409,
  );
  assert.equal(response.code, "TOTAL_OUT_OF_RANGE");
  assert.equal(
    await prisma.billSale.count({ where: { tableSessionId: session.id } }),
    0,
  );
  assert.equal(
    (await prisma.tableSession.findUniqueOrThrow({ where: { id: session.id } }))
      .status,
    "OPEN",
  );
  assert.equal(
    await prisma.order.count({
      where: { tableSessionId: session.id, status: "SERVED", billSaleId: null },
    }),
    2,
  );
});

test("lossy cash change rejects before financial commit in draft, legacy and table settlement", async () => {
  await price(0.07, 0);
  const received = 90071992547400;
  const key = randomUUID();
  await request(
    "/counterOrder/checkout",
    {
      serviceType: "TAKEAWAY",
      payType: "cash",
      inputMoney: received,
      expectedTotal: 0.07,
      idempotencyKey: key,
      items: [{ foodId: fixture.food.id, quantity: 1 }],
    },
    400,
  );
  assert.equal(
    await prisma.billSale.count({
      where: { userId: fixture.admin.id, idempotencyKey: key },
    }),
    0,
  );
  assert.equal(await prisma.order.count({ where: { idempotencyKey: key } }), 0);
  const legacyKey = randomUUID();
  await request("/saleTemp/create", {
    tableNo: 987675,
    foodId: fixture.food.id,
  });
  await request(
    "/saleTemp/endSale",
    {
      tableNo: 987675,
      payType: "cash",
      inputMoney: received,
      idempotencyKey: legacyKey,
    },
    400,
  );
  assert.equal(
    await prisma.billSale.count({
      where: { userId: fixture.admin.id, idempotencyKey: legacyKey },
    }),
    0,
  );
  assert.equal(
    await prisma.saleTemp.count({
      where: { userId: fixture.admin.id, tableNo: 987675 },
    }),
    1,
  );
  const table = await prisma.restaurantTable.create({
    data: { tableNo: 987676 },
  });
  tables.push(table.id);
  const session = await prisma.tableSession.create({
    data: { restaurantTableId: table.id },
  });
  const order = await prisma.order.create({
    data: {
      channel: "STAFF",
      status: "SERVED",
      tableNo: table.tableNo,
      tableSessionId: session.id,
      restaurantTableId: table.id,
      createdByUserId: fixture.admin.id,
      subtotal: 7n,
      modifierTotal: 0n,
      total: 7n,
      idempotencyScope: "SYNTHETIC_CHANGE",
      idempotencyKey: randomUUID(),
      idempotencyFingerprint: "a".repeat(64),
      Items: {
        create: {
          foodId: fixture.food.id,
          foodName: "Synthetic change",
          quantity: 1,
          unitBasePrice: 7n,
          unitModifierTotal: 0n,
          unitTotal: 7n,
          lineTotal: 7n,
        },
      },
    },
  });
  await request(
    `/table-sessions/${session.id}/settle`,
    {
      orders: [{ id: order.id, version: order.version }],
      payType: "cash",
      inputMoney: received,
      idempotencyKey: randomUUID(),
    },
    409,
  );
  assert.equal(
    await prisma.billSale.count({ where: { tableSessionId: session.id } }),
    0,
  );
  assert.equal(
    (await prisma.tableSession.findUniqueOrThrow({ where: { id: session.id } }))
      .status,
    "OPEN",
  );
});

test("old whole-EUR legacy pending requests replay committed and uncommitted intent without scaling bodies", async () => {
  await price(12.9, 0);
  const body = {
    tableNo: 987650,
    payType: "cash",
    inputMoney: 20,
    idempotencyKey: randomUUID(),
  };
  const fingerprint = createHash("sha256")
    .update(
      JSON.stringify({
        tableNo: body.tableNo,
        payType: "cash",
        inputMoney: 20,
      }),
    )
    .digest("hex");
  const original = await prisma.billSale.create({
    data: {
      amount: 2000n,
      inputMoney: 2000n,
      returnMoney: 0n,
      tableNo: body.tableNo,
      userId: fixture.admin.id,
      payType: "cash",
      idempotencyKey: body.idempotencyKey,
      checkoutFingerprint: fingerprint,
    },
  });
  const committed = await request("/saleTemp/endSale", body);
  assert.equal(committed.billId, original.id);
  assert.equal(committed.amount, 20);
  const uncommitted = {
    ...body,
    tableNo: body.tableNo + 1,
    idempotencyKey: randomUUID(),
  };
  await request("/saleTemp/create", {
    tableNo: uncommitted.tableNo,
    foodId: fixture.food.id,
  });
  const first = await request("/saleTemp/endSale", uncommitted);
  const replay = await request(
    "/saleTemp/endSale",
    JSON.parse(JSON.stringify(uncommitted)),
  );
  assert.equal(replay.billId, first.billId);
  assert.equal(replay.amount, 12.9);
  assert.equal(replay.inputMoney, 20);
  assert.equal(replay.returnMoney, 7.1);
  assert.equal(
    (await prisma.billSale.findUniqueOrThrow({ where: { id: original.id } }))
      .checkoutFingerprint,
    fingerprint,
  );
});

test("QR and waiter estimates of 0.10 times three settle a shared table with exact cash change", async () => {
  await price(0.1, 0);
  const table = await prisma.restaurantTable.create({
    data: { tableNo: 987660 },
  });
  tables.push(table.id);
  const session = await prisma.tableSession.create({
    data: { restaurantTableId: table.id },
  });
  const access = await rotateToken(prisma, session.id, 0);
  await prisma.qrPolicy.upsert({
    where: { id: 1 },
    create: { id: 1, mode: "ORDERING" },
    update: { mode: "ORDERING" },
  });
  const items = [
    {
      foodId: fixture.food.id,
      foodSizeId: null,
      tasteId: null,
      quantity: 3,
      note: "",
    },
  ];
  const qrBody = { idempotencyKey: randomUUID(), expectedTotal: 0.3, items };
  const qr = (await request(`/qr/${access.token}/orders`, qrBody, 201, true))
    .result;
  assert.equal(qr.total, 0.3);
  assert.equal(
    (await request(`/qr/${access.token}/orders`, qrBody, 201, true)).result
      .orderId,
    qr.orderId,
  );
  const waiter = (
    await request(
      "/waiter/orders",
      {
        tableSessionId: session.id,
        idempotencyKey: randomUUID(),
        expectedTotal: 0.3,
        items,
      },
      201,
    )
  ).result;
  assert.equal(waiter.total, 0.3);
  const orders = [];
  for (const id of [qr.orderId, waiter.id]) {
    let order = await prisma.order.findUniqueOrThrow({ where: { id } });
    for (const nextStatus of ["PREPARING", "READY", "SERVED"])
      order = await transitionOrder(prisma, {
        actor: actor(),
        orderId: id,
        expectedVersion: order.version,
        nextStatus,
      });
    orders.push({ id, version: order.version });
  }
  const body = {
    orders,
    idempotencyKey: randomUUID(),
    payType: "cash",
    inputMoney: 1.1,
  };
  const paid = await request(`/table-sessions/${session.id}/settle`, body);
  assert.equal(paid.amount, 0.6);
  assert.equal(paid.returnMoney, 0.5);
  assert.equal(
    (await request(`/table-sessions/${session.id}/settle`, body)).billId,
    paid.billId,
  );
});
