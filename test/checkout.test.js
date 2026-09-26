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
const testTables = Array.from({ length: 20 }, (_, index) => baseTable + index);
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
  await createCart(tableNo);
  const { response, payload } = await submitToKitchen(ownerToken, {
    tableNo,
    idempotencyKey: randomUUID(),
  });
  assert.equal(response.status, 200);
  return prisma.order.findUnique({ where: { id: payload.orderId } });
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
  for (const status of ["CONFIRMED", "PREPARING", "READY", "SERVED"])
    order = await advanceOrder(order, status);
  return order;
};

test("Counter settlement waits for SERVED, preserves a new cart, and receipts immutable snapshots", async () => {
  let order = await kitchenOrder(testTables[13]);
  for (const nextStatus of ["CONFIRMED", "PREPARING", "READY", "SERVED"]) {
    const denied = await settleCounter(ownerToken, order.id, {
      expectedVersion: order.version,
      idempotencyKey: randomUUID(),
      payType: "bank",
    });
    assert.equal(denied.response.status, 409);
    assert.equal(denied.payload.code, "ORDER_NOT_PAYABLE");
    order = await advanceOrder(order, nextStatus);
  }
  const newCart = await createCart(testTables[13]);
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
    assert.equal(paid.status, "COMPLETED");
    assert.equal(paid.billSaleId, bill.id);
    assert.deepEqual(
      paid.StatusHistory.map(({ toStatus }) => toStatus),
      [
        "SUBMITTED",
        "CONFIRMED",
        "PREPARING",
        "READY",
        "SERVED",
        "PAID",
        "COMPLETED",
      ],
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
  assert.equal(order.status, "COMPLETED");
  assert.equal(order.createdByUserId, owner.id);
  assert.equal(order.total, expectedAmount);
  assert.equal(order.Items.length, 1);
  assert.equal(order.Items[0].Modifiers[0].foodSizeId, size.id);
  assert.deepEqual(
    order.StatusHistory.map(({ toStatus }) => toStatus),
    ["SUBMITTED", "PAID", "COMPLETED"],
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

test("sending a Counter cart persists one unpaid immutable Order and leaves other carts alone", async () => {
  const selected = testTables[7];
  await createCart(selected);
  await createCart(testTables[9]);
  const otherResponse = await fetch(apiBaseUrl + "/saleTemp/create", {
    method: "POST",
    ...jsonRequest(otherToken, { tableNo: selected, foodId: food.id }),
  });
  assert.equal(otherResponse.status, 200);
  const key = randomUUID();
  const { response, payload } = await submitToKitchen(ownerToken, {
    tableNo: selected,
    idempotencyKey: key,
    userId: otherUser.id,
    amount: 1,
  });
  assert.equal(response.status, 200);
  assert.equal(payload.status, "SUBMITTED");
  assert.equal(payload.total, food.price);
  const order = await prisma.order.findUnique({
    where: { id: payload.orderId },
    include: { Items: true, StatusHistory: true },
  });
  assert.equal(order.billSaleId, null);
  assert.equal(order.createdByUserId, owner.id);
  assert.equal(order.Items.length, 1);
  assert.equal(order.Items[0].foodName, food.name);
  assert.equal(order.StatusHistory.length, 1);
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
    0,
  );
  assert.equal(
    await prisma.saleTemp.count({
      where: { userId: owner.id, tableNo: testTables[9] },
    }),
    1,
  );
  assert.equal(
    await prisma.saleTemp.count({
      where: { userId: otherUser.id, tableNo: selected },
    }),
    1,
  );
  const pending = await fetch(
    apiBaseUrl + "/saleTemp/pendingCounterOrders?tableNo=" + selected,
    {
      headers: bearer(ownerToken),
    },
  );
  assert.equal(pending.status, 200);
  assert.ok((await pending.json()).results.some(({ id }) => id === order.id));
  const hidden = await fetch(
    apiBaseUrl + "/saleTemp/pendingCounterOrders?tableNo=" + selected,
    {
      headers: bearer(otherToken),
    },
  );
  assert.equal(hidden.status, 200);
  assert.ok(!(await hidden.json()).results.some(({ id }) => id === order.id));
});

test("concurrent kitchen submission with one key replays one Order without a BillSale", async () => {
  const selected = testTables[11];
  await createCart(selected);
  const body = { tableNo: selected, idempotencyKey: randomUUID() };
  const results = await Promise.all([
    submitToKitchen(ownerToken, body),
    submitToKitchen(ownerToken, body),
  ]);
  assert.deepEqual(
    results.map(({ response }) => response.status),
    [200, 200],
  );
  assert.equal(results[0].payload.orderId, results[1].payload.orderId);
  assert.equal(
    await prisma.order.count({
      where: {
        idempotencyScope: "COUNTER_KITCHEN_USER:" + owner.id,
        idempotencyKey: body.idempotencyKey,
      },
    }),
    1,
  );
  assert.equal(
    await prisma.billSale.count({
      where: { userId: owner.id, tableNo: selected },
    }),
    0,
  );
  const conflict = await submitToKitchen(ownerToken, {
    ...body,
    tableNo: testTables[12],
  });
  assert.equal(conflict.response.status, 409);
});

test("invalid kitchen submission preserves the cart and creates no Order", async () => {
  const selected = testTables[12];
  const cart = await createCart(selected);
  await prisma.saleTempDetail.deleteMany({ where: { saleTempId: cart.id } });
  const key = randomUUID();
  const { response } = await submitToKitchen(ownerToken, {
    tableNo: selected,
    idempotencyKey: key,
  });
  assert.equal(response.status, 409);
  assert.equal(
    await prisma.saleTemp.count({
      where: { userId: owner.id, tableNo: selected },
    }),
    1,
  );
  assert.equal(
    await prisma.order.count({
      where: {
        idempotencyScope: "COUNTER_KITCHEN_USER:" + owner.id,
        idempotencyKey: key,
      },
    }),
    0,
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

test("browser draft quote and kitchen submit use catalog prices without creating SaleTemp", async () => {
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
  assert.equal((await staleSubmit.json()).code, "QUOTE_CHANGED");
  const tamperedSubmit = await fetch(apiBaseUrl + "/counterOrder/submit", {
    method: "POST",
    ...jsonRequest(ownerToken, {
      tableNo,
      items,
      idempotencyKey,
      expectedTotal: 2 * (food.price + size.moneyAdded),
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
  const first = await send();
  const second = await send();
  assert.equal(first.status, 200);
  assert.equal(second.status, 200);
  const firstBody = await first.json();
  assert.equal((await second.json()).orderId, firstBody.orderId);
  assert.equal(firstBody.status, "SUBMITTED");
  assert.equal(
    await prisma.saleTemp.count({ where: { userId: owner.id, tableNo } }),
    0,
  );
  const order = await prisma.order.findUnique({
    where: { id: firstBody.orderId },
  });
  assert.equal(order.billSaleId, null);
  await prisma.order.delete({ where: { id: order.id } });
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
    assert.equal(bill.Orders[0].status, "COMPLETED");
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
