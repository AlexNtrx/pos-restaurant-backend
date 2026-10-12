const { after, before, test } = require("node:test");
const assert = require("node:assert/strict");
const { once } = require("node:events");
const jwt = require("jsonwebtoken");
const { randomUUID } = require("node:crypto");
const { PrismaClient } = require("@prisma/client");
const { restaurantMonthBounds } = require("../lib/restaurant-calendar");
const { readSalesBuckets } = require("../lib/sales-report");
const { eurosToCents } = require("../lib/money");
const { createTestFixture, cleanupTestFixture } = require("./helpers");

const prisma = new PrismaClient();
let apiBaseUrl;
let apiServer;
let admin;
let regularUser;
let food;
const billIds = [];
let fixture;
// Coordinates headers for behavior for this module.
const headersFor = (user) => ({
  Authorization: `Bearer ${jwt.sign({ id: user.id, level: user.level }, process.env.SECRET_KEY, { expiresIn: "5m" })}`,
  "Content-Type": "application/json",
});

// Creates bill with the current contract.
const createBill = async (amount, payDate, status = "use") => {
  const bill = await prisma.billSale.create({
    data: {
      amount: eurosToCents(amount),
      payType: "cash",
      payDate,
      createdDate: new Date("2024-12-31T22:00:00.000Z"),
      userId: admin.id,
      inputMoney: eurosToCents(amount),
      returnMoney: 0n,
      tableNo: 98,
      status,
      BillSaleDetails: {
        create: [
          {
            foodId: food.id,
            price: 100n,
            moneyAdded: 0n,
            foodName: `Report ${amount}`,
            foodSizeName: null,
            tasteName: null,
          },
        ],
      },
    },
  });
  billIds.push(bill.id);
  return bill;
};

before(async () => {
  const { app } = require("../server");
  apiServer = app.listen(0, "127.0.0.1");
  if (!apiServer.listening) await once(apiServer, "listening");
  apiBaseUrl = `http://127.0.0.1:${apiServer.address().port}/api`;
  fixture = await createTestFixture();
  admin = fixture.admin;
  regularUser = fixture.user;
  food = fixture.food;
});
after(async () => {
  if (billIds.length) {
    await prisma.order.deleteMany({
      where: { billSaleId: { in: billIds } },
    });
    await prisma.billSaleDetail.deleteMany({
      where: { billSaleId: { in: billIds } },
    });
    await prisma.billSale.deleteMany({ where: { id: { in: billIds } } });
  }
  if (apiServer?.listening)
    await new Promise((resolve, reject) =>
      apiServer.close((error) => (error ? reject(error) : resolve())),
    );
  await prisma.$disconnect();
  await cleanupTestFixture(fixture);
});

const readReport = async (route, body) => {
  const response = await fetch(`${apiBaseUrl}/report/${route}`, {
    method: "POST",
    headers: headersFor(admin),
    body: JSON.stringify(body),
  });
  assert.equal(response.status, 200);
  return response.json();
};

const createRefund = async (bill, amount, status) => {
  const order = await prisma.order.create({
    data: {
      channel: "COUNTER",
      serviceType: "TAKEAWAY",
      status: "CANCELLED",
      createdByUserId: admin.id,
      subtotal: bill.amount,
      modifierTotal: 0,
      total: bill.amount,
      billSaleId: bill.id,
      idempotencyScope: `USER:${admin.id}`,
      idempotencyKey: randomUUID(),
      idempotencyFingerprint: "a".repeat(64),
      cancelledAt: new Date(),
    },
  });
  return prisma.orderRefund.create({
    data: {
      orderId: order.id,
      billSaleId: bill.id,
      idempotencyKey: randomUUID(),
      amount: eurosToCents(amount),
      status,
      method: "bank",
      reason: "Report fixture return",
      reservedByUserId: admin.id,
      ...(status === "COMPLETED"
        ? {
            completedAt: new Date("2033-01-15T12:00:00Z"),
            reference: "Report fixture confirmation",
            confirmedByUserId: admin.id,
          }
        : {}),
    },
  });
};

test("daily sales is admin-only and validates calendar input", async () => {
  const [userResponse, invalidResponse] = await Promise.all([
    fetch(`${apiBaseUrl}/report/dailySales`, {
      method: "POST",
      headers: headersFor(regularUser),
      body: JSON.stringify({ year: 2026, month: 2 }),
    }),
    fetch(`${apiBaseUrl}/report/dailySales`, {
      method: "POST",
      headers: headersFor(admin),
      body: JSON.stringify({ year: 2026, month: 13 }),
    }),
  ]);
  assert.equal(userResponse.status, 403);
  assert.equal(invalidResponse.status, 400);
});

test("daily sales uses Helsinki payDate, bill totals, exclusive boundaries, and active bills only", async () => {
  await createBill(101, new Date("2026-01-31T22:00:00.000Z"));
  await createBill(202, new Date("2026-02-28T21:59:59.999Z"));
  await createBill(303, new Date("2026-02-28T22:00:00.000Z"));
  await createBill(404, new Date("2026-02-14T12:00:00.000Z"), "cancelled");
  const response = await fetch(`${apiBaseUrl}/report/dailySales`, {
    method: "POST",
    headers: headersFor(admin),
    body: JSON.stringify({ year: 2026, month: 2 }),
  });
  assert.equal(response.status, 200);
  const body = await response.json();
  assert.equal(body.results.length, 28);
  assert.deepEqual(
    { date: body.results[0].date, amount: body.results[0].amount },
    { date: "2026-02-01", amount: 101 },
  );
  assert.deepEqual(
    { date: body.results[27].date, amount: body.results[27].amount },
    { date: "2026-02-28", amount: 202 },
  );
  assert.equal(body.results[13].amount, 0);
  assert.equal(body.totalAmount, 303);
});

test("monthly sales is admin-only, validates year, and aggregates active final totals by Helsinki month", async () => {
  await createBill(111, new Date("2023-12-31T22:00:00.000Z"));
  await createBill(222, new Date("2024-12-31T21:59:59.999Z"));
  await createBill(333, new Date("2025-01-01T00:00:00.000Z"));
  await createBill(444, new Date("2024-06-15T12:00:00.000Z"), "cancelled");
  const [userResponse, invalidResponse, reportResponse] = await Promise.all([
    fetch(`${apiBaseUrl}/report/sumMonthly`, {
      method: "POST",
      headers: headersFor(regularUser),
      body: JSON.stringify({ year: 2024 }),
    }),
    fetch(`${apiBaseUrl}/report/sumMonthly`, {
      method: "POST",
      headers: headersFor(admin),
      body: JSON.stringify({ year: 1999 }),
    }),
    fetch(`${apiBaseUrl}/report/sumMonthly`, {
      method: "POST",
      headers: headersFor(admin),
      body: JSON.stringify({ year: 2024 }),
    }),
  ]);
  assert.equal(userResponse.status, 403);
  assert.equal(invalidResponse.status, 400);
  assert.equal(reportResponse.status, 200);
  const body = await reportResponse.json();
  assert.equal(body.results.length, 12);
  assert.deepEqual(body.results[0], { month: "01", amount: 111 });
  assert.equal(body.results[5].amount, 0);
  assert.deepEqual(body.results[11], { month: "12", amount: 222 });
  assert.equal(body.totalAmount, 333);
});

test("empty periods return zero-filled leap and century calendars and all twelve months", async () => {
  for (const [year, days] of [
    [2000, 29],
    [2100, 28],
  ]) {
    const daily = await readReport("dailySales", { year, month: 2 });
    assert.equal(daily.results.length, days);
    assert.equal(daily.results[days - 1].date, `${year}-02-${days}`);
    assert.ok(daily.results.every((row) => row.amount === 0));
    assert.equal(daily.totalAmount, 0);
    const monthly = await readReport("sumMonthly", { year });
    assert.equal(monthly.results.length, 12);
    assert.ok(monthly.results.every((row) => row.amount === 0));
    assert.equal(monthly.totalAmount, 0);
  }
});

test("database sums retain integer units above the 32-bit range", async () => {
  for (let index = 0; index < 2; index++)
    await createBill(2_147_483_647, new Date("2028-02-29T21:59:59.999Z"));
  await createBill(17, new Date("2028-03-01T00:00:00.000Z"));
  const daily = await readReport("dailySales", { year: 2028, month: 2 });
  assert.equal(daily.results[28].amount, 4_294_967_294);
  assert.equal(daily.totalAmount, 4_294_967_294);
  const monthly = await readReport("sumMonthly", { year: 2028 });
  assert.equal(monthly.results[1].amount, daily.totalAmount);
  assert.equal(monthly.results[2].amount, 17);
  assert.equal(monthly.totalAmount, 4_294_967_311);
});

test("only completed refunds restate the original period without multiplying bill totals or changing snapshots", async () => {
  const bill = await createBill(100, new Date("2032-02-29T21:59:59.999Z"));
  for (const [amount, status] of [
    [10, "COMPLETED"],
    [20, "COMPLETED"],
    [30, "PENDING"],
    [40, "FAILED"],
  ])
    await createRefund(bill, amount, status);
  const cancelled = await createBill(
    50,
    new Date("2032-02-01T00:00:00Z"),
    "cancelled",
  );
  await createRefund(cancelled, 50, "COMPLETED");
  const before = await prisma.billSale.findUnique({
    where: { id: bill.id },
    include: { Refunds: { orderBy: { id: "asc" } } },
  });
  const daily = await readReport("dailySales", { year: 2032, month: 2 });
  assert.equal(daily.results[28].amount, 70);
  assert.equal(daily.totalAmount, 70);
  const monthly = await readReport("sumMonthly", { year: 2032 });
  assert.equal(monthly.results[1].amount, 70);
  assert.equal(monthly.totalAmount, 70);
  assert.equal((await readReport("sumMonthly", { year: 2033 })).totalAmount, 0);
  assert.deepEqual(
    await prisma.billSale.findUnique({
      where: { id: bill.id },
      include: { Refunds: { orderBy: { id: "asc" } } },
    }),
    before,
  );
});

test("Helsinki buckets and UTC bounds are independent of the database session timezone", async () => {
  await createBill(21, new Date("2036-02-29T21:59:59.999Z"));
  await createBill(7, new Date("2036-03-01T00:00:00Z"));
  const result = await prisma.$transaction(async (tx) => {
    await tx.$executeRaw`SET LOCAL TIME ZONE 'Pacific/Auckland'`;
    return readSalesBuckets(tx, {
      ...restaurantMonthBounds(2036, 2),
      bucket: "day",
    });
  });
  assert.deepEqual(result, [{ bucket: 29, amount: 2100n }]);
});

test("reports still reject missing credentials and a revoked current admin role", async () => {
  const tokenHeaders = headersFor(admin);
  const request = (headers) =>
    fetch(`${apiBaseUrl}/report/sumMonthly`, {
      method: "POST",
      headers: { "Content-Type": "application/json", ...headers },
      body: JSON.stringify({ year: 2032 }),
    });
  assert.equal((await request({})).status, 401);
  try {
    await prisma.user.update({
      where: { id: admin.id },
      data: { level: "kassa" },
    });
    assert.equal((await request(tokenHeaders)).status, 403);
  } finally {
    await prisma.user.update({
      where: { id: admin.id },
      data: { level: "admin" },
    });
  }
});

test("Helsinki midnight, summer/winter DST, cross-month refunds and cancellations reconcile with monthly totals", async () => {
  const year = 2027;
  const bills = [];
  for (const [amount, at] of [
    [1, "2026-12-31T22:30:00Z"], // Jan 1, 00:30
    [2, "2027-03-27T22:00:00Z"], // DST day start
    [4, "2027-03-28T20:59:59.999Z"], // DST day end (23 hours)
    [8, "2027-03-28T21:00:00Z"], // next day
    [16, "2027-04-30T21:30:00Z"], // May 1, 00:30
    [32, "2027-10-30T21:00:00Z"], // DST day start
    [64, "2027-10-31T00:30:00Z"], // first local 03:30
    [128, "2027-10-31T01:30:00Z"], // repeated local 03:30
    [256, "2027-10-31T21:59:59.999Z"], // DST day end (25 hours)
    [512, "2027-10-31T22:00:00Z"], // Nov 1 midnight
    [1024, "2027-12-31T21:59:59.999Z"],
  ])
    bills.push(await createBill(amount, new Date(at)));
  await createBill(2048, new Date("2027-12-31T22:00:00Z")); // excluded from 2027
  const refund = await createRefund(bills[4], 3, "COMPLETED");
  await prisma.orderRefund.update({
    where: { id: refund.id },
    data: { completedAt: new Date("2027-11-01T12:00:00Z") },
  });
  await prisma.order.update({
    where: { id: refund.orderId },
    data: {
      cancelledAt: new Date("2027-10-31T22:30:00Z"),
      paidAt: bills[4].payDate,
    },
  });
  const monthly = await readReport("sumMonthly", { year });
  const daily = [];
  for (let month = 1; month <= 12; month++) {
    const result = await readReport("dailySales", { year, month });
    assert.equal(result.totalAmount, monthly.results[month - 1].amount);
    assert.equal(
      result.results.reduce((sum, row) => sum + row.amount, 0),
      result.totalAmount,
    );
    daily.push(result);
  }
  assert.equal(daily[0].results[0].amount, 1);
  assert.equal(daily[2].results[27].amount, 6);
  assert.equal(daily[2].results[28].amount, 8);
  assert.equal(daily[3].totalAmount, 0);
  assert.equal(daily[4].results[0].amount, 13);
  assert.equal(daily[4].summary.refundedAmount, 3);
  assert.equal(daily[9].results[30].amount, 480);
  assert.equal(daily[10].results[0].amount, 512);
  assert.equal(daily[10].summary.refundedAmount, 0);
  assert.equal(daily[10].results[0].breakdown.paidCancelledCount, 1);
  assert.equal(daily[10].results[0].breakdown.paidCancelledAmount, 16);
  assert.equal(monthly.totalAmount, 2044);
});
