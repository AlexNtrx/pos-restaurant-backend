const { before, after, test } = require("node:test");
const assert = require("node:assert/strict");
const { randomUUID } = require("node:crypto");
const {
  prisma,
  createTestFixture,
  cleanupTestFixture,
  startApiServer,
  stopApiServer,
  headersFor,
} = require("./helpers");
const {
  checkoutCounterDraft,
  transitionOrder,
} = require("../lib/order-service");
const { reserveRefund, finishRefund } = require("../lib/order-refund-service");
let fixture, api;
const actor = () => ({
  type: "STAFF",
  userId: fixture.admin.id,
  level: "admin",
});
before(async () => {
  fixture = await createTestFixture();
  api = await startApiServer();
});
after(async () => {
  await stopApiServer(api?.server);
  await cleanupTestFixture(fixture);
  await prisma.$disconnect();
});
const prepaid = async () => {
  const bill = await checkoutCounterDraft(prisma, {
    actor: actor(),
    idempotencyKey: randomUUID(),
    intent: {
      serviceType: "TAKEAWAY",
      items: [{ foodId: fixture.food.id, quantity: 1 }],
    },
    expectedTotal: 20,
    payType: "bank",
  });
  return {
    bill,
    order: await prisma.order.findUnique({ where: { id: bill.Orders[0].id } }),
  };
};
const request = (order) => ({
  actor: actor(),
  orderId: order.id,
  body: {
    expectedVersion: order.version,
    idempotencyKey: randomUUID(),
    reason: "Customer requested cancellation",
    method: "bank",
  },
});
test("refund reservation freezes kitchen, keeps payment, and manual completion is idempotent", async () => {
  const { bill, order } = await prepaid();
  const intent = request(order);
  const reserved = await reserveRefund(prisma, intent);
  assert.equal(reserved.status, "PENDING");
  assert.equal(reserved.amount, bill.amount);
  assert.equal((await reserveRefund(prisma, intent)).id, reserved.id);
  const frozen = await prisma.order.findUnique({ where: { id: order.id } });
  assert.equal(frozen.status, "CANCELLED");
  assert.equal(frozen.billSaleId, bill.id);
  await assert.rejects(
    transitionOrder(prisma, {
      actor: actor(),
      orderId: order.id,
      expectedVersion: order.version,
      nextStatus: "PREPARING",
    }),
    (e) => e.code === "STALE_VERSION",
  );
  const completion = {
    actor: actor(),
    orderId: order.id,
    body: {
      idempotencyKey: reserved.idempotencyKey,
      reference: "Bank return REF-123",
    },
  };
  await finishRefund(prisma, {
    ...completion,
    body: {
      idempotencyKey: reserved.idempotencyKey,
      reason: "Bank return failed",
    },
    failed: true,
  });
  assert.equal(
    (await prisma.orderRefund.findUnique({ where: { orderId: order.id } }))
      .status,
    "FAILED",
  );
  const completed = await finishRefund(prisma, completion);
  assert.equal(completed.status, "COMPLETED");
  assert.equal((await finishRefund(prisma, completion)).id, completed.id);
  assert.equal(
    await prisma.orderRefund.count({ where: { orderId: order.id } }),
    1,
  );
  assert.equal(
    (await prisma.billSale.findUnique({ where: { id: bill.id } })).status,
    "use",
  );
  assert.equal(
    (await prisma.billSale.findUnique({ where: { id: bill.id } })).amount,
    20,
  );
  await assert.rejects(
    finishRefund(prisma, {
      ...completion,
      body: { ...completion.body, reference: "Different proof" },
    }),
    (e) => e.code === "REFUND_ALREADY_COMPLETED",
  );
});
test("refund and kitchen start cannot both commit, and admin cannot refund after preparation", async () => {
  const { order } = await prepaid();
  const results = await Promise.allSettled([
    reserveRefund(prisma, request(order)),
    transitionOrder(prisma, {
      actor: actor(),
      orderId: order.id,
      expectedVersion: order.version,
      nextStatus: "PREPARING",
    }),
  ]);
  assert.equal(results.filter((r) => r.status === "fulfilled").length, 1);
  const state = await prisma.order.findUnique({ where: { id: order.id } });
  assert.ok(["CANCELLED", "PREPARING"].includes(state.status));
  if (state.status === "PREPARING")
    await assert.rejects(
      reserveRefund(prisma, request(state)),
      (e) => e.code === "ORDER_NOT_CANCELLABLE",
    );
  else
    assert.equal(
      await prisma.orderRefund.count({ where: { orderId: state.id } }),
      1,
    );
  const second = await prepaid();
  const preparing = await transitionOrder(prisma, {
    actor: actor(),
    orderId: second.order.id,
    expectedVersion: second.order.version,
    nextStatus: "PREPARING",
  });
  await assert.rejects(
    reserveRefund(prisma, request(preparing)),
    (e) => e.code === "ORDER_NOT_CANCELLABLE",
  );
});
test("refund APIs require admin and reject financial tampering and direct bill void", async () => {
  const { order, bill } = await prepaid();
  const intent = request(order);
  let response = await fetch(`${api.apiBaseUrl}/orders/${order.id}/refund`, {
    method: "POST",
    headers: headersFor(fixture.user),
    body: JSON.stringify(intent.body),
  });
  assert.equal(response.status, 403);
  response = await fetch(`${api.apiBaseUrl}/orders/${order.id}/refund`, {
    method: "POST",
    headers: headersFor(fixture.admin),
    body: JSON.stringify({ ...intent.body, amount: 1 }),
  });
  assert.equal(response.status, 400);
  response = await fetch(`${api.apiBaseUrl}/billSale/remove/${bill.id}`, {
    method: "DELETE",
    headers: headersFor(fixture.admin),
    body: JSON.stringify({ reason: "Bypass attempt" }),
  });
  assert.equal(response.status, 409);
  assert.equal(
    await prisma.orderRefund.count({ where: { orderId: order.id } }),
    0,
  );
});

test("sales reports retain pending payments and deduct only confirmed refunds without changing bill snapshots", async () => {
  const { order, bill } = await prepaid();
  const date = new Date(bill.payDate);
  const report = async () => {
    const response = await fetch(`${api.apiBaseUrl}/report/dailySales`, {
      method: "POST",
      headers: headersFor(fixture.admin),
      body: JSON.stringify({
        year: date.getUTCFullYear(),
        month: date.getUTCMonth() + 1,
      }),
    });
    assert.equal(response.status, 200);
    return response.json();
  };
  const details = await prisma.billSaleDetail.findMany({
    where: { billSaleId: bill.id },
    orderBy: { id: "asc" },
  });
  const before = await report();
  const intent = request(order);
  await assert.rejects(
    reserveRefund(prisma, {
      ...intent,
      body: { ...intent.body, expectedVersion: order.version + 1 },
    }),
    (e) => e.code === "STALE_VERSION",
  );
  const reserved = await reserveRefund(prisma, intent);
  assert.equal((await report()).totalAmount, before.totalAmount);
  await finishRefund(prisma, {
    actor: actor(),
    orderId: order.id,
    body: {
      idempotencyKey: reserved.idempotencyKey,
      reference: "Bank reconciliation 456",
    },
  });
  assert.equal((await report()).totalAmount, before.totalAmount - bill.amount);
  assert.deepEqual(
    await prisma.billSaleDetail.findMany({
      where: { billSaleId: bill.id },
      orderBy: { id: "asc" },
    }),
    details,
  );
});
