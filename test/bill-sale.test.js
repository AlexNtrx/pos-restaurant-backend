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
const createBill = async (amount, payDate) => {
  const bill = await prisma.billSale.create({
    data: {
      amount,
      payType: "cash",
      payDate,
      createdDate: payDate,
      userId: admin.id,
      inputMoney: amount,
      returnMoney: 0,
      tableNo: 99,
      status: "use",
      BillSaleDetails: {
        create: [
          {
            foodId: food.id,
            price: amount,
            moneyAdded: 0,
            foodName: `Snapshot ${amount}`,
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

test("bill history is admin-only and validates an inclusive date range", async () => {
  const [userResponse, invalidResponse] = await Promise.all([
    fetch(`${apiBaseUrl}/billSale/list`, {
      method: "POST",
      headers: headersFor(regularUser),
      body: JSON.stringify({ startDate: "2026-01-01", endDate: "2026-01-01" }),
    }),
    fetch(`${apiBaseUrl}/billSale/list`, {
      method: "POST",
      headers: headersFor(admin),
      body: JSON.stringify({ startDate: "2026-01-03", endDate: "2026-01-01" }),
    }),
  ]);
  assert.equal(userResponse.status, 403);
  assert.equal(invalidResponse.status, 400);
});

test("history uses payDate range, immutable snapshots, and active-only financial totals", async () => {
  const first = await createBill(101, new Date(Date.UTC(2026, 0, 10, 8)));
  const second = await createBill(202, new Date(Date.UTC(2026, 0, 12, 8)));
  const response = await fetch(`${apiBaseUrl}/billSale/list`, {
    method: "POST",
    headers: headersFor(admin),
    body: JSON.stringify({ startDate: "2026-01-10", endDate: "2026-01-10" }),
  });
  assert.equal(response.status, 200);
  const body = await response.json();
  const listed = body.results.find((bill) => bill.id === first.id);
  assert.ok(listed);
  assert.equal(
    body.results.some((bill) => bill.id === second.id),
    false,
  );
  assert.equal(listed.BillSaleDetails[0].foodName, "Snapshot 101");
  assert.equal(body.summary.activeAmount, 101);
});

test("history interprets selected dates as Europe/Helsinki calendar days", async () => {
  const atStart = await createBill(404, new Date("2026-01-19T22:00:00.000Z"));
  const beforeEnd = await createBill(505, new Date("2026-01-20T21:59:59.999Z"));
  const nextDay = await createBill(606, new Date("2026-01-20T22:00:00.000Z"));
  const response = await fetch(`${apiBaseUrl}/billSale/list`, {
    method: "POST",
    headers: headersFor(admin),
    body: JSON.stringify({ startDate: "2026-01-20", endDate: "2026-01-20" }),
  });
  assert.equal(response.status, 200);
  const body = await response.json();
  const ids = body.results.map((bill) => bill.id);
  assert.ok(ids.includes(atStart.id));
  assert.ok(ids.includes(beforeEnd.id));
  assert.equal(ids.includes(nextDay.id), false);
  assert.equal(body.summary.activeAmount, 909);
});

test("cancellation requires an audited reason and preserves the bill for history", async () => {
  const bill = await createBill(303, new Date(Date.UTC(2026, 0, 15, 8)));
  const invalidResponse = await fetch(
    `${apiBaseUrl}/billSale/remove/${bill.id}`,
    {
      method: "DELETE",
      headers: headersFor(admin),
      body: JSON.stringify({ reason: "no" }),
    },
  );
  assert.equal(invalidResponse.status, 400);
  const cancelResponse = await fetch(
    `${apiBaseUrl}/billSale/remove/${bill.id}`,
    {
      method: "DELETE",
      headers: headersFor(admin),
      body: JSON.stringify({ reason: "Customer requested cancellation" }),
    },
  );
  assert.equal(cancelResponse.status, 200);
  const cancelled = await prisma.billSale.findUnique({
    where: { id: bill.id },
  });
  assert.equal(cancelled.status, "cancelled");
  assert.equal(cancelled.cancelledByUserId, admin.id);
  assert.ok(cancelled.cancelledAt);
  assert.equal(cancelled.cancelReason, "Customer requested cancellation");
  const secondCancel = await fetch(`${apiBaseUrl}/billSale/remove/${bill.id}`, {
    method: "DELETE",
    headers: headersFor(admin),
    body: JSON.stringify({ reason: "Second request" }),
  });
  assert.equal(secondCancel.status, 409);
  const historyResponse = await fetch(`${apiBaseUrl}/billSale/list`, {
    method: "POST",
    headers: headersFor(admin),
    body: JSON.stringify({ startDate: "2026-01-15", endDate: "2026-01-15" }),
  });
  const history = await historyResponse.json();
  assert.equal(
    history.results.find((item) => item.id === bill.id).status,
    "cancelled",
  );
  assert.equal(history.summary.activeAmount, 0);
  assert.equal(history.summary.cancelledAmount, 303);
});
