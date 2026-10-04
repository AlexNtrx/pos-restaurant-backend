// EN: Run from next-pos-api: node test/performance-benchmark.js --image=<food-photo> [--browser --playwright=<module-path>].
// FI: Suorita next-pos-api-kansiosta: node test/performance-benchmark.js --image=<ruokakuva> [--browser --playwright=<moduulipolku>].
require("./bootstrap");
const assert = require("node:assert/strict");
const fs = require("node:fs/promises");
const path = require("node:path");
const { randomUUID } = require("node:crypto");
const { createServer } = require("node:http");
const { once } = require("node:events");
const { spawn } = require("node:child_process");
const { performance, monitorEventLoopDelay } = require("node:perf_hooks");
const os = require("node:os");
const { assertTarget, Metrics, closedLoop } = require("./benchmark-core");
assert.ok(process.env.TEST_DATABASE_URL, "Explicit TEST_DATABASE_URL required");
const target = assertTarget(process.env.DATABASE_URL);
const {
  prisma,
  headersFor,
  createTestFixture,
  cleanupTestFixture,
  beginOrganizationFixture,
  restoreOrganizationFixture,
} = require("./helpers");
const appPrisma = require("../lib/prisma");
const {
  storeImageWithVariants,
  removeImageArtifacts,
} = require("../lib/image-variants");

const root = path.resolve(__dirname, "../..");
const uploads = path.resolve(__dirname, "../uploads");
const lockPath = path.join(root, "tmp/perf-09-local.lock");
const args = new Map(
  process.argv.slice(2).map((arg) => {
    assert.ok(/^--[a-z-]+(?:=.*)?$/.test(arg), "Invalid benchmark argument");
    const split = arg.indexOf("=");
    return split < 0
      ? [arg.slice(2), true]
      : [arg.slice(2, split), arg.slice(split + 1)];
  }),
);
for (const key of args.keys())
  assert.ok(
    [
      "image",
      "browser",
      "playwright",
      "seconds",
      "concurrency",
      "soak",
      "gc-diagnostics",
    ].includes(key),
    "Unknown benchmark option",
  );
const soak = args.has("soak");
const output = path.join(
  root,
  soak ? "tmp/perf-09-soak.json" : "tmp/perf-09-local.json",
);
const operationCap = soak ? 10000 : 1000;
const seconds = Number(args.get("seconds") ?? (soak ? 600 : 30));
const concurrency = Number(args.get("concurrency") ?? 5);
assert.ok(
  Number.isInteger(seconds) && seconds >= 1 && seconds <= (soak ? 600 : 120),
);
if (args.has("gc-diagnostics"))
  assert.equal(
    typeof global.gc,
    "function",
    "Run Node with --expose-gc for GC diagnostics",
  );
assert.ok(
  Number.isInteger(concurrency) && concurrency >= 1 && concurrency <= 10,
);
assert.equal(
  typeof args.get("image"),
  "string",
  "Provide a local sample food image",
);
const metrics = new Metrics();
const stop = new AbortController();
process.once("SIGINT", () => stop.abort());
process.once("SIGTERM", () => stop.abort());
const imageFiles = [],
  tables = [],
  ledger = [],
  monitoring = [];
const timers = new Set();
let fixture, organization, policy, waiter, server, apiOrigin, lock, frontend;
let probeCommitted = false,
  delayHistogram,
  monitorTimer,
  monitorTask;
let phase = "setup";
let monitoringStarted, previousCpu, previousCpuAt;
const report = {
  timestamp: new Date().toISOString(),
  environment: {
    node: process.version,
    platform: process.platform,
    architecture: process.arch,
    cpuCount: os.cpus().length,
    machineMemoryMiB: Math.round(os.totalmem() / 2 ** 20),
    frontend: args.has("browser")
      ? "next start (production build)"
      : "not measured",
    api: "real Express app in guarded test mode",
    database: target.pathname.slice(1),
    poolLimitPerClient:
      target.searchParams.get("connection_limit") ?? "default",
    cloudAcceptance: "pending",
    slo: "not defined from local measurements",
  },
  monitoringLimitations:
    "API process RSS/heap/CPU include the fixture observer; Prisma pool wait/query latency, frontend process RSS and cloud alerts are not measured; a bounded soak cannot establish long-term leak freedom",
  expectedFaults: { lostCheckoutResponseTimeouts: 1 },
  workload: {
    foods: 1000,
    activeOrders: 1000,
    historyBills: 10000,
    distinctImagePairs: 12,
    imagesPerFood: 2,
    concurrency,
    seconds,
    operationCap,
    soak,
    model: "closed-loop mixed reads/writes with 100ms think time",
  },
  failures: [],
};

async function call(
  label,
  endpoint,
  body,
  user = fixture.admin,
  method,
  extraHeaders = {},
  timeout = 15000,
) {
  return metrics.measure(label, async () => {
    const response = await fetch(apiOrigin + "/api" + endpoint, {
      method: method ?? (body === undefined ? "GET" : "POST"),
      headers: {
        ...(user ? headersFor(user) : { "Content-Type": "application/json" }),
        ...extraHeaders,
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      signal: AbortSignal.timeout(timeout),
    });
    const bytes = Buffer.from(await response.arrayBuffer());
    if (!response.ok)
      throw Object.assign(new Error("Benchmark HTTP failure"), {
        status: response.status,
      });
    const data = response.headers.get("content-type")?.includes("json")
      ? JSON.parse(bytes.toString())
      : null;
    return { data, bytes: bytes.length, status: response.status };
  });
}

async function counts() {
  return Object.fromEntries(
    await Promise.all(
      [
        "user",
        "food",
        "order",
        "billSale",
        "orderRefund",
        "saleTemp",
        "restaurantTable",
        "tableSession",
        "serviceCall",
      ].map(async (name) => [name, await prisma[name].count()]),
    ),
  );
}

async function setup() {
  await fs.mkdir(path.dirname(output), { recursive: true });
  // EN: An exclusive lock plus an empty-data gate prevents overlapping fixtures and accidental cleanup of existing business data.
  // FI: Yksinomainen lukko ja tyhjän aineiston tarkistus estävät päällekkäiset testit ja olemassa olevien liiketoimintatietojen poistamisen.
  lock = await fs.open(lockPath, "wx");
  await lock.writeFile(
    JSON.stringify({ pid: process.pid, database: target.pathname.slice(1) }),
  );
  const initial = await counts();
  assert.ok(
    Object.values(initial).every((value) => value === 0),
    "Benchmark target must contain no business data",
  );
  report.initialCounts = initial;
  fixture = await createTestFixture();
  organization = await beginOrganizationFixture();
  policy = await prisma.qrPolicy.findUnique({ where: { id: 1 } });
  await prisma.qrPolicy.upsert({
    where: { id: 1 },
    create: { id: 1, mode: "ORDERING" },
    update: { mode: "ORDERING" },
  });
  waiter = await prisma.user.create({
    data: {
      name: fixture.marker,
      username: fixture.marker + "-waiter",
      password: fixture.user.password,
      level: "waiter",
      status: "use",
    },
  });
  const { app } = require("../server");
  server = createServer((req, res) => {
    // EN: Delay only the benchmark probe's successful response after the real checkout has committed; production routes stay untouched.
    // FI: Viivytä vain testikoettimen onnistunutta vastausta oikean maksutapahtuman jälkeen; tuotantoreittejä ei muuteta.
    if (
      req.method === "POST" &&
      req.url === "/api/counterOrder/checkout" &&
      req.headers["x-benchmark-probe"] === "lost-response"
    ) {
      const end = res.end.bind(res);
      res.end = (...parameters) => {
        if (res.statusCode !== 200) return end(...parameters);
        probeCommitted = true;
        const timer = setTimeout(() => {
          timers.delete(timer);
          if (!res.destroyed) end(...parameters);
        }, 2000);
        timers.add(timer);
        res.once("close", () => {
          clearTimeout(timer);
          timers.delete(timer);
        });
        return res;
      };
    }
    app(req, res);
  }).listen(0, "127.0.0.1");
  await once(server, "listening");
  apiOrigin = `http://127.0.0.1:${server.address().port}`;
  const source = await fs.readFile(path.resolve(args.get("image")));
  const pairs = [];
  for (let i = 0; i < 12; i++) {
    const pair = [];
    for (let j = 0; j < 2; j++) {
      const name = await storeImageWithVariants(
        { name: path.basename(args.get("image")), data: source },
        { uploadDirectory: uploads },
      );
      imageFiles.push(name);
      pair.push(name);
    }
    pairs.push(pair);
  }
  const sharp = require("sharp");
  const metadata = await sharp(source).metadata();
  report.images = {
    sourceBytes: source.length,
    width: metadata.width,
    height: metadata.height,
    originals: imageFiles.length,
    reusedPairs: true,
    cardBytes: (
      await fs.stat(
        path.join(uploads, ".variants/v1/card", imageFiles[0] + ".webp"),
      )
    ).size,
    detailBytes: (
      await fs.stat(
        path.join(uploads, ".variants/v1/detail", imageFiles[0] + ".webp"),
      )
    ).size,
  };
  await prisma.food.update({
    where: { id: fixture.food.id },
    data: { img: pairs[0][0], detailImg: pairs[0][1] },
  });
  await prisma.food.createMany({
    data: Array.from({ length: 999 }, (_, i) => ({
      name: `Benchmark menu ${String(i).padStart(4, "0")}`,
      remark: "Synthetic menu / Testiruoka",
      price: 20,
      img: pairs[(i + 1) % 12][0],
      detailImg: pairs[(i + 1) % 12][1],
      foodTypeId: fixture.category.id,
    })),
  });
  const queue = await openTable();
  const statuses = ["SUBMITTED", "CONFIRMED", "PREPARING", "READY"];
  await prisma.order.createMany({
    data: Array.from({ length: 1000 }, (_, i) => ({
      channel: "STAFF",
      status: statuses[i % 4],
      restaurantTableId: queue.table.id,
      tableNo: queue.table.tableNo,
      tableSessionId: queue.session.id,
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
    select: { id: true },
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
  for (let batch = 0; batch < 10; batch++)
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
  const bills = await prisma.billSale.findMany({
    where: { userId: fixture.admin.id },
    select: { id: true },
  });
  for (let i = 0; i < bills.length; i += 1000)
    await prisma.billSaleDetail.createMany({
      data: bills.slice(i, i + 1000).map((bill) => ({
        billSaleId: bill.id,
        foodId: fixture.food.id,
        foodName: fixture.food.name,
        price: 20,
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
  return queue;
}

async function openTable() {
  const table = await prisma.restaurantTable.create({
    data: { tableNo: 600000 + tables.length, name: fixture.marker },
  });
  tables.push(table.id);
  const opened = (
    await call("table-open", `/tables/${table.id}/sessions`, {}, waiter)
  ).data.result;
  return { table, session: opened.session, token: opened.token };
}

const draft = () => ({
  serviceType: "TAKEAWAY",
  items: [{ foodId: fixture.food.id, quantity: 2 }],
});

async function counter(refund = false, lost = false) {
  const body = {
    ...draft(),
    idempotencyKey: randomUUID(),
    expectedTotal: 40,
    payType: "cash",
    inputMoney: 50,
  };
  if (lost) {
    await assert.rejects(
      call(
        "checkout-lost-response",
        "/counterOrder/checkout",
        body,
        fixture.user,
        undefined,
        { "X-Benchmark-Probe": "lost-response" },
        1000,
      ),
      (error) => ["TimeoutError", "AbortError"].includes(error.name),
    );
    assert.ok(
      probeCommitted,
      "The lost-response probe must reach the committed response",
    );
  }
  const [first, replay] = await Promise.all([
    call("checkout", "/counterOrder/checkout", body, fixture.user),
    call("checkout-retry", "/counterOrder/checkout", body, fixture.user),
  ]);
  assert.equal(first.data.billId, replay.data.billId);
  assert.equal(first.data.amount, 40);
  assert.equal(first.data.returnMoney, 10);
  const row = { billId: first.data.billId, amount: 40, refunded: 0 };
  ledger.push(row);
  if (refund) {
    const order = await prisma.order.findFirstOrThrow({
      where: { billSaleId: row.billId },
    });
    const reserveBody = {
      expectedVersion: order.version,
      idempotencyKey: randomUUID(),
      reason: "Synthetic cancellation",
      method: "cash",
    };
    const reserved = (
      await call("refund-reserve", `/orders/${order.id}/refund`, reserveBody)
    ).data.result;
    const repeated = (
      await call(
        "refund-reserve-retry",
        `/orders/${order.id}/refund`,
        reserveBody,
      )
    ).data.result;
    assert.equal(reserved.id, repeated.id);
    const complete = {
      idempotencyKey: reserveBody.idempotencyKey,
      reference: "Synthetic cash return",
    };
    const finished = (
      await call(
        "refund-complete",
        `/orders/${order.id}/refund/complete`,
        complete,
      )
    ).data.result;
    const finishedReplay = (
      await call(
        "refund-complete-retry",
        `/orders/${order.id}/refund/complete`,
        complete,
      )
    ).data.result;
    assert.equal(finished.id, finishedReplay.id);
    assert.equal(finished.status, "COMPLETED");
    row.refunded = 40;
  }
}

async function tableWorkflow(qr) {
  const table = await openTable();
  const body = {
    ...(qr ? {} : { tableSessionId: table.session.id }),
    idempotencyKey: randomUUID(),
    expectedTotal: 40,
    items: draft().items,
  };
  const endpoint = qr ? `/qr/${table.token}/orders` : "/waiter/orders";
  const created = (
    await call(
      qr ? "qr-submit" : "waiter-submit",
      endpoint,
      body,
      qr ? null : waiter,
    )
  ).data.result;
  const repeated = (
    await call(
      qr ? "qr-retry" : "waiter-retry",
      endpoint,
      body,
      qr ? null : waiter,
    )
  ).data.result;
  const id = created.orderId ?? created.id;
  assert.equal(id, repeated.orderId ?? repeated.id);
  let order = (await call("order-detail", `/orders/${id}`)).data.result;
  if (qr)
    order = (
      await call(
        "order-confirm",
        `/orders/${id}/status`,
        { expectedVersion: order.version, nextStatus: "CONFIRMED" },
        fixture.admin,
        "PATCH",
      )
    ).data.result;
  for (const nextStatus of ["PREPARING", "READY"])
    order = (
      await call(
        "kitchen-transition",
        `/kitchen/orders/${id}/status`,
        { expectedVersion: order.version, nextStatus },
        fixture.admin,
        "PATCH",
      )
    ).data.result;
  order = (
    await call(
      "serve",
      `/orders/${id}/serve`,
      { expectedVersion: order.version },
      waiter,
      "PATCH",
    )
  ).data.result;
  const payment = {
    orders: [{ id, version: order.version }],
    idempotencyKey: randomUUID(),
    payType: "cash",
    inputMoney: 50,
  };
  const paid = (
    await call(
      "table-settle",
      `/table-sessions/${table.session.id}/settle`,
      payment,
      fixture.user,
    )
  ).data;
  const replay = (
    await call(
      "table-settle-retry",
      `/table-sessions/${table.session.id}/settle`,
      payment,
      fixture.user,
    )
  ).data;
  assert.equal(paid.billId, replay.billId);
  assert.equal(paid.amount, 40);
  assert.equal(paid.returnMoney, 10);
  ledger.push({ billId: paid.billId, amount: 40, refunded: 0 });
  assert.equal(
    (await prisma.tableSession.findUnique({ where: { id: table.session.id } }))
      .status,
    "CLOSED",
  );
}

function startMonitoring() {
  monitoringStarted = performance.now();
  previousCpuAt = monitoringStarted;
  previousCpu = process.cpuUsage();
  delayHistogram = monitorEventLoopDelay({ resolution: 20 });
  delayHistogram.enable();
  const sample = async () => {
    const memory = process.memoryUsage();
    const sampledAt = performance.now();
    const cpu = process.cpuUsage(previousCpu);
    const connections =
      await prisma.$queryRaw`SELECT state, COUNT(*)::integer AS count FROM pg_stat_activity WHERE datname = current_database() GROUP BY state`;
    monitoring.push({
      phase,
      elapsedMs: Math.round(sampledAt - monitoringStarted),
      cpuPercentOfOneCore: +(
        (cpu.user + cpu.system) /
        ((sampledAt - previousCpuAt) * 10)
      ).toFixed(1),
      rssMiB: +(memory.rss / 2 ** 20).toFixed(1),
      heapMiB: +(memory.heapUsed / 2 ** 20).toFixed(1),
      externalMiB: +(memory.external / 2 ** 20).toFixed(1),
      arrayBuffersMiB: +(memory.arrayBuffers / 2 ** 20).toFixed(1),
      connections: connections.map((row) => ({
        state: row.state ?? "unknown",
        count: row.count,
      })),
    });
    previousCpu = process.cpuUsage();
    previousCpuAt = sampledAt;
    if (soak && monitoring.length % 30 === 0)
      console.log(JSON.stringify({ progress: monitoring.at(-1) }));
  };
  monitorTimer = setInterval(() => {
    if (!monitorTask)
      monitorTask = sample()
        .catch(() => report.failures.push("monitoring-unavailable"))
        .finally(() => {
          monitorTask = null;
        });
  }, 1000);
}

async function runBrowser(queue) {
  const frontendRoot = path.join(root, "next-pos");
  assert.ok(
    await fs.stat(path.join(frontendRoot, ".next/BUILD_ID")),
    "Build frontend before browser benchmark",
  );
  report.environment.frontendBuildId = (
    await fs.readFile(path.join(frontendRoot, ".next/BUILD_ID"), "utf8")
  ).trim();
  const portProbe = createServer();
  await new Promise((resolve, reject) => {
    portProbe.once("error", reject);
    portProbe.listen(3109, "127.0.0.1", resolve);
  });
  await new Promise((resolve) => portProbe.close(resolve));
  frontend = spawn(
    process.execPath,
    [
      path.join(frontendRoot, "node_modules/next/dist/bin/next"),
      "start",
      "-p",
      "3109",
      "-H",
      "127.0.0.1",
    ],
    {
      cwd: frontendRoot,
      env: {
        ...process.env,
        NODE_ENV: "production",
        NEXT_PUBLIC_API_SERVER: "https://api.example.invalid",
      },
      stdio: "ignore",
      windowsHide: true,
    },
  );
  const frontendOrigin = "http://127.0.0.1:3109";
  let ready = false;
  for (let attempt = 0; attempt < 100; attempt++) {
    assert.equal(frontend.exitCode, null, "Production server failed to start");
    try {
      ready = (
        await fetch(frontendOrigin + "/signin", {
          signal: AbortSignal.timeout(1000),
        })
      ).ok;
    } catch {}
    if (ready) break;
    await new Promise((resolve) => setTimeout(resolve, 200));
  }
  assert.ok(ready, "Production server did not become ready");
  const child = spawn(
    process.execPath,
    [path.join(frontendRoot, "scripts/performance-browser.mjs")],
    {
      cwd: frontendRoot,
      env: {
        ...process.env,
        PLAYWRIGHT_MODULE: String(args.get("playwright") ?? "playwright"),
      },
      stdio: ["pipe", "pipe", "ignore"],
      windowsHide: true,
    },
  );
  // EN: Send synthetic access over stdin, never command arguments, public output or a credentials file.
  // FI: Lähetä keinotekoiset käyttöoikeudet stdin-kanavassa, älä komentorivillä, julkisessa tulosteessa tai tunnustiedostossa.
  child.stdin.end(
    JSON.stringify({
      frontendOrigin,
      apiOrigin,
      qrPath: `/order/${queue.token}`,
      username: fixture.user.username,
      password: "test-password-1",
    }),
  );
  let text = "";
  child.stdout.on("data", (chunk) => {
    text += chunk;
    if (text.length > 512000) child.kill();
  });
  const deadline = setTimeout(() => child.kill(), 120000);
  try {
    const [code] = await once(child, "exit");
    report.browser = JSON.parse(text);
    assert.equal(code, 0, "Browser benchmark failed");
  } finally {
    clearTimeout(deadline);
    if (child.exitCode === null) child.kill();
  }
}

async function reconcile() {
  assert.equal(new Set(ledger.map((row) => row.billId)).size, ledger.length);
  const actualBills = await prisma.billSale.count();
  const actualOrders = await prisma.order.count();
  const refunds = await prisma.orderRefund.findMany();
  assert.equal(actualBills, 10000 + ledger.length);
  assert.equal(actualOrders, 1000 + ledger.length);
  assert.equal(refunds.length, ledger.filter((row) => row.refunded).length);
  for (const row of ledger) {
    const bill = await prisma.billSale.findUniqueOrThrow({
      where: { id: row.billId },
      include: { BillSaleDetails: true, Orders: true },
    });
    assert.equal(bill.amount, row.amount);
    assert.equal(bill.returnMoney, 10);
    assert.equal(bill.inputMoney, 50);
    assert.equal(bill.Orders.length, 1);
    assert.equal(
      bill.BillSaleDetails.reduce(
        (sum, item) => sum + item.price + item.moneyAdded,
        0,
      ),
      row.amount,
    );
  }
  const now = new Date();
  const expected =
    ledger.reduce((sum, row) => sum + row.amount - row.refunded, 0) +
    (now.getUTCFullYear() === 2026 && now.getUTCMonth() === 9 ? 200000 : 0);
  const daily = (
    await call("reconcile-report", "/report/dailySales", {
      year: now.getUTCFullYear(),
      month: now.getUTCMonth() + 1,
    })
  ).data;
  assert.equal(daily.totalAmount, expected);
  report.correctness = {
    uniquePaidIntents: ledger.length,
    bills: actualBills,
    orders: actualOrders,
    completedRefunds: refunds.length,
    expectedReportTotal: expected,
    actualReportTotal: daily.totalAmount,
    lostResponseReplayed: probeCommitted,
    duplicateOrLostIntents: 0,
  };
}

async function cleanup() {
  clearInterval(monitorTimer);
  await monitorTask;
  if (delayHistogram) {
    delayHistogram.disable();
    report.eventLoop = {
      resolutionMs: 20,
      p95DelayMs: +(delayHistogram.percentile(95) / 1e6).toFixed(2),
      maxDelayMs: +(delayHistogram.max / 1e6).toFixed(2),
    };
  }
  if (frontend && frontend.exitCode === null) {
    frontend.kill();
    await once(frontend, "exit");
  }
  for (const timer of timers) clearTimeout(timer);
  server?.closeAllConnections();
  if (server?.listening) await new Promise((resolve) => server.close(resolve));
  if (fixture) {
    await prisma.order.deleteMany({
      where: { restaurantTableId: { in: tables } },
    });
    await prisma.serviceCall.deleteMany({
      where: { TableSession: { restaurantTableId: { in: tables } } },
    });
    await cleanupTestFixture(fixture);
    await prisma.tableSession.deleteMany({
      where: { restaurantTableId: { in: tables } },
    });
    await prisma.restaurantTable.deleteMany({ where: { id: { in: tables } } });
    if (waiter) await prisma.user.delete({ where: { id: waiter.id } });
    if (policy)
      await prisma.qrPolicy.update({
        where: { id: 1 },
        data: { mode: policy.mode },
      });
    else await prisma.qrPolicy.deleteMany({ where: { id: 1 } });
    if (organization) await restoreOrganizationFixture(organization);
    for (const filename of imageFiles)
      await removeImageArtifacts(uploads, filename);
    report.cleanupCounts = await counts();
    assert.deepEqual(report.cleanupCounts, report.initialCounts);
  }
}

function memorySnapshot() {
  const memory = process.memoryUsage();
  return Object.fromEntries(
    ["rss", "heapUsed", "external", "arrayBuffers"].map((name) => [
      name + "MiB",
      +(memory[name] / 2 ** 20).toFixed(1),
    ]),
  );
}

async function main() {
  const seedStarted = performance.now();
  const queue = await setup();
  report.seedElapsedMs = Math.round(performance.now() - seedStarted);
  await call(
    "login",
    "/user/signIn",
    { username: fixture.user.username, password: "test-password-1" },
    null,
  );
  startMonitoring();
  const health = () =>
    metrics.measure("health", async () => {
      const response = await fetch(apiOrigin + "/health", {
        signal: AbortSignal.timeout(15000),
      });
      const text = await response.text();
      assert.equal(response.status, 200);
      assert.equal(JSON.parse(text).status, "ok");
      return { bytes: Buffer.byteLength(text), status: response.status };
    });
  await health();
  phase = "correctness-probes";
  await counter(true, true);
  await tableWorkflow(false);
  await tableWorkflow(true);
  if (args.has("browser")) {
    phase = "production-browser";
    await runBrowser(queue);
  }
  phase = "mixed-load";
  const reads = [
    () => call("catalog", "/food/filter/all", undefined, fixture.user),
    () => call("tables", "/tables", undefined, waiter),
    () => call("waiter-menu", "/waiter/menu", undefined, waiter),
    () =>
      call(
        "orders-page",
        "/orders?status=CONFIRMED&limit=100",
        undefined,
        waiter,
      ),
    () => call("daily-report", "/report/dailySales", { year: 2026, month: 10 }),
    () =>
      call("bill-history-page", "/billSale/history", {
        startDate: "2026-10-01",
        endDate: "2026-10-31",
        page: 1,
        pageSize: 50,
      }),
    () => call("quote", "/counterOrder/quote", draft(), fixture.user),
    () => call("prebill-pdf", "/counterOrder/prebill", draft(), fixture.user),
  ];
  report.mixed = await closedLoop({
    concurrency,
    durationMs: seconds * 1000,
    maxOperations: operationCap,
    signal: stop.signal,
    operation: async (index) => {
      await metrics.measure("mixed-operation", async () => {
        if (index % 10 === 0) await counter(index % 30 === 0);
        else await reads[index % reads.length]();
      });
      await new Promise((resolve) => setTimeout(resolve, 100));
    },
  });
  assert.ok(!stop.signal.aborted, "Benchmark interrupted");
  if (soak) {
    // EN: Observe natural idle recovery before diagnostic GC; forced collection never runs inside the measured workload.
    // FI: Tarkkaile palautumista levossa ennen diagnostista GC:tä; pakotettu keruu ei tapahdu mitatun kuorman aikana.
    phase = "idle-recovery";
    await new Promise((resolve) => setTimeout(resolve, 30000));
    report.memoryRecovery = {
      beforeGc: memorySnapshot(),
      forcedGc: args.has("gc-diagnostics"),
    };
    if (args.has("gc-diagnostics")) {
      global.gc();
      await new Promise((resolve) => setTimeout(resolve, 1000));
      global.gc();
      report.memoryRecovery.afterGc = memorySnapshot();
    }
  }
  await health();
  phase = "reconciliation";
  await reconcile();
}

main()
  .catch(() => {
    report.failures.push(phase + "-failed");
    process.exitCode = 1;
  })
  .finally(async () => {
    try {
      await cleanup();
    } catch {
      report.failures.push("cleanup-failed");
      process.exitCode = 1;
    }
    report.requests = metrics.summary();
    report.monitoring = monitoring;
    if (report.failures.length) process.exitCode = 1;
    try {
      // EN: Only the lock owner may replace results or remove the lock; failed preflight must not overwrite another run.
      // FI: Vain lukon omistaja saa korvata tulokset tai poistaa lukon; epäonnistunut esitarkistus ei saa korvata toista ajoa.
      if (lock) {
        await fs.writeFile(output, JSON.stringify(report, null, 2));
        await lock.close();
        await fs.unlink(lockPath);
      }
    } finally {
      await Promise.all([prisma.$disconnect(), appPrisma.$disconnect()]);
    }
    console.log(
      JSON.stringify({
        output: lock ? output : null,
        failures: report.failures,
        correctness: report.correctness,
      }),
    );
  });
