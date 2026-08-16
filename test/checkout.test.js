const { after, before, test } = require("node:test");
const assert = require("node:assert/strict");
const { randomUUID } = require("node:crypto");
const { existsSync, readdirSync } = require("node:fs");
const { once } = require("node:events");
const jwt = require("jsonwebtoken");
const { PrismaClient } = require("@prisma/client");
const { submitOrder } = require("../lib/order-service");
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
const testTables = Array.from({ length: 11 }, (_, index) => baseTable + index);
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
