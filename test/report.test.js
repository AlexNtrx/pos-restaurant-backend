const { after, before, test } = require("node:test");
const assert = require("node:assert/strict");
const { once } = require("node:events");
const jwt = require("jsonwebtoken");
const { PrismaClient } = require("@prisma/client");
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
      amount,
      payType: "cash",
      payDate,
      createdDate: new Date("2025-01-01T00:00:00.000Z"),
      userId: admin.id,
      inputMoney: amount,
      returnMoney: 0,
      tableNo: 98,
      status,
      BillSaleDetails: {
        create: [
          {
            foodId: food.id,
            price: 1,
            moneyAdded: 0,
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

test("daily sales uses UTC payDate, bill totals, exclusive boundaries, and active bills only", async () => {
  await createBill(101, new Date("2026-02-01T00:00:00.000Z"));
  await createBill(202, new Date("2026-02-28T23:59:59.999Z"));
  await createBill(303, new Date("2026-03-01T00:00:00.000Z"));
  await createBill(404, new Date("2026-02-14T12:00:00.000Z"), "cancelled");
  const response = await fetch(`${apiBaseUrl}/report/dailySales`, {
    method: "POST",
    headers: headersFor(admin),
    body: JSON.stringify({ year: 2026, month: 2 }),
  });
  assert.equal(response.status, 200);
  const body = await response.json();
  assert.equal(body.results.length, 28);
  assert.deepEqual(body.results[0], { date: "2026-02-01", amount: 101 });
  assert.deepEqual(body.results[27], { date: "2026-02-28", amount: 202 });
  assert.equal(body.results[13].amount, 0);
  assert.equal(body.totalAmount, 303);
});

test("monthly sales is admin-only, validates year, and aggregates active final totals by UTC month", async () => {
  await createBill(111, new Date("2024-01-01T00:00:00.000Z"));
  await createBill(222, new Date("2024-12-31T23:59:59.999Z"));
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
