const { before, after, test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { randomUUID } = require("node:crypto");
const { setTimeout: delay } = require("node:timers/promises");
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
const { readTaxControl } = require("../lib/tax-control-service");
const {
  validateControlQuery,
  validateControlState,
  eventFingerprint,
} = require("../lib/tax-control-validation");
const {
  lockTaxControlShared,
  lockTaxControlExclusive,
} = require("../lib/tax-control-lock");
let fixture, organizationFixture, api;
const orgId = () => organizationFixture.organization.id;
const baseline = () => ({
  organizationId: orgId(),
  mode: "LEGACY",
  generation: 0,
  version: 1,
  updatedAt: new Date(),
});
const event = (overrides = {}) => {
  const result = {
    organizationId: orgId(),
    schemaVersion: 1,
    action: "DRAIN",
    fromMode: "LEGACY",
    toMode: "DRAINING",
    fromGeneration: 0,
    toGeneration: 1,
    fromVersion: 1,
    toVersion: 2,
    reason: "Synthetic lock test only",
    idempotencyKey: randomUUID(),
    recordedByUserId: fixture.admin.id,
    recordedByName: fixture.admin.name,
    ...overrides,
  };
  return { ...result, requestFingerprint: eventFingerprint(result) };
};
const reset = async () => {
  await prisma.$transaction(async (tx) => {
    await tx.taxControlEvent.deleteMany({ where: { organizationId: orgId() } });
    await tx.organizationTaxControl.deleteMany({
      where: { organizationId: orgId() },
    });
    await tx.organizationTaxControl.create({
      data: { organizationId: orgId() },
    });
  });
};
const request = (method = "GET", suffix = "", user = fixture.admin) =>
  fetch(`${api.apiBaseUrl}/organization/tax-control${suffix}`, {
    method,
    headers: user ? headersFor(user) : {},
  });
before(async () => {
  fixture = await createTestFixture();
  organizationFixture = await beginOrganizationFixture();
  await reset();
  api = await startApiServer();
});
after(async () => {
  await stopApiServer(api?.server);
  await restoreOrganizationFixture(organizationFixture);
  await cleanupTestFixture(fixture);
  await prisma.$disconnect();
});

test("additive migration seeds only legacy controls and enforces SQL bounds, history metadata and retention", async () => {
  const migration = fs
    .readFileSync(
      path.join(
        __dirname,
        "../prisma/migrations/20261012140000_tax_control_foundation/migration.sql",
      ),
      "utf8",
    )
    .replaceAll('"OrganizationTaxControl', '"ControlProbe')
    .replaceAll('"TaxControlEvent', '"EventProbe')
    .replaceAll('"Organization"', '"OrgProbe"')
    .replaceAll("CREATE TABLE", "CREATE TEMP TABLE")
    .replace(/^--.*$/gm, "");
  await prisma.$transaction(async (tx) => {
    await tx.$executeRawUnsafe(
      'CREATE TEMP TABLE "OrgProbe" (id INTEGER PRIMARY KEY, name TEXT, amount BIGINT, snapshot JSONB) ON COMMIT DROP',
    );
    await tx.$executeRaw`INSERT INTO "OrgProbe" VALUES (1,'Original',12345,'{"original":true}'::jsonb),(2,'Other',0,'{}'::jsonb)`;
    const before = await tx.$queryRaw`SELECT * FROM "OrgProbe" ORDER BY id`;
    for (const sql of migration.split(";").filter((sql) => sql.trim()))
      await tx.$executeRawUnsafe(sql);
    assert.deepEqual(
      await tx.$queryRaw`SELECT * FROM "OrgProbe" ORDER BY id`,
      before,
    );
    const controls =
      await tx.$queryRaw`SELECT "organizationId",mode,generation,version FROM "ControlProbe" ORDER BY "organizationId"`;
    assert.deepEqual(
      controls,
      [1, 2].map((organizationId) => ({
        organizationId,
        mode: "LEGACY",
        generation: 0,
        version: 1,
      })),
    );
    assert.equal(
      (await tx.$queryRaw`SELECT count(*) FROM "EventProbe"`)[0].count,
      0n,
    );
    const rejected = async (operation) => {
      await tx.$executeRawUnsafe("SAVEPOINT invalid_probe");
      await assert.rejects(operation);
      await tx.$executeRawUnsafe("ROLLBACK TO SAVEPOINT invalid_probe");
    };
    for (const [mode, gen, version] of [
      ["COMMERCIAL", 0, 1],
      ["LEGACY", -1, 0],
      ["LEGACY", 2147483647, 2147483647],
      ["LEGACY", 1, 1],
    ])
      await rejected(
        () =>
          tx.$executeRaw`UPDATE "ControlProbe" SET mode=${mode},generation=${gen},version=${version} WHERE "organizationId"=1`,
      );
    await rejected(
      () =>
        tx.$executeRaw`INSERT INTO "ControlProbe" ("organizationId") VALUES (999999)`,
    );
    const insert = (overrides = {}) => {
      const e = {
        ...event(),
        organizationId: 1,
        recordedByUserId: 999999,
        ...overrides,
      };
      return tx.$executeRaw`INSERT INTO "EventProbe" ("organizationId","schemaVersion",action,"fromMode","toMode","fromGeneration","toGeneration","fromVersion","toVersion",reason,"idempotencyKey","requestFingerprint","recordedByUserId","recordedByName") VALUES (${e.organizationId},${e.schemaVersion},${e.action},${e.fromMode},${e.toMode},${e.fromGeneration},${e.toGeneration},${e.fromVersion},${e.toVersion},${e.reason},${e.idempotencyKey},${e.requestFingerprint},${e.recordedByUserId},${e.recordedByName})`;
    };
    for (const data of [
      { organizationId: 999999 },
      { schemaVersion: 2 },
      { action: "ACTIVATE" },
      { toMode: "LEGACY" },
      { fromGeneration: -1 },
      { toGeneration: 2 },
      { fromVersion: 2 },
      { toVersion: 3 },
      {
        fromGeneration: 2147483646,
        toGeneration: 2147483647,
        fromVersion: 2147483647,
        toVersion: 2147483647,
      },
      { recordedByUserId: 0 },
      { recordedByName: " " },
      { reason: "ab" },
      { reason: "x".repeat(501) },
      { idempotencyKey: "bad" },
      { requestFingerprint: "A".repeat(64) },
    ])
      await rejected(() => insert(data));
    const key = randomUUID();
    await insert({ idempotencyKey: key });
    await rejected(() =>
      insert({
        idempotencyKey: key,
        action: "RESUME_LEGACY",
        fromMode: "DRAINING",
        toMode: "LEGACY",
        fromGeneration: 1,
        toGeneration: 2,
        fromVersion: 2,
        toVersion: 3,
      }),
    );
    await rejected(() => insert());
    await rejected(
      () => tx.$executeRaw`DELETE FROM "ControlProbe" WHERE "organizationId"=1`,
    );
    await rejected(() => tx.$executeRaw`DELETE FROM "OrgProbe" WHERE id=2`);
    assert.equal(
      (await tx.$queryRaw`SELECT "recordedByUserId" FROM "EventProbe"`)[0]
        .recordedByUserId,
      999999,
    );
    await tx.$executeRawUnsafe('DROP TABLE "EventProbe"');
    await tx.$executeRawUnsafe('DROP TABLE "ControlProbe"');
  });
});

test("HTTP reader is active-Admin only, private and read-only with all capability flags false", async () => {
  const before = await prisma.organization.findUnique({
    where: { id: orgId() },
  });
  const counts = await Promise.all([
    prisma.order.count(),
    prisma.billSale.count(),
    prisma.saleTemp.count(),
    prisma.taxPolicyApproval.count(),
  ]);
  for (const [user, status] of [
    [null, 401],
    [fixture.user, 403],
    [fixture.admin, 200],
  ]) {
    const response = await request("GET", "", user);
    assert.equal(response.status, status);
    assert.equal(response.headers.get("cache-control"), "private, no-store");
    if (status === 200) {
      const body = await response.json();
      assert.deepEqual(
        Object.keys(body).sort(),
        [
          "organizationId",
          "mode",
          "taxGeneration",
          "version",
          "updatedAt",
          "transitionProtocolVersion",
          "canDrain",
          "canResumeLegacy",
          "canActivate",
          "commercialReady",
        ].sort(),
      );
      assert.deepEqual(
        { ...body, updatedAt: null },
        {
          organizationId: orgId(),
          mode: "LEGACY",
          taxGeneration: 0,
          version: 1,
          updatedAt: null,
          transitionProtocolVersion: 1,
          canDrain: false,
          canResumeLegacy: false,
          canActivate: false,
          commercialReady: false,
        },
      );
      assert.ok(Number.isFinite(Date.parse(body.updatedAt)));
    }
  }
  for (const suffix of [
    "?page=1",
    "?generation=0",
    "?mode=LEGACY&mode=DRAINING",
    "?x[]=1",
  ])
    assert.equal((await request("GET", suffix)).status, 400);
  for (const method of ["POST", "PUT", "PATCH", "DELETE"])
    assert.equal((await request(method)).status, 404);
  for (const suffix of ["/drain", "/resume-legacy", "/activate", "/events"])
    assert.equal((await request("POST", suffix)).status, 404);
  assert.deepEqual(
    await prisma.organization.findUnique({ where: { id: orgId() } }),
    before,
  );
  assert.deepEqual(
    await Promise.all([
      prisma.order.count(),
      prisma.billSale.count(),
      prisma.saleTemp.count(),
      prisma.taxPolicyApproval.count(),
    ]),
    counts,
  );
  assert.equal(
    await prisma.taxControlEvent.count({ where: { organizationId: orgId() } }),
    0,
  );
});

test("invalid stored metadata never becomes a usable legacy default", () => {
  for (const query of [null, [], { unexpected: "x" }])
    assert.throws(
      () => validateControlQuery(query),
      (e) => e.status === 400,
    );
  const reject = (control, tail = null) =>
    assert.throws(
      () => validateControlState(control, orgId(), tail),
      (e) => e.status === 503 && e.body.code === "TAX_CONTROL_UNAVAILABLE",
    );
  for (const change of [
    null,
    { organizationId: orgId() + 1 },
    { mode: "COMMERCIAL" },
    { mode: "DRAINING" },
    { generation: "0" },
    { generation: -1 },
    { generation: 2147483647 },
    { version: 0 },
    { updatedAt: new Date("invalid") },
  ])
    reject(change === null ? null : { ...baseline(), ...change });
  const e = { id: 1, recordedAt: new Date(), ...event() };
  const draining = {
    ...baseline(),
    mode: "DRAINING",
    generation: 1,
    version: 2,
  };
  assert.equal(validateControlState(draining, orgId(), e), draining);
  reject(baseline(), e);
  reject(draining);
  for (const change of [
    { organizationId: orgId() + 1 },
    { schemaVersion: 2 },
    { id: 0 },
    { requestFingerprint: "a".repeat(64) },
    { recordedByUserId: 0 },
    { recordedByName: " bad " },
    { recordedAt: new Date("invalid") },
    { reason: " x " },
    { idempotencyKey: "bad" },
    { toGeneration: 2 },
    { toMode: "LEGACY" },
  ])
    reject(draining, { ...e, ...change });
  const boundaryEvent = {
    ...e,
    ...event({
      action: "RESUME_LEGACY",
      fromMode: "DRAINING",
      toMode: "LEGACY",
      fromGeneration: 2147483645,
      toGeneration: 2147483646,
      fromVersion: 2147483646,
      toVersion: 2147483647,
    }),
  };
  assert.equal(
    validateControlState(
      { ...baseline(), generation: 2147483646, version: 2147483647 },
      orgId(),
      boundaryEvent,
    ).version,
    2147483647,
  );
});

test("missing setup/control and mismatched/corrupt latest history fail without repairing rows", async () => {
  await prisma.organizationTaxControl.delete({
    where: { organizationId: orgId() },
  });
  assert.equal((await request()).status, 503);
  assert.equal(
    await prisma.organizationTaxControl.count({
      where: { organizationId: orgId() },
    }),
    0,
  );
  await prisma.organization.delete({ where: { id: orgId() } });
  try {
    assert.equal((await request()).status, 409);
    assert.equal(await prisma.organizationTaxControl.count(), 0);
  } finally {
    await prisma.organization.create({
      data: organizationFixture.organization,
    });
    await reset();
  }
  try {
    await prisma.organizationTaxControl.update({
      where: { organizationId: orgId() },
      data: { mode: "DRAINING" },
    });
    assert.equal((await request()).status, 503);
    await reset();
    const e = await prisma.taxControlEvent.create({ data: event() });
    assert.equal((await request()).status, 503);
    await prisma.organizationTaxControl.update({
      where: { organizationId: orgId() },
      data: { mode: "DRAINING", generation: 1, version: 2 },
    });
    const response = await request();
    assert.equal(response.status, 200);
    assert.equal((await response.json()).canResumeLegacy, false);
    await prisma.taxControlEvent.update({
      where: { id: e.id },
      data: { requestFingerprint: "a".repeat(64) },
    });
    assert.equal((await request()).status, 503);
    assert.equal(
      await prisma.taxControlEvent.count({
        where: { organizationId: orgId() },
      }),
      1,
    );
  } finally {
    await reset();
  }
});

test("current Admin status and transaction recheck defeat stale token role claims", async () => {
  try {
    await prisma.user.update({
      where: { id: fixture.admin.id },
      data: { level: "kassa" },
    });
    assert.equal((await request()).status, 403);
    await prisma.user.update({
      where: { id: fixture.admin.id },
      data: { level: "admin", status: "delete" },
    });
    assert.equal((await request()).status, 401);
    await prisma.user.update({
      where: { id: fixture.admin.id },
      data: { status: "use" },
    });
    await assert.rejects(
      readTaxControl(
        {
          user: prisma.user,
          $transaction: async (callback, options) => {
            await prisma.user.update({
              where: { id: fixture.admin.id },
              data: { level: "kassa" },
            });
            return prisma.$transaction(callback, options);
          },
        },
        fixture.admin.id,
        {},
      ),
      (e) => e.status === 403,
    );
  } finally {
    await prisma.user.update({
      where: { id: fixture.admin.id },
      data: { level: "admin", status: "use" },
    });
  }
});

test("unexpected storage errors return safe 500 and never leak query details", async () => {
  const apiPrisma = require("../lib/prisma");
  const original = apiPrisma.$transaction;
  try {
    apiPrisma.$transaction = async () => {
      throw new Error("secret SQL connection detail");
    };
    const response = await request();
    assert.equal(response.status, 500);
    assert.deepEqual(await response.json(), {
      error: "Unable to read tax control",
    });
  } finally {
    apiPrisma.$transaction = original;
  }
});

test("new restaurant/control setup commits atomically; existing saves never repair missing control", async () => {
  await prisma.organizationTaxControl.delete({
    where: { organizationId: orgId() },
  });
  await prisma.organization.delete({ where: { id: orgId() } });
  const payload = { ...organizationFixture.organization };
  const save = () =>
    fetch(`${api.apiBaseUrl}/organization/create`, {
      method: "POST",
      headers: headersFor(fixture.admin),
      body: JSON.stringify(payload),
    });
  let createdId;
  try {
    const responses = await Promise.all([save(), save()]);
    assert.ok(responses.some((r) => r.status === 200));
    assert.ok(responses.every((r) => [200, 500].includes(r.status)));
    const rows = await prisma.organization.findMany();
    assert.equal(rows.length, 1);
    createdId = rows[0].id;
    assert.equal(
      (
        await prisma.organizationTaxControl.findUnique({
          where: { organizationId: createdId },
        })
      ).generation,
      0,
    );
    assert.equal(await prisma.taxControlEvent.count(), 0);
    const control = await prisma.organizationTaxControl.findUnique({
      where: { organizationId: createdId },
    });
    assert.equal((await save()).status, 200);
    assert.deepEqual(
      await prisma.organizationTaxControl.findUnique({
        where: { organizationId: createdId },
      }),
      control,
    );
    await prisma.organizationTaxControl.delete({
      where: { organizationId: createdId },
    });
    assert.equal((await save()).status, 200);
    assert.equal(await prisma.organizationTaxControl.count(), 0);
    await prisma.organization.delete({ where: { id: createdId } });
    createdId = undefined;
    const apiPrisma = require("../lib/prisma");
    const original = apiPrisma.$transaction;
    try {
      // EN: Fail after the nested create to prove both rows roll back, without touching a production target.
      // FI: Epäonnistu sisäkkäisen luonnin jälkeen todistaaksesi molempien rivien palautumisen koskematta tuotantoon.
      apiPrisma.$transaction = (callback, options) =>
        original.call(
          apiPrisma,
          async (tx) => {
            await callback(tx);
            throw new Error("Injected rollback");
          },
          options,
        );
      assert.equal((await save()).status, 500);
      assert.equal(await prisma.organization.count(), 0);
      assert.equal(await prisma.organizationTaxControl.count(), 0);
    } finally {
      apiPrisma.$transaction = original;
    }
  } finally {
    if (createdId) {
      await prisma.organizationTaxControl.deleteMany({
        where: { organizationId: createdId },
      });
      await prisma.organization.deleteMany({ where: { id: createdId } });
    }
    await prisma.organization.create({
      data: organizationFixture.organization,
    });
    await reset();
  }
});

const deferred = () => {
  let resolve;
  const promise = new Promise((done) => {
    resolve = done;
  });
  return { promise, resolve };
};
const waitForBlocked = async (pid, blocker) => {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    const [row] =
      await prisma.$queryRaw`SELECT wait_event_type, pg_blocking_pids(pid) AS blockers FROM pg_stat_activity WHERE pid=${pid}`;
    if (row?.wait_event_type === "Lock" && row.blockers.includes(blocker))
      return;
    await delay(20);
  }
  assert.fail("Expected database lock wait was not observed");
};
test("helpers require a transaction and missing rows fail closed", async () => {
  await assert.rejects(lockTaxControlShared(prisma, orgId()), TypeError);
  await prisma.organizationTaxControl.delete({
    where: { organizationId: orgId() },
  });
  try {
    for (const lock of [lockTaxControlShared, lockTaxControlExclusive])
      await assert.rejects(
        prisma.$transaction((tx) => lock(tx, orgId())),
        (e) => e.status === 503,
      );
    assert.equal(await prisma.organizationTaxControl.count(), 0);
  } finally {
    await reset();
  }
});

test("shared locks coexist and exclusive acquisition waits through holder commit", async () => {
  const held = deferred(),
    release = deferred(),
    exclusiveStarted = deferred();
  const holder = prisma.$transaction(
    async (tx) => {
      await lockTaxControlShared(tx, orgId());
      const [{ pid }] = await tx.$queryRaw`SELECT pg_backend_pid() AS pid`;
      held.resolve(pid);
      await release.promise;
    },
    { timeout: 10000 },
  );
  const holderPid = await held.promise;
  let exclusive;
  try {
    await prisma.$transaction((tx) => lockTaxControlShared(tx, orgId()));
    exclusive = prisma.$transaction(
      async (tx) => {
        const [{ pid }] = await tx.$queryRaw`SELECT pg_backend_pid() AS pid`;
        exclusiveStarted.resolve(pid);
        return lockTaxControlExclusive(tx, orgId());
      },
      { timeout: 10000 },
    );
    await waitForBlocked(await exclusiveStarted.promise, holderPid);
  } finally {
    release.resolve();
    await holder;
  }
  assert.equal((await exclusive).generation, 0);
});

test("exclusive transaction rollback releases locks and leaves no partial control/event", async () => {
  const held = deferred(),
    release = deferred(),
    sharedStarted = deferred();
  const holder = prisma.$transaction(
    async (tx) => {
      await lockTaxControlExclusive(tx, orgId());
      await tx.taxControlEvent.create({ data: event() });
      await tx.organizationTaxControl.update({
        where: { organizationId: orgId() },
        data: { mode: "DRAINING", generation: 1, version: 2 },
      });
      const [{ pid }] = await tx.$queryRaw`SELECT pg_backend_pid() AS pid`;
      held.resolve(pid);
      await release.promise;
      throw new Error("Intentional rollback");
    },
    { timeout: 10000 },
  );
  const rolledBack = assert.rejects(holder, /Intentional rollback/);
  const holderPid = await held.promise;
  let reader;
  try {
    reader = prisma.$transaction(
      async (tx) => {
        const [{ pid }] = await tx.$queryRaw`SELECT pg_backend_pid() AS pid`;
        sharedStarted.resolve(pid);
        return lockTaxControlShared(tx, orgId());
      },
      { timeout: 10000 },
    );
    await waitForBlocked(await sharedStarted.promise, holderPid);
    assert.equal(
      (await readTaxControl(prisma, fixture.admin.id, {})).mode,
      "LEGACY",
    );
  } finally {
    release.resolve();
    await rolledBack;
  }
  assert.equal((await reader).generation, 0);
  assert.equal(
    await prisma.taxControlEvent.count({ where: { organizationId: orgId() } }),
    0,
  );
});

test("exclusive commit exposes the matching latest event to waiting shared readers; stale serializable snapshots abort", async () => {
  for (const isolationLevel of ["ReadCommitted", "Serializable"]) {
    const held = deferred(),
      release = deferred(),
      readerStarted = deferred();
    const writer = prisma.$transaction(
      async (tx) => {
        await lockTaxControlExclusive(tx, orgId());
        await tx.taxControlEvent.create({ data: event() });
        await tx.organizationTaxControl.update({
          where: { organizationId: orgId() },
          data: { mode: "DRAINING", generation: 1, version: 2 },
        });
        const [{ pid }] = await tx.$queryRaw`SELECT pg_backend_pid() AS pid`;
        held.resolve(pid);
        await release.promise;
      },
      { timeout: 10000 },
    );
    const writerPid = await held.promise;
    let reader, outcome;
    try {
      reader = prisma.$transaction(
        async (tx) => {
          const [{ pid }] = await tx.$queryRaw`SELECT pg_backend_pid() AS pid`;
          readerStarted.resolve(pid);
          return lockTaxControlShared(tx, orgId());
        },
        { timeout: 10000, isolationLevel },
      );
      // EN: Observe rejection immediately so the expected serialization abort is never unhandled.
      // FI: Käsittele hylkäys heti, jotta odotettu sarjallistamisen keskeytys ei jää käsittelemättä.
      outcome = reader.then(
        (value) => ({ value }),
        (error) => ({ error }),
      );
      await waitForBlocked(await readerStarted.promise, writerPid);
    } finally {
      release.resolve();
      await writer;
    }
    try {
      const result = await outcome;
      if (isolationLevel === "ReadCommitted") {
        assert.equal(result.value.mode, "DRAINING");
        assert.equal(result.value.generation, 1);
      } else {
        assert.ok(result.error);
        assert.ok(
          result.error.code === "P2034" ||
            (result.error.code === "P2010" &&
              result.error.meta?.code === "40001"),
        );
        assert.equal(
          (
            await prisma.$transaction(
              (tx) => lockTaxControlShared(tx, orgId()),
              { isolationLevel },
            )
          ).generation,
          1,
        );
      }
      assert.equal(
        (await readTaxControl(prisma, fixture.admin.id, {})).taxGeneration,
        1,
      );
    } finally {
      await reset();
    }
  }
});

test("fixture replacement restores original control and event copies exactly", async () => {
  const e = await prisma.taxControlEvent.create({ data: event() });
  const control = await prisma.organizationTaxControl.update({
    where: { organizationId: orgId() },
    data: { mode: "DRAINING", generation: 1, version: 2 },
  });
  const temporary = await beginOrganizationFixture();
  try {
    assert.equal(
      await prisma.taxControlEvent.count({
        where: { organizationId: orgId() },
      }),
      0,
    );
  } finally {
    await restoreOrganizationFixture(temporary);
  }
  assert.deepEqual(
    await prisma.organizationTaxControl.findUnique({
      where: { organizationId: orgId() },
    }),
    control,
  );
  assert.deepEqual(
    await prisma.taxControlEvent.findUnique({ where: { id: e.id } }),
    e,
  );
  await reset();
});
