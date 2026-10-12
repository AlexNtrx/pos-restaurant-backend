const { after, before, test } = require("node:test");
const assert = require("node:assert/strict");
const { randomUUID } = require("node:crypto");
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
const { checkoutCounterDraft } = require("../lib/order-service");
const { printBillAfterPay } = require("../lib/legacy-receipt-service");
let api, fixture, organization;
before(async () => {
  fixture = await createTestFixture();
  organization = await beginOrganizationFixture();
  api = await startApiServer();
});
after(async () => {
  await stopApiServer(api?.server);
  await cleanupTestFixture(fixture);
  await restoreOrganizationFixture(organization);
  await prisma.$disconnect();
});
const prepaid = () =>
  checkoutCounterDraft(prisma, {
    actor: { type: "STAFF", userId: fixture.admin.id, level: "admin" },
    idempotencyKey: randomUUID(),
    intent: {
      serviceType: "TAKEAWAY",
      items: [{ foodId: fixture.food.id, quantity: 1 }],
    },
    expectedTotal: 20,
    payType: "bank",
  });

test("retired bill history and void endpoints return not-found and cannot alter payments", async () => {
  const bill = await prepaid();
  for (const [method, path] of [
    ["POST", "/billSale/list"],
    ["POST", "/billSale/history"],
    ["GET", "/billSale/detail/" + bill.id],
    ["DELETE", "/billSale/remove/" + bill.id],
  ]) {
    const response = await fetch(api.apiBaseUrl + path, {
      method,
      headers: headersFor(fixture.admin),
      ...(method === "GET"
        ? {}
        : { body: JSON.stringify({ reason: "Old void request" }) }),
    });
    assert.equal(response.status, 404, path);
    await response.body?.cancel();
  }
  const original = await prisma.billSale.findUnique({ where: { id: bill.id } });
  assert.equal(original.status, "use");
  assert.equal(original.amount, 2000n);
  assert.equal(original.cancelledAt, null);
});
test("Order detail supplies original bill metadata to another cashier without eager receipt lines", async () => {
  const bill = await prepaid();
  const response = await fetch(
    api.apiBaseUrl + "/orders/" + bill.Orders[0].id,
    { headers: headersFor(fixture.user) },
  );
  assert.equal(response.status, 200);
  const detail = (await response.json()).result;
  assert.deepEqual(detail.receipt, {
    billId: bill.id,
    amount: 20,
    status: "use",
    orderCount: 1,
  });
  assert.equal(detail.BillSaleDetails, undefined);
});
test("cashier copies preserve receipt snapshots after the catalog changes", async () => {
  const bill = await prepaid();
  const snapshot = await printBillAfterPay({
    user: fixture.admin,
    body: { billId: bill.id },
  });
  const food = await prisma.food.findUnique({ where: { id: fixture.food.id } });
  await prisma.food.update({
    where: { id: fixture.food.id },
    data: { name: "Changed catalog", price: 9900n },
  });
  try {
    const copy = await printBillAfterPay({
      user: fixture.user,
      body: { billId: bill.id },
    });
    assert.deepEqual(copy.receipt, snapshot.receipt);
    assert.equal(copy.receipt.cashierName, fixture.admin.name);
    const response = await fetch(
      api.apiBaseUrl + "/saleTemp/printBillAfterPay",
      {
        method: "POST",
        headers: headersFor(fixture.user),
        body: JSON.stringify({ billId: bill.id }),
      },
    );
    assert.equal(response.status, 200);
    assert.match(response.headers.get("content-type"), /application\/pdf/);
    assert.equal(
      Buffer.from(await response.arrayBuffer())
        .subarray(0, 4)
        .toString(),
      "%PDF",
    );
  } finally {
    await prisma.food.update({
      where: { id: food.id },
      data: { name: food.name, price: food.price },
    });
  }
});
test("receipt access rechecks current roles, rejects inactive staff and omits payment metadata for service roles", async () => {
  const bill = await prepaid();
  for (const level of ["waiter", "kitchen"]) {
    await prisma.user.update({
      where: { id: fixture.user.id },
      data: { level },
    });
    try {
      const receipt = await fetch(
        api.apiBaseUrl + "/saleTemp/printBillAfterPay",
        {
          method: "POST",
          headers: headersFor({ ...fixture.user, level: "admin" }),
          body: JSON.stringify({ billId: bill.id }),
        },
      );
      assert.equal(receipt.status, 403);
      await assert.rejects(
        printBillAfterPay({ user: fixture.user, body: { billId: bill.id } }),
        (e) => e.status === 403,
      );
      const detail = await fetch(
        api.apiBaseUrl + "/orders/" + bill.Orders[0].id,
        { headers: headersFor(fixture.user) },
      );
      assert.equal(detail.status, 200);
      assert.equal((await detail.json()).result.receipt, undefined);
    } finally {
      await prisma.user.update({
        where: { id: fixture.user.id },
        data: { level: "kassa" },
      });
    }
  }
  await prisma.user.update({
    where: { id: fixture.user.id },
    data: { status: "delete" },
  });
  try {
    await assert.rejects(
      printBillAfterPay({ user: fixture.user, body: { billId: bill.id } }),
      (e) => e.status === 403,
    );
  } finally {
    await prisma.user.update({
      where: { id: fixture.user.id },
      data: { status: "use" },
    });
  }
});
