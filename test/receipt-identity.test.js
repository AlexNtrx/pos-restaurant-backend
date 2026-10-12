const { before, after, test } = require("node:test");
const assert = require("node:assert/strict");
const { randomUUID } = require("node:crypto");
const { Prisma } = require("@prisma/client");
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
  settleOrders,
  settleTableSession,
} = require("../lib/order-service");
const { endSale } = require("../lib/legacy-checkout-service");
const { printBillAfterPay } = require("../lib/legacy-receipt-service");
const { renderReceiptPdf } = require("../lib/receipt-pdf");
const { rotateToken } = require("../lib/table-service");
let fixture, organization, api;
const tableIds = [];
const actor = () => ({
  type: "STAFF",
  userId: fixture.admin.id,
  level: "admin",
});
const draftRequest = () => ({
  actor: actor(),
  idempotencyKey: randomUUID(),
  intent: {
    serviceType: "TAKEAWAY",
    items: [{ foodId: fixture.food.id, quantity: 1 }],
  },
  expectedTotal: 20,
  payType: "cash",
  inputMoney: 30,
});
const readReceipt = (billId, user = fixture.user) =>
  printBillAfterPay({ user, body: { billId } });
const restoreSeller = () =>
  prisma.organization.upsert({
    where: { id: organization.organization.id },
    create: organization.organization,
    update: organization.organization,
  });
const counts = async () => ({
  bills: await prisma.billSale.count({ where: { userId: fixture.admin.id } }),
  orders: await prisma.order.count({
    where: { createdByUserId: fixture.admin.id },
  }),
});
before(async () => {
  fixture = await createTestFixture();
  organization = await beginOrganizationFixture();
  api = await startApiServer();
});
after(async () => {
  await stopApiServer(api?.server);
  await cleanupTestFixture(fixture);
  await prisma.tableSession.deleteMany({
    where: { restaurantTableId: { in: tableIds } },
  });
  await prisma.restaurantTable.deleteMany({ where: { id: { in: tableIds } } });
  await restoreOrganizationFixture(organization);
  await prisma.$disconnect();
});

test("new paid copies keep seller/cashier text and money after edits or missing setup; exact retry keeps one bill", async () => {
  const request = draftRequest();
  const bill = await checkoutCounterDraft(prisma, request);
  const original = await readReceipt(bill.id);
  assert.equal(bill.receiptSnapshot.version, 1);
  assert.equal(bill.receiptSnapshot.organization.logo, undefined);
  assert.equal(bill.receiptSnapshot.cashierName, fixture.admin.name);
  assert.equal(bill.amount, 2000n);
  assert.equal(bill.returnMoney, 1000n);
  try {
    await prisma.organization.update({
      where: { id: organization.organization.id },
      data: {
        name: "Changed seller",
        address: "Changed address",
        phone: "999",
        taxCode: "CHANGED",
        email: "new@example.com",
        website: "example.com",
        bankNo: "CHANGED ACCOUNT",
      },
    });
    await prisma.user.update({
      where: { id: fixture.admin.id },
      data: { name: "Changed cashier" },
    });
    assert.deepEqual(await readReceipt(bill.id), original);
    await prisma.organization.delete({
      where: { id: organization.organization.id },
    });
    assert.deepEqual(await readReceipt(bill.id), original);
    assert.equal((await checkoutCounterDraft(prisma, request)).id, bill.id);
    await assert.rejects(
      checkoutCounterDraft(prisma, { ...request, inputMoney: 31 }),
      (error) => error.code === "IDEMPOTENCY_CONFLICT",
    );
    const copy = await readReceipt(bill.id);
    assert.equal(
      (await renderReceiptPdf(copy.organization, copy.receipt))
        .subarray(0, 4)
        .toString(),
      "%PDF",
    );
    await assert.rejects(
      renderReceiptPdf(copy.organization, { ...copy.receipt, date: {} }),
      /Invalid time value/,
    );
    assert.equal((await checkoutCounterDraft(prisma, request)).id, bill.id);
    assert.equal(
      await prisma.billSale.count({
        where: {
          userId: fixture.admin.id,
          idempotencyKey: request.idempotencyKey,
        },
      }),
      1,
    );
  } finally {
    await restoreSeller();
    await prisma.user.update({
      where: { id: fixture.admin.id },
      data: { name: fixture.admin.name },
    });
  }
});

test("draft rejects missing/invalid setup before commit and permits the same request after repair", async () => {
  for (const invalid of [
    null,
    { name: " " },
    { address: "" },
    { phone: "" },
    { taxCode: "" },
    { email: "invalid" },
    { website: "bad url" },
  ]) {
    const request = draftRequest();
    const before = await counts();
    try {
      if (invalid === null)
        await prisma.organization.delete({
          where: { id: organization.organization.id },
        });
      else
        await prisma.organization.update({
          where: { id: organization.organization.id },
          data: invalid,
        });
      await assert.rejects(
        checkoutCounterDraft(prisma, request),
        (error) =>
          error.status === 409 && error.code === "RECEIPT_SETUP_REQUIRED",
      );
      assert.deepEqual(await counts(), before);
    } finally {
      await restoreSeller();
    }
    assert.ok((await checkoutCounterDraft(prisma, request)).receiptSnapshot);
  }
  const request = draftRequest();
  const before = await counts();
  try {
    await prisma.user.update({
      where: { id: fixture.admin.id },
      data: { name: " " },
    });
    await assert.rejects(
      checkoutCounterDraft(prisma, request),
      (error) => error.code === "RECEIPT_SETUP_REQUIRED",
    );
    assert.deepEqual(await counts(), before);
  } finally {
    await prisma.user.update({
      where: { id: fixture.admin.id },
      data: { name: fixture.admin.name },
    });
  }
});

test("legacy bridge and fallback preserve cart on setup failure, capture identity and replay without current seller", async () => {
  const previous = process.env.ORD02_COUNTER_CHECKOUT_ENABLED;
  try {
    for (const bridge of ["true", "false"]) {
      process.env.ORD02_COUNTER_CHECKOUT_ENABLED = bridge;
      const tableNo = bridge === "true" ? 940001 : 940002;
      const cart = await prisma.saleTemp.create({
        data: {
          userId: fixture.admin.id,
          tableNo,
          foodId: fixture.food.id,
          qty: 1,
          saleTempDetails: { create: [{ foodId: fixture.food.id }] },
        },
        include: { saleTempDetails: true },
      });
      const request = {
        user: fixture.admin,
        body: { tableNo, payType: "bank", idempotencyKey: randomUUID() },
      };
      const before = await counts();
      await prisma.organization.delete({
        where: { id: organization.organization.id },
      });
      await assert.rejects(
        endSale(request),
        (error) =>
          error.status === 409 && /Receipt setup/.test(error.body.error),
      );
      assert.deepEqual(await counts(), before);
      assert.deepEqual(
        await prisma.saleTemp.findUnique({
          where: { id: cart.id },
          include: { saleTempDetails: true },
        }),
        cart,
      );
      await restoreSeller();
      const result = await endSale(request);
      const bill = await prisma.billSale.findUniqueOrThrow({
        where: { id: result.billId },
      });
      assert.equal(bill.receiptSnapshot.cashierName, fixture.admin.name);
      assert.equal(await prisma.saleTemp.count({ where: { id: cart.id } }), 0);
      await prisma.organization.delete({
        where: { id: organization.organization.id },
      });
      assert.equal((await endSale(request)).billId, result.billId);
      assert.equal(
        (await readReceipt(result.billId)).organization.name,
        organization.organization.name,
      );
      await restoreSeller();
    }
  } finally {
    if (previous === undefined)
      delete process.env.ORD02_COUNTER_CHECKOUT_ENABLED;
    else process.env.ORD02_COUNTER_CHECKOUT_ENABLED = previous;
    await restoreSeller();
  }
});

test("table setup failure leaves served Order/session/token intact; successful settlement freezes identity and replays", async () => {
  const table = await prisma.restaurantTable.create({
    data: { tableNo: 950000 + Math.floor(Math.random() * 9000) },
  });
  tableIds.push(table.id);
  const opened = await prisma.tableSession.create({
    data: { restaurantTableId: table.id },
  });
  await rotateToken(prisma, opened.id, opened.tokenVersion);
  const session = await prisma.tableSession.findUniqueOrThrow({
    where: { id: opened.id },
  });
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
  const request = {
    actor: actor(),
    sessionId: session.id,
    orders: [{ id: order.id, version: order.version }],
    idempotencyKey: randomUUID(),
    payType: "bank",
  };
  const before = await counts();
  try {
    await prisma.organization.update({
      where: { id: organization.organization.id },
      data: { taxCode: "" },
    });
    await assert.rejects(
      settleTableSession(prisma, request),
      (error) => error.code === "RECEIPT_SETUP_REQUIRED",
    );
    assert.deepEqual(await counts(), before);
    assert.deepEqual(
      await prisma.tableSession.findUnique({ where: { id: session.id } }),
      session,
    );
    assert.equal(
      (await prisma.order.findUnique({ where: { id: order.id } })).status,
      "SERVED",
    );
    await restoreSeller();
    const bill = await settleTableSession(prisma, request);
    assert.equal(
      bill.receiptSnapshot.organization.taxCode,
      organization.organization.taxCode,
    );
    assert.equal(
      (await prisma.tableSession.findUnique({ where: { id: session.id } }))
        .qrTokenHash,
      null,
    );
    await prisma.organization.delete({
      where: { id: organization.organization.id },
    });
    assert.equal((await settleTableSession(prisma, request)).id, bill.id);
  } finally {
    await restoreSeller();
  }
});

test("standalone settlement captures receipt identity and invalid stored snapshots cannot use current data", async () => {
  let order = await submitOrder(prisma, {
    actor: actor(),
    idempotencyKey: randomUUID(),
    intent: {
      channel: "COUNTER",
      tableNo: 940003,
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
  const bill = await settleOrders(prisma, {
    actor: actor(),
    orders: [{ id: order.id, version: order.version }],
    idempotencyKey: randomUUID(),
    payType: "bank",
  });
  assert.equal(bill.receiptSnapshot.cashierName, fixture.admin.name);
  await prisma.billSale.update({
    where: { id: bill.id },
    data: { receiptSnapshot: { version: 99 } },
  });
  await assert.rejects(
    readReceipt(bill.id),
    (error) =>
      error.status === 409 &&
      error.body.error === "Receipt identity snapshot is invalid",
  );
  await prisma.billSale.update({
    where: { id: bill.id },
    data: { receiptSnapshot: bill.receiptSnapshot },
  });
});

test("HTTP setup rejection is recoverable and current role checks protect snapshots and copies", async () => {
  const request = draftRequest();
  await prisma.organization.delete({
    where: { id: organization.organization.id },
  });
  try {
    const response = await fetch(api.apiBaseUrl + "/counterOrder/checkout", {
      method: "POST",
      headers: headersFor(fixture.admin),
      body: JSON.stringify({
        ...request.intent,
        idempotencyKey: request.idempotencyKey,
        payType: request.payType,
        inputMoney: request.inputMoney,
        expectedTotal: request.expectedTotal,
      }),
    });
    assert.equal(response.status, 409);
    assert.equal((await response.json()).code, "RECEIPT_SETUP_REQUIRED");
  } finally {
    await restoreSeller();
  }
  const bill = await checkoutCounterDraft(prisma, request);
  for (const level of ["waiter", "kitchen"]) {
    await prisma.user.update({
      where: { id: fixture.user.id },
      data: { level },
    });
    await assert.rejects(readReceipt(bill.id), (error) => error.status === 403);
    await assert.rejects(
      checkoutCounterDraft(prisma, {
        ...draftRequest(),
        actor: { type: "STAFF", userId: fixture.user.id, level: "admin" },
      }),
      (error) => error.status === 403,
    );
  }
  await prisma.user.update({
    where: { id: fixture.user.id },
    data: { level: "kassa" },
  });
  assert.equal(
    (await readReceipt(bill.id)).receipt.cashierName,
    fixture.admin.name,
  );
});

test("legacy copies use current identity with an explicit source, never backfill, and keep original money", async () => {
  const bill = await checkoutCounterDraft(prisma, draftRequest());
  // EN: Simulate a pre-migration bill; its missing historical identity must remain null after every copy.
  // FI: Simuloi migraatiota edeltävää laskua; sen puuttuvan historiallisen identiteetin on jäätävä null-arvoiseksi jokaisen kopion jälkeen.
  await prisma.billSale.update({
    where: { id: bill.id },
    data: { receiptSnapshot: Prisma.DbNull },
  });
  try {
    await prisma.organization.update({
      where: { id: organization.organization.id },
      data: { name: "Current seller" },
    });
    await prisma.user.update({
      where: { id: fixture.admin.id },
      data: { name: "Current cashier" },
    });
    const copy = await readReceipt(bill.id);
    assert.equal(copy.receipt.identitySource, "CURRENT_LEGACY");
    assert.equal(copy.organization.name, "Current seller");
    assert.equal(copy.receipt.cashierName, "Current cashier");
    assert.equal(copy.receipt.amount, bill.amount);
    assert.equal(copy.receipt.returnMoney, bill.returnMoney);
    assert.deepEqual(copy.receipt.vatSnapshot, bill.vatSnapshot);
    assert.equal(
      (await renderReceiptPdf(copy.organization, copy.receipt))
        .subarray(0, 4)
        .toString(),
      "%PDF",
    );
    const response = await fetch(
      api.apiBaseUrl + "/saleTemp/printBillAfterPay",
      {
        method: "POST",
        headers: headersFor(fixture.user),
        body: JSON.stringify({ billId: bill.id }),
      },
    );
    assert.equal(response.status, 200);
    assert.equal(response.headers.get("cache-control"), "private, no-store");
    assert.equal(response.headers.get("content-type"), "application/pdf");
    await response.body.cancel();
    assert.equal(
      (await prisma.billSale.findUniqueOrThrow({ where: { id: bill.id } }))
        .receiptSnapshot,
      null,
    );
    await prisma.organization.delete({
      where: { id: organization.organization.id },
    });
    await assert.rejects(
      readReceipt(bill.id),
      (error) =>
        error.status === 409 &&
        error.body.error === "Organization is not configured",
    );
  } finally {
    await restoreSeller();
    await prisma.user.update({
      where: { id: fixture.admin.id },
      data: { name: fixture.admin.name },
    });
  }
});
