const { after, before, test } = require("node:test");
const assert = require("node:assert/strict");
const { randomUUID } = require("node:crypto");
const { existsSync, readdirSync } = require("node:fs");
const { once } = require("node:events");
const jwt = require("jsonwebtoken");
const { PrismaClient } = require("@prisma/client");
const { submitOrder, transitionOrder } = require("../lib/order-service");
const {
  beginOrganizationFixture,
  cleanupTestFixture,
  createTestFixture,
  restoreOrganizationFixture,
} = require("./helpers");

const prisma = new PrismaClient();
let apiBaseUrl;
let origin;
let apiServer;
let owner;
let otherUser;
let food;
let size;
let ownerToken;
let otherToken;
const createdBillIds = new Set();
const baseTable = 800000 + (Date.now() % 90000);
const testTables = Array.from({ length: 23 }, (_, index) => baseTable + index);
let fixture;
let organizationFixture;

// Coordinates bearer behavior for this module.
const bearer = (token) => ({ Authorization: `Bearer ${token}` });
// Coordinates json request behavior for this module.
const jsonRequest = (token, body) => ({
  headers: { ...bearer(token), "Content-Type": "application/json" },
  body: JSON.stringify(body),
});
// Coordinates checkout body while preserving transaction behavior.
const checkoutBody = (tableNo, overrides = {}) => ({
  tableNo,
  payType: "cash",
  inputMoney: 100000,
  idempotencyKey: randomUUID(),
  ...overrides,
});

// Removes or clears test data using the existing workflow.
const clearTestData = async () => {
  await prisma.$transaction(async (tx) => {
    await tx.saleTempDetail.deleteMany({
      where: { SaleTemp: { tableNo: { in: testTables } } },
    });
    await tx.saleTemp.deleteMany({ where: { tableNo: { in: testTables } } });
    const billIds = [...createdBillIds];
    if (billIds.length > 0) {
      await tx.order.deleteMany({
        where: { billSaleId: { in: billIds } },
      });
      await tx.billSaleDetail.deleteMany({
        where: { billSaleId: { in: billIds } },
      });
      await tx.billSale.deleteMany({ where: { id: { in: billIds } } });
    }
  });
};

// Creates cart with the current contract.
const createCart = async (tableNo) => {
  const response = await fetch(`${apiBaseUrl}/saleTemp/create`, {
    method: "POST",
    ...jsonRequest(ownerToken, { tableNo, foodId: food.id }),
  });
  assert.equal(response.status, 200);
  return prisma.saleTemp.findUnique({
    where: {
      userId_tableNo_foodId: { userId: owner.id, tableNo, foodId: food.id },
    },
    include: { saleTempDetails: true },
  });
};

// Coordinates checkout while preserving transaction behavior.
const checkout = async (token, body) => {
  const response = await fetch(`${apiBaseUrl}/saleTemp/endSale`, {
    method: "POST",
    ...jsonRequest(token, body),
  });
  const payload = await response.json();
  if (payload.billId) createdBillIds.add(payload.billId);
  return { response, payload };
};

const submitToKitchen = async (token, body) => {
  const response = await fetch(apiBaseUrl + "/saleTemp/submitToKitchen", {
    method: "POST",
    ...jsonRequest(token, body),
  });
  return { response, payload: await response.json() };
};

const settleCounter = async (token, orderId, body) => {
  const response = await fetch(
    apiBaseUrl + "/counterOrder/" + orderId + "/settle",
    {
      method: "POST",
      ...jsonRequest(token, body),
    },
  );
  const payload = await response.json();
  if (payload.billId) createdBillIds.add(payload.billId);
  return { response, payload };
};

const kitchenOrder = async (tableNo) => {
  return submitOrder(prisma, {
    actor: { type: "STAFF", userId: owner.id, level: owner.level },
    idempotencyKey: randomUUID(),
    intent: {
      channel: "COUNTER",
      tableNo,
      items: [{ foodId: food.id, quantity: 1 }],
    },
    confirmForKitchen: true,
  });
};

const advanceOrder = (order, nextStatus) =>
  transitionOrder(prisma, {
    actor: { type: "STAFF", userId: owner.id, level: owner.level },
    orderId: order.id,
    expectedVersion: order.version,
    nextStatus,
  });

const servedOrder = async (tableNo) => {
  let order = await kitchenOrder(tableNo);
  for (const status of ["PREPARING", "READY", "SERVED"])
    order = await advanceOrder(order, status);
  return order;
};

test("Counter payment and receipt work before service while Kitchen can finish the Order", async () => {
  let order = await kitchenOrder(testTables[13]);
  const newCart = await createCart(testTables[13]);
  const previewPath = `${apiBaseUrl}/counterOrder/${order.id}/prebill`;
  const preview = await fetch(previewPath, {
    method: "POST",
    ...jsonRequest(ownerToken, {}),
  });
  assert.equal(preview.status, 200);
  assert.equal(
    Buffer.from(await preview.arrayBuffer())
      .subarray(0, 4)
      .toString(),
    "%PDF",
  );
  const foreignPreview = await fetch(previewPath, {
    method: "POST",
    ...jsonRequest(otherToken, {}),
  });
  assert.equal(foreignPreview.status, 404);
  const body = {
    expectedVersion: order.version,
    idempotencyKey: randomUUID(),
    payType: "cash",
    inputMoney: order.total + 10,
    amount: 1,
    userId: otherUser.id,
    actor: { userId: otherUser.id },
    counterOnly: false,
  };
  await prisma.food.update({
    where: { id: food.id },
    data: { price: food.price + 100, name: food.name + "-new" },
  });
  try {
    const { response, payload } = await settleCounter(
      ownerToken,
      order.id,
      body,
    );
    assert.equal(response.status, 200);
    assert.equal(payload.amount, order.total);
    assert.equal(payload.returnMoney, 10);
    const bill = await prisma.billSale.findUnique({
      where: { id: payload.billId },
      include: { BillSaleDetails: true },
    });
    assert.equal(bill.userId, owner.id);
    assert.equal(bill.BillSaleDetails[0].price, food.price);
    assert.equal(bill.BillSaleDetails[0].foodName, food.name);
    const paid = await prisma.order.findUnique({
      where: { id: order.id },
      include: { StatusHistory: { orderBy: { version: "asc" } } },
    });
    assert.equal(paid.status, "CONFIRMED");
    assert.equal(paid.billSaleId, bill.id);
    assert.ok(paid.paidAt);
    const afterPaymentPreview = await fetch(previewPath, {
      method: "POST",
      ...jsonRequest(ownerToken, {}),
    });
    assert.equal(afterPaymentPreview.status, 404);
    assert.deepEqual(
      paid.StatusHistory.map(({ toStatus }) => toStatus),
      ["SUBMITTED", "CONFIRMED", "CONFIRMED"],
    );
    assert.equal(
      paid.StatusHistory.at(-1).reason,
      "Payment recorded before service",
    );
    const kitchenQueue = await fetch(apiBaseUrl + "/orders?status=CONFIRMED", {
      headers: bearer(otherToken),
    });
    assert.equal(kitchenQueue.status, 200);
    assert.ok(
      (await kitchenQueue.json()).results.some(
        ({ id, version }) => id === order.id && version === paid.version,
      ),
    );
    assert.ok(await prisma.saleTemp.findUnique({ where: { id: newCart.id } }));
    const pending = await fetch(
      apiBaseUrl + "/saleTemp/pendingCounterOrders?tableNo=" + testTables[13],
      { headers: bearer(ownerToken) },
    );
    assert.equal((await pending.json()).results.length, 0);
    const receipt = await fetch(apiBaseUrl + "/saleTemp/printBillAfterPay", {
      method: "POST",
      ...jsonRequest(ownerToken, { billId: bill.id }),
    });
    assert.equal(receipt.status, 200);
    assert.equal(
      Buffer.from(await receipt.arrayBuffer())
        .subarray(0, 4)
        .toString(),
      "%PDF",
    );
    const duplicate = await settleCounter(ownerToken, order.id, {
      expectedVersion: paid.version,
      idempotencyKey: randomUUID(),
      payType: "bank",
    });
    assert.equal(duplicate.payload.code, "ORDER_NOT_PAYABLE");
    await assert.rejects(
      transitionOrder(prisma, {
        actor: { type: "STAFF", userId: owner.id, level: owner.level },
        orderId: order.id,
        expectedVersion: paid.version,
        nextStatus: "CANCELLED",
        reason: "Customer changed mind",
      }),
      { code: "ORDER_ALREADY_PAID" },
    );
    let version = paid.version;
    for (const nextStatus of ["PREPARING", "READY", "SERVED"]) {
      const path =
        nextStatus === "SERVED"
          ? `/orders/${order.id}/serve`
          : `/kitchen/orders/${order.id}/status`;
      const action = await fetch(apiBaseUrl + path, {
        method: "PATCH",
        ...jsonRequest(otherToken, {
          expectedVersion: version,
          ...(nextStatus === "SERVED" ? {} : { nextStatus }),
        }),
      });
      assert.equal(action.status, 200);
      version = (await action.json()).result.version;
    }
    order = await prisma.order.findUnique({
      where: { id: order.id },
      include: { StatusHistory: { orderBy: { version: "asc" } } },
    });
    assert.equal(order.status, "COMPLETED");
    assert.equal(order.billSaleId, bill.id);
    assert.ok(order.servedAt);
    assert.ok(order.completedAt);
    assert.ok(order.paidAt < order.servedAt);
    assert.deepEqual(
      order.StatusHistory.map(({ toStatus }) => toStatus),
      [
        "SUBMITTED",
        "CONFIRMED",
        "CONFIRMED",
        "PREPARING",
        "READY",
        "SERVED",
        "COMPLETED",
      ],
    );
  } finally {
    await prisma.food.update({
      where: { id: food.id },
      data: { price: food.price, name: food.name },
    });
  }
});

test("Counter settlement enforces owner, channel, version, and sufficient cash before writing", async () => {
  const order = await servedOrder(testTables[14]);
  const body = {
    expectedVersion: order.version,
    idempotencyKey: randomUUID(),
    payType: "cash",
    inputMoney: order.total - 1,
  };
  assert.equal(
    (await settleCounter(otherToken, order.id, { ...body, userId: owner.id }))
      .response.status,
    404,
  );
  const anonymous = await fetch(
    apiBaseUrl + "/counterOrder/" + order.id + "/settle",
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    },
  );
  assert.equal(anonymous.status, 401);
  assert.equal(
    (await settleCounter(ownerToken, order.id, { ...body, expectedVersion: 0 }))
      .response.status,
    400,
  );
  const stale = await settleCounter(ownerToken, order.id, {
    ...body,
    expectedVersion: order.version - 1,
  });
  assert.equal(stale.payload.code, "STALE_VERSION");
  const insufficient = await settleCounter(ownerToken, order.id, body);
  assert.equal(insufficient.payload.code, "INSUFFICIENT_CASH");
  const qrTable = await prisma.restaurantTable.create({
    data: { tableNo: testTables[17] },
  });
  const qrSession = await prisma.tableSession.create({
    data: { restaurantTableId: qrTable.id },
  });
  let qrOrder;
  try {
    qrOrder = await submitOrder(prisma, {
      actor: { type: "STAFF", userId: owner.id, level: owner.level },
      idempotencyKey: randomUUID(),
      intent: {
        channel: "QR",
        tableNo: qrTable.tableNo,
        tableSessionId: qrSession.id,
        items: [{ foodId: food.id, quantity: 1 }],
      },
    });
    assert.equal(
      (
        await settleCounter(ownerToken, qrOrder.id, {
          ...body,
          expectedVersion: qrOrder.version,
        })
      ).response.status,
      404,
    );
  } finally {
    if (qrOrder) await prisma.order.delete({ where: { id: qrOrder.id } });
    await prisma.tableSession.delete({ where: { id: qrSession.id } });
    await prisma.restaurantTable.delete({ where: { id: qrTable.id } });
  }
  assert.equal(
    await prisma.billSale.count({
      where: { userId: owner.id, tableNo: order.tableNo },
    }),
    0,
  );
  assert.equal(
    (await prisma.order.findUnique({ where: { id: order.id } })).status,
    "SERVED",
  );
});

test("concurrent exact Counter payment retries return one bill and conflicting reuse is rejected", async () => {
  const order = await servedOrder(testTables[15]);
  const body = {
    expectedVersion: order.version,
    idempotencyKey: randomUUID(),
    payType: "bank",
    inputMoney: 999999,
  };
  const results = await Promise.all([
    settleCounter(ownerToken, order.id, body),
    settleCounter(ownerToken, order.id, body),
  ]);
  assert.ok(results.every(({ response }) => response.status === 200));
  assert.equal(results[0].payload.billId, results[1].payload.billId);
  assert.equal(results[0].payload.inputMoney, order.total);
  assert.equal(results[0].payload.returnMoney, 0);
  assert.equal(
    await prisma.billSale.count({
      where: { userId: owner.id, tableNo: order.tableNo },
    }),
    1,
  );
  assert.equal(
    (await settleCounter(ownerToken, order.id, { ...body, payType: "cash" }))
      .response.status,
    409,
  );
  assert.equal(
    (
      await settleCounter(ownerToken, order.id, {
        ...body,
        idempotencyKey: randomUUID(),
      })
    ).response.status,
    409,
  );
});

test("different concurrent Counter payment keys cannot bill an Order twice", async () => {
  const order = await servedOrder(testTables[16]);
  const results = await Promise.all(
    [0, 1].map(() =>
      settleCounter(ownerToken, order.id, {
        expectedVersion: order.version,
        idempotencyKey: randomUUID(),
        payType: "bank",
      }),
    ),
  );
  assert.deepEqual(
    results.map(({ response }) => response.status).sort(),
    [200, 409],
  );
  assert.equal(
    await prisma.billSale.count({
      where: { userId: owner.id, tableNo: order.tableNo },
    }),
    1,
  );
});

before(async () => {
  const { app } = require("../server");
  apiServer = app.listen(0, "127.0.0.1");
  if (!apiServer.listening) await once(apiServer, "listening");
  origin = `http://127.0.0.1:${apiServer.address().port}`;
  apiBaseUrl = `${origin}/api`;

  fixture = await createTestFixture();
  organizationFixture = await beginOrganizationFixture();
  owner = fixture.admin;
  otherUser = fixture.user;
  food = fixture.food;
  size = fixture.size;
  ownerToken = jwt.sign(
    { id: owner.id, level: owner.level },
    process.env.SECRET_KEY,
    { expiresIn: "5m" },
  );
  otherToken = jwt.sign(
    { id: otherUser.id, level: otherUser.level },
    process.env.SECRET_KEY,
    { expiresIn: "5m" },
  );
  await clearTestData();
});

after(async () => {
  await clearTestData();
  if (apiServer?.listening) {
    await new Promise((resolve, reject) =>
      apiServer.close((error) => (error ? reject(error) : resolve())),
    );
  }
  await prisma.$disconnect();
  await restoreOrganizationFixture(organizationFixture);
  await cleanupTestFixture(fixture);
});

test("checkout validates its contract and does not create an empty bill", async () => {
  const missingKey = await checkout(ownerToken, {
    tableNo: testTables[0],
    payType: "cash",
    inputMoney: 10,
  });
  assert.equal(missingKey.response.status, 400);

  const empty = await checkout(ownerToken, checkoutBody(testTables[0]));
  assert.equal(empty.response.status, 409);
  assert.equal(
    await prisma.billSale.count({
      where: { tableNo: testTables[0], userId: owner.id },
    }),
    0,
  );
});

test("checkout ignores forged authority and finalizes only the authenticated selected table", async () => {
  const selectedCart = await createCart(testTables[1]);
  await createCart(testTables[2]);
  const otherCartResponse = await fetch(`${apiBaseUrl}/saleTemp/create`, {
    method: "POST",
    ...jsonRequest(otherToken, { tableNo: testTables[1], foodId: food.id }),
  });
  assert.equal(otherCartResponse.status, 200);
  const selectSizeResponse = await fetch(`${apiBaseUrl}/saleTemp/selectSize`, {
    method: "PUT",
    ...jsonRequest(ownerToken, {
      saleTempDetailId: selectedCart.saleTempDetails[0].id,
      sizeId: size.id,
    }),
  });
  assert.equal(selectSizeResponse.status, 200);

  const expectedAmount = food.price + size.moneyAdded;
  const body = checkoutBody(testTables[1], {
    inputMoney: expectedAmount + 10,
    userId: otherUser.id,
    amount: 1,
    returnMoney: 999999,
  });
  const { response, payload } = await checkout(ownerToken, body);
  assert.equal(response.status, 200);
  assert.equal(payload.amount, expectedAmount);
  assert.equal(payload.inputMoney, expectedAmount + 10);
  assert.equal(payload.returnMoney, 10);

  const bill = await prisma.billSale.findUnique({
    where: { id: payload.billId },
    include: { BillSaleDetails: true },
  });
  assert.equal(bill.userId, owner.id);
  assert.equal(bill.tableNo, testTables[1]);
  assert.equal(bill.amount, expectedAmount);
  assert.equal(bill.BillSaleDetails.length, 1);
  assert.equal(bill.BillSaleDetails[0].foodName, food.name);
  assert.equal(bill.BillSaleDetails[0].foodSizeName, size.name);
  assert.equal(bill.BillSaleDetails[0].price, food.price);
  assert.equal(bill.BillSaleDetails[0].moneyAdded, size.moneyAdded);
  const order = await prisma.order.findFirst({
    where: { billSaleId: bill.id },
    include: {
      Items: { include: { Modifiers: true } },
      StatusHistory: { orderBy: { version: "asc" } },
    },
  });
  assert.ok(order);
  assert.equal(order.channel, "COUNTER");
  assert.equal(order.status, "CONFIRMED");
  assert.ok(order.paidAt);
  assert.equal(order.createdByUserId, owner.id);
  assert.equal(order.total, expectedAmount);
  assert.equal(order.Items.length, 1);
  assert.equal(order.Items[0].Modifiers[0].foodSizeId, size.id);
  assert.deepEqual(
    order.StatusHistory.map(({ toStatus }) => toStatus),
    ["SUBMITTED", "CONFIRMED", "CONFIRMED"],
  );
  assert.equal(
    await prisma.saleTemp.count({
      where: { userId: owner.id, tableNo: testTables[1] },
    }),
    0,
  );
  assert.equal(
    await prisma.saleTemp.count({
      where: { userId: owner.id, tableNo: testTables[2] },
    }),
    1,
  );
  assert.equal(
    await prisma.saleTemp.count({
      where: { userId: otherUser.id, tableNo: testTables[1] },
    }),
    1,
  );

  const replay = await checkout(ownerToken, body);
  assert.equal(replay.response.status, 200);
  assert.equal(replay.payload.billId, payload.billId);
  assert.equal(replay.payload.replayed, true);
  assert.equal(
    await prisma.billSale.count({
      where: { userId: owner.id, idempotencyKey: body.idempotencyKey },
    }),
    1,
  );
  assert.equal(
    await prisma.order.count({
      where: {
        idempotencyScope: "USER:" + owner.id,
        idempotencyKey: body.idempotencyKey,
      },
    }),
    1,
  );

  const conflict = await checkout(ownerToken, {
    ...body,
    inputMoney: body.inputMoney + 1,
  });
  assert.equal(conflict.response.status, 409);
});

test("bank checkout records exact server total with zero change", async () => {
  const body = checkoutBody(testTables[2], {
    payType: "bank",
    inputMoney: 999999,
  });
  const { response, payload } = await checkout(ownerToken, body);
  assert.equal(response.status, 200);
  assert.equal(payload.amount, food.price);
  assert.equal(payload.inputMoney, food.price);
  assert.equal(payload.returnMoney, 0);
});

test("invalid cash payment preserves the cart and creates no bill", async () => {
  await createCart(testTables[3]);
  const key = randomUUID();
  const { response } = await checkout(
    ownerToken,
    checkoutBody(testTables[3], { inputMoney: 0, idempotencyKey: key }),
  );
  assert.equal(response.status, 400);
  assert.equal(
    await prisma.saleTemp.count({
      where: { userId: owner.id, tableNo: testTables[3] },
    }),
    1,
  );
  assert.equal(
    await prisma.billSale.count({
      where: { userId: owner.id, idempotencyKey: key },
    }),
    0,
  );
  assert.equal(
    await prisma.order.count({
      where: { idempotencyScope: "USER:" + owner.id, idempotencyKey: key },
    }),
    0,
  );
});

test("concurrent checkout attempts create exactly one bill", async () => {
  await createCart(testTables[4]);
  const results = await Promise.all([
    checkout(ownerToken, checkoutBody(testTables[4])),
    checkout(ownerToken, checkoutBody(testTables[4])),
  ]);
  assert.deepEqual(
    results.map(({ response }) => response.status).sort(),
    [200, 409],
  );
  assert.equal(
    await prisma.billSale.count({
      where: { userId: owner.id, tableNo: testTables[4] },
    }),
    1,
  );
  assert.equal(
    await prisma.order.count({
      where: { createdByUserId: owner.id, tableNo: testTables[4] },
    }),
    1,
  );
});

test("concurrent exact retries return the same bill", async () => {
  await createCart(testTables[6]);
  const body = checkoutBody(testTables[6]);
  const results = await Promise.all([
    checkout(ownerToken, body),
    checkout(ownerToken, body),
  ]);
  assert.ok(results.every(({ response }) => response.status === 200));
  assert.equal(results[0].payload.billId, results[1].payload.billId);
  assert.equal(
    await prisma.billSale.count({
      where: { userId: owner.id, idempotencyKey: body.idempotencyKey },
    }),
    1,
  );
  assert.equal(
    await prisma.order.count({
      where: {
        idempotencyScope: "USER:" + owner.id,
        idempotencyKey: body.idempotencyKey,
      },
    }),
    1,
  );
});

test("Counter checkout groups a legacy cart with more than 200 units", async () => {
  const cart = await createCart(testTables[8]);
  const update = await fetch(apiBaseUrl + "/saleTemp/updateQty", {
    method: "PUT",
    ...jsonRequest(ownerToken, { id: cart.id, qty: 201 }),
  });
  assert.equal(update.status, 200);
  const { response, payload } = await checkout(
    ownerToken,
    checkoutBody(testTables[8], { payType: "bank" }),
  );
  assert.equal(response.status, 200);
  assert.equal(payload.amount, food.price * 201);
  const order = await prisma.order.findFirst({
    where: { billSaleId: payload.billId },
    include: { Items: true },
  });
  assert.ok(order);
  assert.equal(order.Items.length, 1);
  assert.equal(order.Items[0].quantity, 201);
  assert.equal(
    await prisma.billSaleDetail.count({
      where: { billSaleId: payload.billId },
    }),
    201,
  );
});

test("an Order key conflict rolls back checkout and preserves the cart", async () => {
  const key = randomUUID();
  await submitOrder(prisma, {
    actor: { type: "STAFF", userId: owner.id, level: owner.level },
    idempotencyKey: key,
    intent: {
      channel: "COUNTER",
      tableNo: testTables[9],
      items: [{ foodId: food.id, quantity: 1 }],
    },
  });
  await createCart(testTables[10]);
  const { response } = await checkout(
    ownerToken,
    checkoutBody(testTables[10], { idempotencyKey: key }),
  );
  assert.equal(response.status, 409);
  assert.equal(
    await prisma.billSale.count({
      where: { userId: owner.id, idempotencyKey: key },
    }),
    0,
  );
  assert.equal(
    await prisma.saleTemp.count({
      where: { userId: owner.id, tableNo: testTables[10] },
    }),
    1,
  );
});

test("disabling the Counter bridge uses legacy checkout without deleting prior Orders", async () => {
  const existing = await prisma.order.findFirst({
    where: {
      channel: "COUNTER",
      createdByUserId: owner.id,
      billSaleId: { not: null },
    },
    select: { id: true },
  });
  assert.ok(existing);
  await createCart(testTables[5]);
  const previous = process.env.ORD02_COUNTER_CHECKOUT_ENABLED;
  process.env.ORD02_COUNTER_CHECKOUT_ENABLED = "false";
  try {
    const { response, payload } = await checkout(
      ownerToken,
      checkoutBody(testTables[5]),
    );
    assert.equal(response.status, 200);
    assert.equal(
      await prisma.order.count({ where: { billSaleId: payload.billId } }),
      0,
    );
  } finally {
    if (previous === undefined)
      delete process.env.ORD02_COUNTER_CHECKOUT_ENABLED;
    else process.env.ORD02_COUNTER_CHECKOUT_ENABLED = previous;
  }
  assert.ok(await prisma.order.findUnique({ where: { id: existing.id } }));
});

test("legacy Counter send requires payment and leaves every cart untouched", async () => {
  const selected = testTables[7];
  await createCart(selected);
  await createCart(testTables[9]);
  const key = randomUUID();
  const body = { tableNo: selected, idempotencyKey: key };
  const [first, retry] = await Promise.all([
    submitToKitchen(ownerToken, body),
    submitToKitchen(ownerToken, body),
  ]);
  for (const result of [first, retry]) {
    assert.equal(result.response.status, 409);
    assert.equal(result.payload.code, "PAYMENT_REQUIRED");
  }
  assert.equal(
    await prisma.order.count({
      where: {
        idempotencyScope: "COUNTER_KITCHEN_USER:" + owner.id,
        idempotencyKey: key,
      },
    }),
    0,
  );
  assert.equal(
    await prisma.billSale.count({
      where: { userId: owner.id, tableNo: selected },
    }),
    0,
  );
  assert.equal(
    await prisma.saleTemp.count({
      where: { userId: owner.id, tableNo: selected },
    }),
    1,
  );
  assert.equal(
    await prisma.saleTemp.count({
      where: { userId: owner.id, tableNo: testTables[9] },
    }),
    1,
  );
  const committed = await kitchenOrder(selected);
  await prisma.order.update({
    where: { id: committed.id },
    data: { idempotencyScope: "COUNTER_KITCHEN_USER:" + owner.id },
  });
  const replay = await submitToKitchen(ownerToken, {
    tableNo: selected,
    idempotencyKey: committed.idempotencyKey,
  });
  assert.equal(replay.response.status, 200);
  assert.equal(replay.payload.orderId, committed.id);
  assert.equal(replay.payload.replayed, true);
  assert.equal(
    await prisma.saleTemp.count({
      where: { userId: owner.id, tableNo: selected },
    }),
    1,
  );
});

test("receipts stream complete PDFs by authorized bill id and legacy files are blocked", async () => {
  const bill = await prisma.billSale.findFirst({
    where: { id: { in: [...createdBillIds] }, userId: owner.id },
    orderBy: { id: "asc" },
  });
  assert.ok(bill);

  const denied = await fetch(`${apiBaseUrl}/saleTemp/printBillAfterPay`, {
    method: "POST",
    ...jsonRequest(otherToken, { billId: bill.id }),
  });
  assert.equal(denied.status, 404);

  const receipt = await fetch(`${apiBaseUrl}/saleTemp/printBillAfterPay`, {
    method: "POST",
    ...jsonRequest(ownerToken, { billId: bill.id }),
  });
  assert.equal(receipt.status, 200);
  assert.match(receipt.headers.get("content-type"), /application\/pdf/);
  assert.match(receipt.headers.get("cache-control"), /private/);
  const bytes = Buffer.from(await receipt.arrayBuffer());
  assert.equal(bytes.subarray(0, 4).toString(), "%PDF");
  assert.ok(bytes.length > 500);

  const legacyName = existsSync("uploads")
    ? readdirSync("uploads").find((name) => /^bill-.*\.pdf$/i.test(name))
    : null;
  if (legacyName) {
    const legacy = await fetch(`${origin}/uploads/${legacyName}`, {
      method: "HEAD",
    });
    assert.equal(legacy.status, 404);
  }
});

test("preview uses the authenticated table and streams a PDF without creating a bill", async () => {
  const cart = await createCart(testTables[5]);
  await fetch(`${apiBaseUrl}/saleTemp/selectSize`, {
    method: "PUT",
    ...jsonRequest(ownerToken, {
      saleTempDetailId: cart.saleTempDetails[0].id,
      sizeId: size.id,
    }),
  });
  const before = await prisma.billSale.count();
  const preview = await fetch(`${apiBaseUrl}/saleTemp/printBillBeforePay`, {
    method: "POST",
    ...jsonRequest(ownerToken, {
      tableNo: testTables[5],
      userId: otherUser.id,
    }),
  });
  assert.equal(preview.status, 200);
  assert.match(preview.headers.get("content-type"), /application\/pdf/);
  assert.equal(
    Buffer.from(await preview.arrayBuffer())
      .subarray(0, 4)
      .toString(),
    "%PDF",
  );
  assert.equal(await prisma.billSale.count(), before);
});

test("browser draft quote rejects unpaid kitchen submission without creating SaleTemp", async () => {
  const tableNo = testTables[18];
  const items = [
    { foodId: food.id, quantity: 2, foodSizeId: size.id, tasteId: null },
  ];
  const quote = await fetch(apiBaseUrl + "/counterOrder/quote", {
    method: "POST",
    ...jsonRequest(ownerToken, { tableNo, items }),
  });
  assert.equal(quote.status, 200);
  assert.equal(
    (await quote.json()).results.total,
    2 * (food.price + size.moneyAdded),
  );
  const tampered = await fetch(apiBaseUrl + "/counterOrder/quote", {
    method: "POST",
    ...jsonRequest(ownerToken, {
      tableNo,
      items: [{ ...items[0], price: 1 }],
    }),
  });
  assert.equal(tampered.status, 400);
  const tooLarge = [{ foodId: food.id, quantity: 201 }];
  for (const path of [
    "/counterOrder/quote",
    "/counterOrder/submit",
    "/counterOrder/checkout",
    "/counterOrder/prebill",
  ]) {
    const oversized = await fetch(apiBaseUrl + path, {
      method: "POST",
      ...jsonRequest(ownerToken, {
        tableNo,
        items: tooLarge,
        idempotencyKey: randomUUID(),
        payType: "bank",
        expectedTotal: 0,
      }),
    });
    assert.equal(oversized.status, 400);
    assert.equal((await oversized.json()).code, "ORDER_TOO_LARGE");
  }
  const options = await fetch(apiBaseUrl + "/counterOrder/options/" + food.id, {
    headers: bearer(ownerToken),
  });
  assert.equal(options.status, 200);
  assert.ok(
    (await options.json()).results.foodSizes.some(
      (entry) => entry.id === size.id,
    ),
  );
  const preview = await fetch(apiBaseUrl + "/counterOrder/prebill", {
    method: "POST",
    ...jsonRequest(ownerToken, { tableNo, items }),
  });
  assert.equal(preview.status, 200);
  assert.equal(
    Buffer.from(await preview.arrayBuffer())
      .subarray(0, 4)
      .toString(),
    "%PDF",
  );

  const idempotencyKey = randomUUID();
  const staleSubmit = await fetch(apiBaseUrl + "/counterOrder/submit", {
    method: "POST",
    ...jsonRequest(ownerToken, {
      tableNo,
      items,
      idempotencyKey,
      expectedTotal: 1,
    }),
  });
  assert.equal(staleSubmit.status, 409);
  assert.equal((await staleSubmit.json()).code, "PAYMENT_REQUIRED");
  const tamperedSubmit = await fetch(apiBaseUrl + "/counterOrder/submit", {
    method: "POST",
    ...jsonRequest(ownerToken, {
      tableNo,
      items,
      idempotencyKey,
      amount: 1,
    }),
  });
  assert.equal(tamperedSubmit.status, 400);
  const send = () =>
    fetch(apiBaseUrl + "/counterOrder/submit", {
      method: "POST",
      ...jsonRequest(ownerToken, {
        tableNo,
        items,
        idempotencyKey,
        expectedTotal: 2 * (food.price + size.moneyAdded),
      }),
    });
  const [first, retry] = await Promise.all([send(), send()]);
  for (const response of [first, retry]) {
    assert.equal(response.status, 409);
    assert.equal((await response.json()).code, "PAYMENT_REQUIRED");
  }
  assert.equal(
    await prisma.order.count({
      where: { idempotencyScope: "USER:" + owner.id, idempotencyKey },
    }),
    0,
  );
  assert.equal(
    await prisma.saleTemp.count({ where: { userId: owner.id, tableNo } }),
    0,
  );
  const oldKey = randomUUID();
  const oldOrder = await submitOrder(prisma, {
    actor: { type: "STAFF", userId: owner.id, level: owner.level },
    idempotencyKey: oldKey,
    intent: { channel: "COUNTER", tableNo, items },
    confirmForKitchen: true,
  });
  const replay = await fetch(apiBaseUrl + "/counterOrder/submit", {
    method: "POST",
    ...jsonRequest(ownerToken, { tableNo, items, idempotencyKey: oldKey }),
  });
  assert.equal(replay.status, 200);
  assert.equal((await replay.json()).orderId, oldOrder.id);
  await prisma.order.delete({ where: { id: oldOrder.id } });
});

test("browser draft checkout rejects a changed quote and atomically replays one paid bill", async () => {
  const tableNo = testTables[19];
  const items = [
    {
      foodId: food.id,
      quantity: 1,
      foodSizeId: size.id,
      tasteId: fixture.taste.id,
    },
  ];
  const idempotencyKey = randomUUID();
  const body = {
    tableNo,
    items,
    idempotencyKey,
    expectedTotal: food.price + size.moneyAdded,
    payType: "bank",
  };
  const checkoutDraft = async (requestBody) => {
    const response = await fetch(apiBaseUrl + "/counterOrder/checkout", {
      method: "POST",
      ...jsonRequest(ownerToken, requestBody),
    });
    const payload = await response.json();
    if (payload.billId) createdBillIds.add(payload.billId);
    return { response, payload };
  };
  await prisma.food.update({
    where: { id: food.id },
    data: { price: food.price + 3 },
  });
  try {
    const forged = await checkoutDraft({ ...body, amount: 1 });
    assert.equal(forged.response.status, 400);
    assert.equal(forged.payload.code, "CLIENT_FINANCIAL_AUTHORITY_REJECTED");
    const changed = await checkoutDraft(body);
    assert.equal(changed.response.status, 409);
    assert.equal(changed.payload.code, "QUOTE_CHANGED");
    assert.equal(
      await prisma.billSale.count({ where: { tableNo, userId: owner.id } }),
      0,
    );
    const current = {
      ...body,
      expectedTotal: food.price + size.moneyAdded + 3,
    };
    const [first, retry] = await Promise.all([
      checkoutDraft(current),
      checkoutDraft(current),
    ]);
    assert.equal(first.response.status, 200);
    assert.equal(retry.response.status, 200);
    assert.equal(first.payload.billId, retry.payload.billId);
    assert.equal(first.payload.amount, food.price + size.moneyAdded + 3);
    const bill = await prisma.billSale.findUnique({
      where: { id: first.payload.billId },
      include: { BillSaleDetails: true, Orders: true },
    });
    assert.equal(bill.BillSaleDetails[0].price, food.price + 3);
    assert.equal(bill.BillSaleDetails[0].moneyAdded, size.moneyAdded);
    assert.equal(bill.BillSaleDetails[0].foodSizeId, size.id);
    assert.equal(bill.BillSaleDetails[0].tastedId, fixture.taste.id);
    assert.equal(bill.Orders[0].status, "CONFIRMED");
    assert.ok(bill.Orders[0].paidAt);
    assert.equal(
      await prisma.saleTemp.count({ where: { userId: owner.id, tableNo } }),
      0,
    );
    const conflict = await checkoutDraft({
      ...current,
      items: [{ foodId: food.id, quantity: 2 }],
    });
    assert.equal(conflict.response.status, 409);
    assert.equal(conflict.payload.code, "IDEMPOTENCY_CONFLICT");
  } finally {
    await prisma.food.update({
      where: { id: food.id },
      data: { price: food.price },
    });
  }
});

test("cashier sees sent order history and may cancel only an owned unpaid order before preparation", async () => {
  const cancellable = await kitchenOrder(testTables[20]);
  const listPath = `${apiBaseUrl}/counterOrder/sent?tableNo=${testTables[20]}`;
  const ownList = await fetch(listPath, { headers: bearer(ownerToken) });
  assert.equal(ownList.status, 200);
  assert.equal(ownList.headers.get("cache-control"), "no-store");
  assert.ok(
    (await ownList.json()).results.some(({ id }) => id === cancellable.id),
  );
  const activePath = `${listPath}&view=active`;
  const historyPath = `${listPath}&view=history`;
  const activeBefore = await fetch(activePath, {
    headers: bearer(ownerToken),
  });
  assert.ok(
    (await activeBefore.json()).results.some(({ id }) => id === cancellable.id),
  );
  const invalidView = await fetch(`${listPath}&view=unknown`, {
    headers: bearer(ownerToken),
  });
  assert.equal(invalidView.status, 400);
  assert.equal((await invalidView.json()).code, "INVALID_VIEW");
  const foreignList = await fetch(listPath, { headers: bearer(otherToken) });
  assert.equal(foreignList.status, 200);
  assert.equal((await foreignList.json()).results.length, 0);

  const detailPath = `${apiBaseUrl}/counterOrder/${cancellable.id}`;
  const foreignDetail = await fetch(detailPath, {
    headers: bearer(otherToken),
  });
  assert.equal(foreignDetail.status, 404);
  const detail = await fetch(detailPath, { headers: bearer(ownerToken) });
  assert.equal(detail.status, 200);
  const snapshot = (await detail.json()).result;
  assert.equal(snapshot.id, cancellable.id);
  assert.equal(snapshot.items[0].name, food.name);
  assert.deepEqual(
    snapshot.history.map(({ toStatus }) => toStatus),
    ["SUBMITTED", "CONFIRMED"],
  );

  const cancelPath = `${detailPath}/cancel`;
  const foreignCancel = await fetch(cancelPath, {
    method: "PATCH",
    ...jsonRequest(otherToken, {
      expectedVersion: snapshot.version,
      reason: "Customer request",
    }),
  });
  assert.equal(foreignCancel.status, 404);
  const staleCancel = await fetch(cancelPath, {
    method: "PATCH",
    ...jsonRequest(ownerToken, {
      expectedVersion: snapshot.version - 1,
      reason: "Customer request",
    }),
  });
  assert.equal(staleCancel.status, 409);
  const cancelled = await fetch(cancelPath, {
    method: "PATCH",
    ...jsonRequest(ownerToken, {
      expectedVersion: snapshot.version,
      reason: "Customer request",
    }),
  });
  assert.equal(cancelled.status, 200);
  const cancelledOrder = (await cancelled.json()).result;
  assert.equal(cancelledOrder.status, "CANCELLED");
  assert.equal(cancelledOrder.history.at(-1).reason, "Customer request");
  const cancelledList = await fetch(listPath, { headers: bearer(ownerToken) });
  assert.equal(
    (await cancelledList.json()).results.find(({ id }) => id === cancellable.id)
      .status,
    "CANCELLED",
  );
  const activeAfter = await fetch(activePath, {
    headers: bearer(ownerToken),
  });
  assert.equal(
    (await activeAfter.json()).results.some(({ id }) => id === cancellable.id),
    false,
  );
  const historyAfter = await fetch(historyPath, {
    headers: bearer(ownerToken),
  });
  assert.ok(
    (await historyAfter.json()).results.some(({ id }) => id === cancellable.id),
  );

  const preparing = await advanceOrder(
    await kitchenOrder(testTables[21]),
    "PREPARING",
  );
  const preparingCancel = await fetch(
    `${apiBaseUrl}/counterOrder/${preparing.id}/cancel`,
    {
      method: "PATCH",
      ...jsonRequest(ownerToken, {
        expectedVersion: preparing.version,
        reason: "Customer request",
      }),
    },
  );
  assert.equal(preparingCancel.status, 409);
  assert.equal((await preparingCancel.json()).code, "ORDER_NOT_CANCELLABLE");
  const ready = await advanceOrder(preparing, "READY");
  const readyCancel = await fetch(
    `${apiBaseUrl}/counterOrder/${ready.id}/cancel`,
    {
      method: "PATCH",
      ...jsonRequest(ownerToken, {
        expectedVersion: ready.version,
        reason: "Customer request",
      }),
    },
  );
  assert.equal(readyCancel.status, 409);
  assert.equal((await readyCancel.json()).code, "ORDER_NOT_CANCELLABLE");

  const payable = await kitchenOrder(testTables[22]);
  const settled = await settleCounter(ownerToken, payable.id, {
    expectedVersion: payable.version,
    idempotencyKey: randomUUID(),
    payType: "bank",
  });
  assert.equal(settled.response.status, 200);
  const paidDetail = await fetch(`${apiBaseUrl}/counterOrder/${payable.id}`, {
    headers: bearer(ownerToken),
  });
  const paid = (await paidDetail.json()).result;
  assert.equal(paid.status, "CONFIRMED");
  assert.ok(paid.paidAt);
  const paidCancel = await fetch(
    `${apiBaseUrl}/counterOrder/${payable.id}/cancel`,
    {
      method: "PATCH",
      ...jsonRequest(ownerToken, {
        expectedVersion: paid.version,
        reason: "Customer request",
      }),
    },
  );
  assert.equal(paidCancel.status, 409);
  let finished = paid;
  for (const status of ["PREPARING", "READY", "SERVED"])
    finished = await advanceOrder(finished, status);
  assert.equal(finished.status, "COMPLETED");
  const activeFinished = await fetch(
    `${apiBaseUrl}/counterOrder/sent?tableNo=${testTables[22]}&view=active`,
    { headers: bearer(ownerToken) },
  );
  assert.equal(
    (await activeFinished.json()).results.some(({ id }) => id === payable.id),
    false,
  );
  const historyFinished = await fetch(
    `${apiBaseUrl}/counterOrder/sent?tableNo=${testTables[22]}&view=history`,
    { headers: bearer(ownerToken) },
  );
  assert.ok(
    (await historyFinished.json()).results.some(({ id }) => id === payable.id),
  );
});

test("tableless takeaway uses its Order ID as pickup number and preserves Kitchen after payment", async () => {
  const intent = {
    serviceType: "TAKEAWAY",
    items: [{ foodId: food.id, quantity: 1 }],
  };
  const quote = await fetch(`${apiBaseUrl}/counterOrder/quote`, {
    method: "POST",
    ...jsonRequest(ownerToken, intent),
  });
  assert.equal(quote.status, 200);
  const quoted = (await quote.json()).results;
  assert.equal(quoted.tableNo, null);

  const fakeTable = await fetch(`${apiBaseUrl}/counterOrder/submit`, {
    method: "POST",
    ...jsonRequest(ownerToken, {
      ...intent,
      tableNo: 999,
      idempotencyKey: randomUUID(),
    }),
  });
  assert.equal(fakeTable.status, 400);
  assert.equal((await fakeTable.json()).code, "INVALID_TAKEAWAY_LOCATION");

  const unpaidAttempt = await fetch(`${apiBaseUrl}/counterOrder/submit`, {
    method: "POST",
    ...jsonRequest(ownerToken, {
      ...intent,
      expectedTotal: quoted.total,
      idempotencyKey: randomUUID(),
    }),
  });
  assert.equal(unpaidAttempt.status, 409);
  assert.equal((await unpaidAttempt.json()).code, "PAYMENT_REQUIRED");
  const existing = await submitOrder(prisma, {
    actor: { type: "STAFF", userId: owner.id, level: owner.level },
    idempotencyKey: randomUUID(),
    intent: { channel: "COUNTER", ...intent },
    confirmForKitchen: true,
  });
  const orderId = existing.id;
  const order = await prisma.order.findUnique({ where: { id: orderId } });
  assert.equal(order.tableNo, null);
  assert.equal(order.serviceType, "TAKEAWAY");
  assert.equal(order.status, "CONFIRMED");

  const sent = await fetch(
    `${apiBaseUrl}/counterOrder/sent?serviceType=TAKEAWAY`,
    { headers: bearer(ownerToken) },
  );
  assert.equal(sent.status, 200);
  assert.ok((await sent.json()).results.some(({ id }) => id === orderId));
  const foreign = await fetch(
    `${apiBaseUrl}/counterOrder/sent?serviceType=TAKEAWAY`,
    { headers: bearer(otherToken) },
  );
  assert.equal((await foreign.json()).results.length, 0);
  const preview = await fetch(`${apiBaseUrl}/counterOrder/${orderId}/prebill`, {
    method: "POST",
    ...jsonRequest(ownerToken, {}),
  });
  assert.equal(preview.status, 200);

  const payment = await settleCounter(ownerToken, orderId, {
    expectedVersion: order.version,
    idempotencyKey: randomUUID(),
    payType: "bank",
  });
  assert.equal(payment.response.status, 200);
  const bill = await prisma.billSale.findUnique({
    where: { id: payment.payload.billId },
  });
  assert.equal(bill.tableNo, null);
  assert.equal(bill.serviceType, "TAKEAWAY");
  const paid = await prisma.order.findUnique({ where: { id: orderId } });
  assert.equal(paid.status, "CONFIRMED");
  assert.ok(paid.paidAt);
  assert.equal(paid.billSaleId, bill.id);
  const kitchen = await fetch(`${apiBaseUrl}/orders?status=CONFIRMED`, {
    headers: bearer(ownerToken),
  });
  assert.ok((await kitchen.json()).results.some(({ id }) => id === orderId));
  const receipt = await fetch(`${apiBaseUrl}/saleTemp/printBillAfterPay`, {
    method: "POST",
    ...jsonRequest(ownerToken, { billId: bill.id }),
  });
  assert.equal(receipt.status, 200);

  const checkoutBody = {
    ...intent,
    expectedTotal: quoted.total,
    idempotencyKey: randomUUID(),
    payType: "bank",
  };
  const direct = await fetch(`${apiBaseUrl}/counterOrder/checkout`, {
    method: "POST",
    ...jsonRequest(ownerToken, checkoutBody),
  });
  assert.equal(direct.status, 200);
  const directResult = await direct.json();
  createdBillIds.add(directResult.billId);
  const directOrder = await prisma.order.findUnique({
    where: { id: directResult.pickupNo },
  });
  assert.equal(directOrder.serviceType, "TAKEAWAY");
  assert.equal(directOrder.tableNo, null);
  assert.equal(directOrder.status, "CONFIRMED");
  assert.ok(directOrder.paidAt);
  const replay = await fetch(`${apiBaseUrl}/counterOrder/checkout`, {
    method: "POST",
    ...jsonRequest(ownerToken, checkoutBody),
  });
  assert.equal((await replay.json()).pickupNo, directResult.pickupNo);
});

test("sent Counter list and detail include direct paid checkout and older browser submissions", async () => {
  const actor = { type: "STAFF", userId: owner.id, level: owner.level };
  const tableNo = testTables[0];
  const intent = {
    channel: "COUNTER",
    tableNo,
    items: [{ foodId: food.id, quantity: 1 }],
  };
  for (const status of ["SUBMITTED", "REJECTED", "CANCELLED"]) {
    let order = await submitOrder(prisma, {
      actor,
      idempotencyKey: randomUUID(),
      intent,
    });
    if (status !== "SUBMITTED")
      order = await advanceOrderWithReason(order, status);
    const view = status === "SUBMITTED" ? "active" : "history";
    const list = await fetch(
      `${apiBaseUrl}/counterOrder/sent?tableNo=${tableNo}&view=${view}`,
      { headers: bearer(ownerToken) },
    );
    assert.equal(list.status, 200);
    assert.ok((await list.json()).results.some(({ id }) => id === order.id));
    const detail = await fetch(`${apiBaseUrl}/counterOrder/${order.id}`, {
      headers: bearer(ownerToken),
    });
    assert.equal(detail.status, 200);
    assert.equal((await detail.json()).result.status, status);
    const foreign = await fetch(`${apiBaseUrl}/counterOrder/${order.id}`, {
      headers: bearer(otherToken),
    });
    assert.equal(foreign.status, 404);
  }
  await createCart(tableNo);
  const paid = await checkout(ownerToken, checkoutBody(tableNo));
  assert.equal(paid.response.status, 200);
  const direct = await prisma.order.findFirstOrThrow({
    where: { billSaleId: paid.payload.billId },
  });
  const list = await fetch(
    `${apiBaseUrl}/counterOrder/sent?tableNo=${tableNo}&view=active`,
    { headers: bearer(ownerToken) },
  );
  assert.ok((await list.json()).results.some(({ id }) => id === direct.id));
  const detail = await fetch(`${apiBaseUrl}/counterOrder/${direct.id}`, {
    headers: bearer(ownerToken),
  });
  assert.equal(detail.status, 200);
  assert.equal((await detail.json()).result.status, "CONFIRMED");
  const kitchenQueue = await fetch(`${apiBaseUrl}/orders?status=CONFIRMED`, {
    headers: bearer(otherToken),
  });
  assert.equal(kitchenQueue.status, 200);
  assert.ok(
    (await kitchenQueue.json()).results.some(({ id }) => id === direct.id),
  );
  let served = direct;
  for (const status of ["PREPARING", "READY", "SERVED"])
    served = await advanceOrder(served, status);
  assert.equal(served.status, "COMPLETED");
  assert.equal(served.billSaleId, paid.payload.billId);
  const history = await fetch(
    `${apiBaseUrl}/counterOrder/sent?tableNo=${tableNo}&view=history`,
    { headers: bearer(ownerToken) },
  );
  assert.ok((await history.json()).results.some(({ id }) => id === direct.id));

  async function advanceOrderWithReason(order, nextStatus) {
    return transitionOrder(prisma, {
      actor,
      orderId: order.id,
      expectedVersion: order.version,
      nextStatus,
      reason: "Customer changed their mind",
    });
  }
});

test("receipt endpoints report unavailable organization data without rendering", async () => {
  await prisma.organization.delete({
    where: { id: organizationFixture.organization.id },
  });

  const unavailable = await fetch(`${apiBaseUrl}/saleTemp/printBillBeforePay`, {
    method: "POST",
    ...jsonRequest(ownerToken, { tableNo: testTables[5] }),
  });
  assert.equal(unavailable.status, 409);
  assert.deepEqual(await unavailable.json(), {
    error: "Organization is not configured",
  });

  organizationFixture.organization = await prisma.organization.create({
    data: {
      name: organizationFixture.organization.name,
      address: organizationFixture.organization.address,
      phone: organizationFixture.organization.phone,
      email: organizationFixture.organization.email,
      website: organizationFixture.organization.website,
      bankNo: organizationFixture.organization.bankNo,
      logo: organizationFixture.organization.logo,
      taxCode: organizationFixture.organization.taxCode,
    },
  });
});
