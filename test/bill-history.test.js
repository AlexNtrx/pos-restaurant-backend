const { before, after, test } = require("node:test");
const assert = require("node:assert/strict");
const { randomUUID } = require("node:crypto");
const { performance } = require("node:perf_hooks");
const fs = require("node:fs/promises");
const path = require("node:path");
const {
  prisma,
  createTestFixture,
  cleanupTestFixture,
  startApiServer,
  stopApiServer,
  headersFor,
} = require("./helpers");
const { checkoutCounterDraft } = require("../lib/order-service");
const { reserveRefund, finishRefund } = require("../lib/order-refund-service");
let fixture, api;
before(async () => {
  fixture = await createTestFixture();
  api = await startApiServer();
});
after(async () => {
  await stopApiServer(api?.server);
  await cleanupTestFixture(fixture);
  await prisma.$disconnect();
  await require("../lib/prisma").$disconnect();
});
const read = async (
  body,
  endpoint = "/billSale/history",
  user = fixture.admin,
) => {
  const res = await fetch(api.apiBaseUrl + endpoint, {
    method: "POST",
    headers: headersFor(user),
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(20_000),
  });
  const text = await res.text();
  return {
    status: res.status,
    bytes: Buffer.byteLength(text),
    data: JSON.parse(text),
    headers: res.headers,
  };
};
const range = { startDate: "2030-01-01", endDate: "2030-01-31" };
const createBill = (payDate, amount = 20, status = "use") =>
  prisma.billSale.create({
    data: {
      userId: fixture.admin.id,
      tableNo: 99,
      amount,
      inputMoney: amount,
      returnMoney: 0,
      payType: "cash",
      payDate: new Date(payDate),
      status,
      BillSaleDetails: {
        create: {
          foodId: fixture.food.id,
          foodName: "Persisted soup",
          price: amount,
          moneyAdded: 0,
        },
      },
    },
  });

test("history and lazy detail require a current admin before reading bills", async () => {
  for (const [route, method] of [
    ["/billSale/history", "POST"],
    ["/billSale/detail/1", "GET"],
  ]) {
    const call = (headers) =>
      fetch(api.apiBaseUrl + route, {
        method,
        headers,
        ...(method === "POST" ? { body: JSON.stringify(range) } : {}),
      });
    assert.equal(
      (await call({ "Content-Type": "application/json" })).status,
      401,
    );
    assert.equal((await call(headersFor(fixture.user))).status, 403);
    assert.equal(
      (await call(headersFor({ ...fixture.user, level: "admin" }))).status,
      403,
    );
  }
});

test("history rejects unbounded pagination and invalid dates; empty pages retain a valid summary", async () => {
  for (const body of [
    { ...range, pageSize: 101 },
    { ...range, page: 0 },
    { ...range, page: 1.2 },
    { ...range, page: "1" },
    { ...range, snapshotId: -1 },
    { ...range, snapshotId: null },
    { ...range, pageSize: null },
    { ...range, startDate: "2030-02-30" },
    { ...range, endDate: "2029-01-01" },
  ])
    assert.equal((await read(body)).status, 400);
  const empty = await read({ startDate: "2099-01-01", endDate: "2099-01-01" });
  assert.equal(empty.status, 200);
  assert.equal(empty.headers.get("cache-control"), "no-store");
  assert.deepEqual(empty.data.pagination, {
    page: 1,
    pageSize: 50,
    totalCount: 0,
    totalPages: 0,
    snapshotId: 0,
  });
  assert.deepEqual(empty.data.results, []);
  assert.equal(empty.data.summary.activeAmount, 0);
  for (const id of ["0", "1.2", "2147483648"])
    assert.equal(
      (
        await fetch(api.apiBaseUrl + "/billSale/detail/" + id, {
          headers: headersFor(fixture.admin),
        })
      ).status,
      400,
    );
  assert.equal(
    (
      await fetch(api.apiBaseUrl + "/billSale/detail/2147483647", {
        headers: headersFor(fixture.admin),
      })
    ).status,
    404,
  );
});

test("equal-time pages are stable and exclude newly allocated bills until refresh", async () => {
  const bills = [];
  for (let i = 0; i < 5; i++)
    bills.push(
      await createBill(
        "2030-01-10T12:00:00Z",
        20,
        i === 0 ? "cancelled" : "use",
      ),
    );
  const first = (await read({ ...range, pageSize: 2 })).data;
  assert.deepEqual(
    first.results.map((b) => b.id),
    [bills[4].id, bills[3].id],
  );
  assert.equal(first.summary.activeAmount, 80);
  assert.equal(first.summary.cancelledAmount, 20);
  assert.equal(first.pagination.totalPages, 3);
  const inserted = await createBill("2030-01-10T12:00:00Z", 30);
  const second = (
    await read({
      ...range,
      page: 2,
      pageSize: 2,
      snapshotId: first.pagination.snapshotId,
    })
  ).data;
  const third = (
    await read({
      ...range,
      page: 3,
      pageSize: 2,
      snapshotId: first.pagination.snapshotId,
    })
  ).data;
  assert.deepEqual(
    [...first.results, ...second.results, ...third.results].map((b) => b.id),
    bills.reverse().map((b) => b.id),
  );
  assert.deepEqual(second.summary, first.summary);
  const refreshed = (await read({ ...range, pageSize: 2 })).data;
  assert.equal(refreshed.results[0].id, inserted.id);
  assert.equal(refreshed.summary.activeAmount, 110);
  const outside = (await read({ ...range, page: 9, pageSize: 2 })).data;
  assert.deepEqual(outside.results, []);
  assert.equal(outside.pagination.totalCount, 6);
});

test("paged dates match the legacy Helsinki calendar boundaries and detail retains snapshots", async () => {
  const start = await createBill("2030-01-19T22:00:00Z", 40);
  await createBill("2030-01-20T21:59:59.999Z", 50);
  const nextDay = await createBill("2030-01-20T22:00:00Z", 60);
  const body = { startDate: "2030-01-20", endDate: "2030-01-20" };
  const paged = (await read(body)).data;
  const legacy = (await read(body, "/billSale/list")).data;
  assert.deepEqual(
    paged.results.map((b) => b.id),
    legacy.results.map((b) => b.id),
  );
  assert.deepEqual(paged.summary, legacy.summary);
  assert.equal(
    paged.results.some((b) => b.id === nextDay.id),
    false,
  );
  assert.ok(
    paged.results.every((b) => !("BillSaleDetails" in b) && !("Refunds" in b)),
  );
  await prisma.food.update({
    where: { id: fixture.food.id },
    data: { name: "Changed catalog" },
  });
  const res = await fetch(api.apiBaseUrl + "/billSale/detail/" + start.id, {
    headers: headersFor(fixture.admin),
  });
  assert.equal(res.status, 200);
  assert.equal(res.headers.get("cache-control"), "no-store");
  const { result } = await res.json();
  assert.equal(result.BillSaleDetails[0].foodName, "Persisted soup");
  assert.deepEqual(result.User, {
    id: fixture.admin.id,
    name: fixture.admin.name,
  });
  assert.equal("password" in result.User, false);
});

test("only completed refunds reduce interval totals, including off-page bills", async () => {
  const actor = { type: "STAFF", userId: fixture.admin.id, level: "admin" };
  const bills = [];
  for (const status of ["PENDING", "FAILED", "COMPLETED"]) {
    const paid = await checkoutCounterDraft(prisma, {
      actor,
      idempotencyKey: randomUUID(),
      intent: {
        serviceType: "TAKEAWAY",
        items: [{ foodId: fixture.food.id, quantity: 1 }],
      },
      expectedTotal: 20,
      payType: "bank",
    });
    const order = await prisma.order.findUnique({
      where: { id: paid.Orders[0].id },
    });
    const reserved = await reserveRefund(prisma, {
      actor,
      orderId: order.id,
      body: {
        expectedVersion: order.version,
        idempotencyKey: randomUUID(),
        reason: "Synthetic refund audit",
        method: "bank",
      },
    });
    if (status !== "PENDING")
      await finishRefund(prisma, {
        actor,
        orderId: order.id,
        body: {
          idempotencyKey: reserved.idempotencyKey,
          ...(status === "FAILED"
            ? { reason: "Synthetic bank failure" }
            : { reference: "Synthetic REF-001" }),
        },
        failed: status === "FAILED",
      });
    await prisma.billSale.update({
      where: { id: paid.id },
      data: { payDate: new Date("2030-02-01T12:00:00Z") },
    });
    bills.push(paid.id);
  }
  const body = { startDate: "2030-02-01", endDate: "2030-02-01", pageSize: 1 };
  const first = (await read(body)).data;
  assert.deepEqual(first.summary, {
    activeCount: 3,
    activeAmount: 40,
    cancelledCount: 0,
    cancelledAmount: 0,
  });
  assert.deepEqual(first.results[0].refundSummary, [
    { status: "COMPLETED", amount: 20, count: 1 },
  ]);
  assert.deepEqual(
    first.summary,
    (await read(body, "/billSale/list")).data.summary,
  );
  const detail = await fetch(api.apiBaseUrl + "/billSale/detail/" + bills[2], {
    headers: headersFor(fixture.admin),
  }).then((r) => r.json());
  assert.equal(detail.result.Refunds[0].reference, "Synthetic REF-001");
  assert.equal(detail.result.Refunds[0].reason, "Synthetic refund audit");
});

test("10000-bill pages stay bounded and concurrent reads preserve whole-range totals", async () => {
  const volumeRange = { startDate: "2031-01-01", endDate: "2031-01-31" };
  for (let batch = 0; batch < 10; batch++)
    await prisma.billSale.createMany({
      data: Array.from({ length: 1000 }, (_, i) => ({
        userId: fixture.admin.id,
        tableNo: 99,
        amount: 20,
        inputMoney: 20,
        returnMoney: 0,
        payType: "cash",
        payDate: new Date("2031-01-10T12:00:00Z"),
        status: i % 5 === 0 ? "cancelled" : "use",
      })),
    });
  const bills = await prisma.billSale.findMany({
    where: {
      userId: fixture.admin.id,
      payDate: new Date("2031-01-10T12:00:00Z"),
    },
    select: { id: true },
  });
  for (let offset = 0; offset < bills.length; offset += 1000)
    await prisma.billSaleDetail.createMany({
      data: bills.slice(offset, offset + 1000).map((b) => ({
        billSaleId: b.id,
        foodId: fixture.food.id,
        foodName: fixture.food.name,
        price: 20,
        moneyAdded: 0,
      })),
    });
  const expected = {
    activeCount: 8000,
    activeAmount: 160000,
    cancelledCount: 2000,
    cancelledAmount: 40000,
  };
  const first = (await read(volumeRange)).data;
  assert.deepEqual(first.summary, expected);
  assert.equal(first.results.length, 50);
  assert.equal(first.pagination.totalCount, 10000);
  const last = (
    await read({
      ...volumeRange,
      page: 200,
      snapshotId: first.pagination.snapshotId,
    })
  ).data;
  assert.equal(last.results.length, 50);
  assert.deepEqual(last.summary, expected);
  assert.ok(first.results.every((b) => !("BillSaleDetails" in b)));
  const benchmark = async (endpoint) => {
    await read(volumeRange, endpoint);
    const samples = [];
    for (let batch = 0; batch < 2; batch++)
      await Promise.all(
        Array.from({ length: 10 }, async () => {
          const started = performance.now();
          const result = await read(volumeRange, endpoint);
          assert.equal(result.status, 200);
          assert.deepEqual(result.data.summary, expected);
          samples.push({
            ms: performance.now() - started,
            bytes: result.bytes,
          });
        }),
      );
    const sorted = samples.map((s) => s.ms).sort((a, b) => a - b);
    return {
      samples: 20,
      concurrency: 10,
      p50Ms: +sorted[9].toFixed(1),
      p95Ms: +sorted[18].toFixed(1),
      maxBytes: Math.max(...samples.map((s) => s.bytes)),
    };
  };
  const legacy = await benchmark("/billSale/list");
  const paged = await benchmark("/billSale/history");
  assert.ok(paged.maxBytes < legacy.maxBytes / 10);
  const report = {
    dataset: { bills: 10000, detailsPerBill: 1, pageSize: 50 },
    legacy,
    paged,
  };
  await fs.mkdir(path.resolve("../tmp"), { recursive: true });
  await fs.writeFile(
    path.resolve("../tmp/perf-01-history-benchmark.json"),
    JSON.stringify(report, null, 2),
  );
  console.log(JSON.stringify(report));
});
