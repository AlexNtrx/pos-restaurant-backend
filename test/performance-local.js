// EN: Run from next-pos-api with `node test/performance-local.js`; prepare migrations with `npm run test:db:prepare` first.
// FI: Suorita next-pos-api-kansiosta komennolla `node test/performance-local.js`; valmistele migraatiot ensin komennolla `npm run test:db:prepare`.
// EN: --flows runs only write workflows; --browser serves disposable fixtures on port 3001 until Ctrl+C, then removes them.
// FI: --flows suorittaa vain kirjoitustyönkulut; --browser palvelee kertakäyttöisiä testitietoja portissa 3001 Ctrl+C:hen asti ja poistaa ne lopuksi.
// EN: --verify-browser uses the same isolated server with a small fixture and all staff roles for functional verification.
// FI: --verify-browser käyttää samaa eristettyä palvelinta pienellä testiaineistolla ja kaikilla henkilökuntarooleilla toiminnallista tarkistusta varten.
require("./bootstrap");
const assert = require("node:assert/strict");
const { randomUUID } = require("node:crypto");
const { writeFileSync, mkdirSync } = require("node:fs");
const path = require("node:path");
const { performance } = require("node:perf_hooks");
const { once } = require("node:events");
const {
  prisma,
  startApiServer,
  stopApiServer,
  headersFor,
  createTestFixture,
  cleanupTestFixture,
  beginOrganizationFixture,
  restoreOrganizationFixture,
} = require("./helpers");
const appPrisma = require("../lib/prisma");

// EN: Require an explicit dedicated target before any fixture writes; bootstrap has already rejected non-loopback URLs.
// FI: Vaadi erillinen nimenomainen kohde ennen testitietojen kirjoittamista; bootstrap on jo hylännyt muut kuin loopback-URL:t.
const database = new URL(process.env.DATABASE_URL).pathname.slice(1);
assert.equal(database, "db_next_workshop_pos_test_performance");
assert.ok(process.env.TEST_DATABASE_URL);
const verificationBrowser = process.argv.includes("--verify-browser");
const browserMode = verificationBrowser || process.argv.includes("--browser");
const results = [];
const failures = [];
const tableIds = [];
let fixture, organization, originalPolicy, server, apiBaseUrl;
let adminHeaders,
  cashierHeaders,
  waiterHeaders,
  qrToken,
  queueTable,
  queueSession;

async function request(endpoint, body, headers = adminHeaders, method) {
  const response = await fetch(`${apiBaseUrl}${endpoint}`, {
    method: method ?? (body === undefined ? "GET" : "POST"),
    headers: headers ?? { "Content-Type": "application/json" },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    signal: AbortSignal.timeout(15_000),
  });
  const text = await response.text();
  if (!response.ok)
    throw new Error(`${endpoint.split("?")[0]}: HTTP ${response.status}`);
  return {
    data: JSON.parse(text),
    bytes: Buffer.byteLength(text),
    requests: 1,
  };
}

// EN: A case measures response consumption and parsing; concurrency is a bounded closed-loop load, not a capacity claim.
// FI: Mittaus sisältää vastauksen lukemisen ja jäsennyksen; rinnakkaisuus on rajattu suljetun silmukan kuorma, ei kapasiteettilupaus.
async function measure(name, operation, count = 20, concurrency = 1) {
  await operation();
  const samples = [];
  let next = 0;
  const started = performance.now();
  await Promise.all(
    Array.from({ length: concurrency }, async () => {
      while (next++ < count) {
        const before = performance.now();
        try {
          const result = await operation();
          samples.push({
            ms: performance.now() - before,
            bytes: result.bytes,
            requests: result.requests,
          });
        } catch (error) {
          failures.push({ name, error: error.message });
        }
      }
    }),
  );
  const elapsed = performance.now() - started;
  const times = samples.map((sample) => sample.ms).sort((a, b) => a - b);
  const percentile = (fraction) =>
    times.length
      ? +times[Math.ceil(times.length * fraction) - 1].toFixed(1)
      : null;
  const row = {
    name,
    count,
    concurrency,
    success: samples.length,
    p50Ms: percentile(0.5),
    p95Ms: percentile(0.95),
    maxMs: times.length ? +times.at(-1).toFixed(1) : null,
    operationsPerSecond: +(samples.length / (elapsed / 1000)).toFixed(1),
    averageBytes: samples.length
      ? Math.round(
          samples.reduce((sum, sample) => sum + sample.bytes, 0) /
            samples.length,
        )
      : 0,
    averageRequests: samples.length
      ? samples.reduce((sum, sample) => sum + sample.requests, 0) /
        samples.length
      : 0,
  };
  results.push(row);
  console.log(JSON.stringify(row));
}

async function waiterSnapshot() {
  const pages = await Promise.all(
    ["SUBMITTED", "CONFIRMED", "PREPARING", "READY"].map(async (status) => {
      let cursor,
        bytes = 0,
        requests = 0;
      do {
        const query = new URLSearchParams({ status, limit: "100" });
        if (cursor) query.set("cursor", cursor);
        const page = await request(
          `/orders?${query}`,
          undefined,
          waiterHeaders,
        );
        bytes += page.bytes;
        requests++;
        cursor = page.data.nextCursor;
      } while (cursor);
      return { bytes, requests };
    }),
  );
  return pages.reduce(
    (sum, page) => ({
      bytes: sum.bytes + page.bytes,
      requests: sum.requests + page.requests,
    }),
    { bytes: 0, requests: 0 },
  );
}

async function newTable() {
  const table = await prisma.restaurantTable.create({
    data: { tableNo: 500_000 + tableIds.length, name: fixture.marker },
  });
  tableIds.push(table.id);
  return table;
}

async function seedVolume() {
  await prisma.food.createMany({
    data: Array.from({ length: 999 }, (_, i) => ({
      name: `${fixture.marker}-menu-${i}`,
      remark: "",
      price: 20,
      img: "",
      foodTypeId: fixture.category.id,
    })),
  });
  const statuses = ["SUBMITTED", "CONFIRMED", "PREPARING", "READY"];
  // EN: Bulk synthetic snapshots isolate read scaling; actual writes are measured separately through HTTP workflows.
  // FI: Synteettiset massatilannekuvat eristävät lukujen skaalautumisen; oikeat kirjoitukset mitataan erikseen HTTP-työnkuluilla.
  await prisma.order.createMany({
    data: Array.from({ length: 1000 }, (_, i) => ({
      channel: "STAFF",
      status: statuses[i % 4],
      tableNo: queueTable.tableNo,
      restaurantTableId: queueTable.id,
      tableSessionId: queueSession.id,
      createdByUserId: fixture.admin.id,
      subtotal: 40,
      modifierTotal: 0,
      total: 40,
      idempotencyScope: fixture.marker,
      idempotencyKey: `${fixture.marker}-${i}`,
      idempotencyFingerprint: "0".repeat(64),
    })),
  });
  const orders = await prisma.order.findMany({
    where: { idempotencyScope: fixture.marker },
    select: { id: true, status: true },
  });
  await prisma.orderItem.createMany({
    data: orders.map((order) => ({
      orderId: order.id,
      foodId: fixture.food.id,
      foodName: fixture.food.name,
      quantity: 2,
      unitBasePrice: 20,
      unitModifierTotal: 0,
      unitTotal: 20,
      lineTotal: 40,
    })),
  });
  await prisma.orderStatusHistory.createMany({
    data: orders.map((order) => ({
      orderId: order.id,
      toStatus: order.status,
      version: 1,
      actorType: "STAFF",
      actorUserId: fixture.admin.id,
    })),
  });
  for (let batch = 0; batch < 10; batch++) {
    await prisma.billSale.createMany({
      data: Array.from({ length: 1000 }, (_, i) => ({
        amount: 20,
        serviceType: "TAKEAWAY",
        payType: "cash",
        userId: fixture.admin.id,
        inputMoney: 20,
        returnMoney: 0,
        payDate: new Date(Date.UTC(2026, 9, 1 + (i % 28), 12)),
        idempotencyKey: `${fixture.marker}-bill-${batch}-${i}`,
      })),
    });
  }
  const bills = await prisma.billSale.findMany({
    where: { userId: fixture.admin.id },
    select: { id: true },
  });
  for (let offset = 0; offset < bills.length; offset += 1000)
    await prisma.billSaleDetail.createMany({
      data: bills.slice(offset, offset + 1000).map((bill) => ({
        billSaleId: bill.id,
        foodId: fixture.food.id,
        price: 20,
        foodName: fixture.food.name,
      })),
    });
  for (const table of [
    "Food",
    "Order",
    "OrderItem",
    "BillSale",
    "BillSaleDetail",
  ])
    await prisma.$executeRawUnsafe(`ANALYZE "${table}"`);
}

async function readCases(stage, concurrency = 1, count = 20) {
  const cases = [
    ["role", () => request("/user/getLevelByToken", undefined, cashierHeaders)],
    ["dashboard", () => request("/dashboard/operations")],
    ["catalog", () => request("/food/list")],
    ["tables", () => request("/tables", undefined, cashierHeaders)],
    ["waiter-menu", () => request("/waiter/menu", undefined, waiterHeaders)],
    ["orders-page", () => request("/orders?status=CONFIRMED&limit=100")],
    [
      "orders-delta",
      () =>
        request(
          `/orders?updatedAfter=${encodeURIComponent(new Date().toISOString())}`,
        ),
    ],
    ["waiter-snapshot", waiterSnapshot],
    [
      "service-calls",
      () => request("/service-calls", undefined, waiterHeaders),
    ],
    [
      "daily-report",
      () => request("/report/dailySales", { year: 2026, month: 10 }),
    ],
    ["monthly-report", () => request("/report/sumMonthly", { year: 2026 })],
    [
      "bill-history",
      () =>
        request("/billSale/list", {
          startDate: "2026-10-01",
          endDate: "2026-10-31",
        }),
    ],
    ["qr-context", () => request(`/qr/${qrToken}/context`, undefined, null)],
    ["qr-menu", () => request(`/qr/${qrToken}/menu`, undefined, null)],
  ];
  for (const [name, operation] of cases)
    await measure(`${stage}/${name}`, operation, count, concurrency);
}

async function workflow(source = "waiter") {
  let bytes = 0,
    requests = 0;
  const call = async (...args) => {
    const result = await request(...args);
    bytes += result.bytes;
    requests++;
    return result.data;
  };
  const table = await newTable();
  const opened = await call(`/tables/${table.id}/sessions`, {}, waiterHeaders);
  const sessionId = opened.result.session.id;
  const qr = source === "qr";
  const token = opened.result.token;
  if (qr) {
    await call(`/qr/${token}/context`, undefined, null);
    await call(`/qr/${token}/menu`, undefined, null);
    let serviceCall = (await call(`/qr/${token}/service-call`, {}, null))
      .result;
    // EN: Public DTOs omit the version; staff must obtain it from the authenticated queue before transitions.
    // FI: Julkinen DTO ei sisällä versiota; henkilökunnan on haettava se tunnistetusta jonosta ennen tilamuutoksia.
    serviceCall = (
      await call("/service-calls", undefined, waiterHeaders)
    ).results.find((row) => row.id === serviceCall.id);
    assert.ok(serviceCall);
    for (const nextStatus of ["ACKNOWLEDGED", "RESOLVED"])
      serviceCall = (
        await call(
          `/service-calls/${serviceCall.id}/status`,
          {
            expectedVersion: serviceCall.version,
            nextStatus,
          },
          waiterHeaders,
          "PATCH",
        )
      ).result;
  }
  let order = (
    await call(
      qr ? `/qr/${token}/orders` : "/waiter/orders",
      {
        ...(qr ? {} : { tableSessionId: sessionId }),
        idempotencyKey: randomUUID(),
        expectedTotal: 40,
        items: [{ foodId: fixture.food.id, quantity: 2 }],
      },
      qr ? null : waiterHeaders,
    )
  ).result;
  if (qr) {
    await call(`/qr/${token}/orders/${order.orderId}`, undefined, null);
    order = (await call(`/orders/${order.orderId}`)).result;
    order = (
      await call(
        `/orders/${order.id}/status`,
        {
          expectedVersion: order.version,
          nextStatus: "CONFIRMED",
        },
        waiterHeaders,
        "PATCH",
      )
    ).result;
  }
  for (const nextStatus of ["PREPARING", "READY"])
    order = (
      await call(
        `/kitchen/orders/${order.id}/status`,
        {
          expectedVersion: order.version,
          nextStatus,
        },
        adminHeaders,
        "PATCH",
      )
    ).result;
  order = (
    await call(
      `/orders/${order.id}/serve`,
      {
        expectedVersion: order.version,
      },
      waiterHeaders,
      "PATCH",
    )
  ).result;
  const paid = await call(
    `/table-sessions/${sessionId}/settle`,
    {
      orders: [{ id: order.id, version: order.version }],
      idempotencyKey: randomUUID(),
      payType: "cash",
      inputMoney: 50,
    },
    cashierHeaders,
  );
  assert.equal(paid.amount, 40);
  assert.equal(paid.returnMoney, 10);
  return { bytes, requests };
}

async function main() {
  if (browserMode) {
    const { app } = require("../server");
    server = app.listen(3001, "127.0.0.1");
    await once(server, "listening");
    apiBaseUrl = "http://localhost:3001/api";
  } else {
    ({ server, apiBaseUrl } = await startApiServer());
  }
  fixture = await createTestFixture();
  organization = await beginOrganizationFixture();
  originalPolicy = await prisma.qrPolicy.findUnique({ where: { id: 1 } });
  await prisma.qrPolicy.upsert({
    where: { id: 1 },
    create: { id: 1, mode: "ORDERING" },
    update: { mode: "ORDERING" },
  });
  adminHeaders = headersFor(fixture.admin);
  cashierHeaders = headersFor(fixture.user);
  const waiter = await prisma.user.create({
    data: {
      name: fixture.marker,
      username: `${fixture.marker}-waiter`,
      password: fixture.user.password,
      level: "waiter",
      status: "use",
    },
  });
  waiterHeaders = headersFor(waiter);
  fixture.waiterId = waiter.id;
  queueTable = await newTable();
  const opened = await request(
    `/tables/${queueTable.id}/sessions`,
    {},
    waiterHeaders,
  );
  queueSession = opened.data.result.session;
  qrToken = opened.data.result.token;
  assert.ok(qrToken);
  if (browserMode) {
    let kitchen;
    if (verificationBrowser) {
      kitchen = await prisma.user.create({
        data: {
          name: `${fixture.marker}-kitchen`,
          username: `${fixture.marker}-kitchen`,
          password: fixture.user.password,
          level: "kitchen",
          status: "use",
        },
      });
      fixture.kitchenId = kitchen.id;
    } else await seedVolume();
    // EN: These generated credentials and QR access exist only in the disposable database, for manual/browser verification.
    // FI: Nämä luodut tunnukset ja QR-pääsy ovat vain kertakäyttötietokannassa manuaali- ja selaintarkistuksia varten.
    console.log(
      JSON.stringify({
        mode: verificationBrowser ? "verify-browser" : "browser",
        apiBaseUrl,
        username: fixture.admin.username,
        password: "test-password-1",
        qrPath: `/order/${qrToken}`,
        ...(verificationBrowser
          ? {
              accounts: {
                admin: fixture.admin.username,
                kassa: fixture.user.username,
                waiter: waiter.username,
                kitchen: kitchen.username,
              },
              tableNo: queueTable.tableNo,
            }
          : {}),
      }),
    );
    await new Promise((resolve) => {
      process.once("SIGINT", resolve);
      process.once("SIGTERM", resolve);
    });
    return;
  }
  const login = () =>
    request(
      "/user/signIn",
      { username: fixture.user.username, password: "test-password-1" },
      null,
    );
  if (!process.argv.includes("--flows")) {
    await measure("login/serial", login, 30);
    await measure("login/concurrent", login, 50, 5);
    await readCases("small");
    await seedVolume();
    console.log(
      "Synthetic volume: 1000 foods, 1000 active orders, 10000 bills with details.",
    );
    await readCases("volume");
    await readCases("volume-concurrent", 10, 50);
  }
  const draft = {
    serviceType: "TAKEAWAY",
    items: [{ foodId: fixture.food.id, quantity: 2 }],
  };
  await measure(
    "cart/quote",
    () => request("/counterOrder/quote", draft, cashierHeaders),
    30,
  );
  await measure(
    "cart/checkout",
    async () => {
      const result = await request(
        "/counterOrder/checkout",
        {
          ...draft,
          idempotencyKey: randomUUID(),
          expectedTotal: 40,
          payType: "cash",
          inputMoney: 50,
        },
        cashierHeaders,
      );
      assert.equal(result.data.amount, 40);
      assert.equal(result.data.returnMoney, 10);
      return result;
    },
    20,
  );
  await measure(
    "receipt/prebill",
    async () => {
      const response = await fetch(`${apiBaseUrl}/counterOrder/prebill`, {
        method: "POST",
        headers: cashierHeaders,
        body: JSON.stringify(draft),
        signal: AbortSignal.timeout(15_000),
      });
      assert.equal(response.status, 200);
      const bytes = Buffer.from(await response.arrayBuffer());
      assert.equal(bytes.subarray(0, 4).toString(), "%PDF");
      return { bytes: bytes.length, requests: 1 };
    },
    10,
  );
  await measure("waiter-kitchen-serve-payment", () => workflow(), 10);
  await measure(
    "qr-service-call-kitchen-serve-payment",
    () => workflow("qr"),
    10,
  );
}

async function cleanup() {
  await stopApiServer(server);
  if (fixture) {
    await prisma.order.deleteMany({
      where: { restaurantTableId: { in: tableIds } },
    });
    await prisma.serviceCall.deleteMany({
      where: { TableSession: { restaurantTableId: { in: tableIds } } },
    });
    // EN: Delete bills before sessions because settled bills hold a restricted session foreign key.
    // FI: Poista laskut ennen istuntoja, koska maksetuilla laskuilla on rajoittava istuntoviite.
    await cleanupTestFixture(fixture);
    await prisma.tableSession.deleteMany({
      where: { restaurantTableId: { in: tableIds } },
    });
    await prisma.restaurantTable.deleteMany({
      where: { id: { in: tableIds } },
    });
    if (fixture.waiterId)
      await prisma.user.delete({ where: { id: fixture.waiterId } });
    if (fixture.kitchenId)
      await prisma.user.delete({ where: { id: fixture.kitchenId } });
  }
  if (organization) await restoreOrganizationFixture(organization);
  if (originalPolicy)
    await prisma.qrPolicy.update({
      where: { id: 1 },
      data: { mode: originalPolicy.mode },
    });
  else if (fixture) await prisma.qrPolicy.deleteMany({ where: { id: 1 } });
  await Promise.all([prisma.$disconnect(), appPrisma.$disconnect()]);
}

main()
  .catch((error) => {
    failures.push({ name: "setup-or-workflow", error: error.message });
    process.exitCode = 1;
  })
  .finally(async () => {
    try {
      await cleanup();
    } catch (error) {
      failures.push({ name: "cleanup", error: error.message });
      process.exitCode = 1;
    }
    if (failures.length) process.exitCode = 1;
    const outputDir = path.resolve("../tmp");
    mkdirSync(outputDir, { recursive: true });
    const output = path.join(
      outputDir,
      browserMode
        ? verificationBrowser
          ? "verify-02-browser-cleanup.json"
          : "local-performance-browser-cleanup.json"
        : process.argv.includes("--flows")
          ? "local-performance-flows.json"
          : "local-performance-api.json",
    );
    writeFileSync(
      output,
      JSON.stringify(
        {
          timestamp: new Date().toISOString(),
          database,
          poolLimit: 10,
          results,
          failures,
        },
        null,
        2,
      ),
    );
    console.log(JSON.stringify({ output, failures }));
  });
