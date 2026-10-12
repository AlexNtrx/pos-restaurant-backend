const { before, after, test } = require("node:test");
const assert = require("node:assert/strict");
const { randomUUID } = require("node:crypto");
const fs = require("node:fs");
const path = require("node:path");
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
const { saveTaxDraft } = require("../lib/tax-draft-service");
const { createTaxPolicyRevision } = require("../lib/tax-policy-service");
const {
  validateRevisionRequest,
  validateRevisionPage,
} = require("../lib/tax-policy-validation");
const { checkoutCounterDraft } = require("../lib/order-service");
const { printBillAfterPay } = require("../lib/legacy-receipt-service");
const { reserveRefund, finishRefund } = require("../lib/order-refund-service");
let fixture, organizationFixture, api;
const complete = () => ({
  countryCode: "FI",
  vatStatus: "REGISTERED",
  pricingMode: "FINAL_PRICE",
  rates: { FOOD_NON_ALCOHOLIC: 1350, ALCOHOL: 2550 },
  requestedEffectiveDate: "2030-01-01",
  reviewerName: "Proposed reviewer",
  nonRegistrationReason: null,
});
const orgId = () => organizationFixture.organization.id;
const request = (path, method = "GET", body, user = fixture.admin) =>
  fetch(`${api.apiBaseUrl}/organization/${path}`, {
    method,
    headers: headersFor(user),
    ...(body !== undefined && { body: JSON.stringify(body) }),
  });
const save = async (draft) => {
  const current = await prisma.organization.findUnique({
    where: { id: orgId() },
  });
  return saveTaxDraft(prisma, fixture.admin.id, {
    expectedVersion: current.taxSettingsVersion,
    draft,
  });
};
before(async () => {
  fixture = await createTestFixture();
  organizationFixture = await beginOrganizationFixture();
  api = await startApiServer();
});
after(async () => {
  await stopApiServer(api?.server);
  if (organizationFixture)
    await prisma.taxPolicyRevision.deleteMany({
      where: { organizationId: orgId() },
    });
  await cleanupTestFixture(fixture);
  await restoreOrganizationFixture(organizationFixture);
  await prisma.$disconnect();
});
test("additive SQL preserves existing organization and allows a historical actor without a User FK", async () => {
  const migration = fs
    .readFileSync(
      path.join(
        __dirname,
        "../prisma/migrations/20261011160000_tax_policy_revisions/migration.sql",
      ),
      "utf8",
    )
    .replaceAll('"TaxPolicyRevision', '"FIN02B_ProbeRevision')
    .replaceAll('"Organization"', '"FIN02B_ProbeOrg"')
    .replace("CREATE TABLE", "CREATE TEMP TABLE")
    .replace(
      ");\nCREATE UNIQUE INDEX",
      ") ON COMMIT DROP;\nCREATE UNIQUE INDEX",
    );
  await prisma.$transaction(async (tx) => {
    await tx.$executeRawUnsafe(
      'CREATE TEMP TABLE "FIN02B_ProbeOrg" ("id" INTEGER PRIMARY KEY, "name" TEXT NOT NULL) ON COMMIT DROP',
    );
    await tx.$executeRaw`INSERT INTO "FIN02B_ProbeOrg" VALUES (1, 'Existing seller')`;
    for (const statement of migration
      .split(";")
      .filter((value) => value.trim()))
      await tx.$executeRawUnsafe(statement);
    assert.deepEqual(await tx.$queryRaw`SELECT * FROM "FIN02B_ProbeOrg"`, [
      { id: 1, name: "Existing seller" },
    ]);
    await tx.$executeRaw`INSERT INTO "FIN02B_ProbeRevision" ("organizationId","sourceDraftVersion","configuration","sellerSnapshot","createdByUserId","createdByName") VALUES (1,1,'{}'::jsonb,'{}'::jsonb,99,'Historical user')`;
    const rows =
      await tx.$queryRaw`SELECT "schemaVersion", "createdByName" FROM "FIN02B_ProbeRevision"`;
    assert.deepEqual(rows, [
      { schemaVersion: 1, createdByName: "Historical user" },
    ]);
  });
});
test("strict revision request and bounded pagination reject forged state", () => {
  assert.equal(validateRevisionRequest({ expectedDraftVersion: 1 }), 1);
  for (const body of [
    null,
    [],
    {},
    { expectedDraftVersion: "1" },
    { expectedDraftVersion: 0 },
    { expectedDraftVersion: 1.5 },
    { expectedDraftVersion: 2147483648 },
    { expectedDraftVersion: 1, configuration: complete() },
    { expectedDraftVersion: 1, active: true },
    { expectedDraftVersion: 1, createdByUserId: 99 },
  ])
    assert.throws(
      () => validateRevisionRequest(body),
      (e) => e.status === 400,
    );
  assert.deepEqual(validateRevisionPage({}), {
    page: 1,
    pageSize: 10,
    skip: 0,
  });
  for (const query of [
    { page: "0" },
    { page: "1.1" },
    { page: "01" },
    { page: ["1", "2"] },
    { limit: "51" },
    { page: "2147483647", limit: "50" },
    { active: "true" },
  ])
    assert.throws(
      () => validateRevisionPage(query),
      (e) => e.status === 400,
    );
});
test("admin boundaries, missing setup and incomplete saved draft", async () => {
  for (const [path, method, body] of [
    ["tax-policy-review", "GET"],
    ["tax-policy-revisions", "GET"],
    ["tax-policy-revisions", "POST", { expectedDraftVersion: 1 }],
  ]) {
    assert.equal((await request(path, method, body, fixture.user)).status, 403);
    assert.equal(
      (
        await fetch(`${api.apiBaseUrl}/organization/${path}`, {
          method,
          headers: { "Content-Type": "application/json" },
          ...(body && { body: JSON.stringify(body) }),
        })
      ).status,
      401,
    );
  }
  const initial = await request("tax-policy-review");
  const unauthenticated = await fetch(
    `${api.apiBaseUrl}/organization/tax-policy-review`,
  );
  assert.equal(
    unauthenticated.headers.get("cache-control"),
    "private, no-store",
  );
  assert.equal(initial.headers.get("cache-control"), "private, no-store");
  assert.equal((await initial.json()).canCreateRevision, false);
  const org = await prisma.organization.findUnique({ where: { id: orgId() } });
  await prisma.organization.delete({ where: { id: orgId() } });
  try {
    const review = await (await request("tax-policy-review")).json();
    assert.equal(review.organizationConfigured, false);
    assert.equal(review.draftVersion, 0);
    assert.equal(
      (await (await request("tax-policy-revisions")).json()).totalCount,
      0,
    );
    const missing = await request("tax-policy-revisions", "POST", {
      expectedDraftVersion: 1,
    });
    assert.equal(missing.status, 409);
    assert.equal((await missing.json()).code, "RESTAURANT_SETUP_REQUIRED");
  } finally {
    const { taxSettingsDraft, ...data } = org;
    await prisma.organization.create({ data });
  }
  await save({
    ...complete(),
    countryCode: null,
    vatStatus: "UNCONFIRMED",
    reviewerName: null,
    requestedEffectiveDate: null,
  });
  const review = await (await request("tax-policy-review")).json();
  assert.equal(review.issues.length, 4);
  assert.equal(review.commercialReady, false);
  const failed = await request("tax-policy-revisions", "POST", {
    expectedDraftVersion: review.draftVersion,
  });
  assert.equal(failed.status, 409);
  assert.equal((await failed.json()).code, "TAX_POLICY_REVIEW_INCOMPLETE");
  assert.equal(await prisma.taxPolicyRevision.count(), 0);
  await prisma.user.update({
    where: { id: fixture.admin.id },
    data: { level: "kassa" },
  });
  try {
    assert.equal((await request("tax-policy-review")).status, 403);
    await assert.rejects(
      createTaxPolicyRevision(prisma, fixture.admin.id, {
        expectedDraftVersion: 1,
      }),
      (e) => e.status === 403,
    );
  } finally {
    await prisma.user.update({
      where: { id: fixture.admin.id },
      data: { level: "admin" },
    });
  }
  await prisma.user.update({
    where: { id: fixture.admin.id },
    data: { status: "cancel" },
  });
  try {
    assert.equal((await request("tax-policy-revisions")).status, 401);
  } finally {
    await prisma.user.update({
      where: { id: fixture.admin.id },
      data: { status: "use" },
    });
  }
});
test("registration branches, malformed stored metadata and seller validation", async () => {
  let saved = await save({
    ...complete(),
    vatStatus: "NOT_REGISTERED",
    nonRegistrationReason: null,
  });
  let review = await (await request("tax-policy-review")).json();
  assert.equal(
    review.issues.filter((i) => i.code === "RATE_MUST_BE_EMPTY").length,
    2,
  );
  assert.ok(review.issues.some((i) => i.field === "nonRegistrationReason"));
  saved = await save({
    ...complete(),
    vatStatus: "NOT_REGISTERED",
    rates: { FOOD_NON_ALCOHOLIC: null, ALCOHOL: null },
    nonRegistrationReason: "Owner must verify this proposal",
  });
  review = await (await request("tax-policy-review")).json();
  assert.equal(review.canCreateRevision, true);
  const result = await request("tax-policy-revisions", "POST", {
    expectedDraftVersion: saved.version,
  });
  assert.equal(result.status, 201);
  assert.equal(
    (await result.json()).revision.configuration.rates.ALCOHOL,
    null,
  );
  const stored = await prisma.organization.findUnique({
    where: { id: orgId() },
  });
  for (const corrupt of [
    { ...stored.taxSettingsDraft, schemaVersion: 2 },
    {
      ...stored.taxSettingsDraft,
      rates: { FOOD_NON_ALCOHOLIC: -1, ALCOHOL: null },
    },
    { ...stored.taxSettingsDraft, reviewerName: "x".repeat(121) },
    { ...stored.taxSettingsDraft, activated: true },
  ]) {
    await prisma.organization.update({
      where: { id: orgId() },
      data: { taxSettingsDraft: corrupt },
    });
    const failed = await request("tax-policy-review");
    assert.equal(failed.status, 409);
    assert.equal((await failed.json()).code, "TAX_POLICY_DRAFT_INVALID");
  }
  await prisma.organization.update({
    where: { id: orgId() },
    data: { taxSettingsDraft: stored.taxSettingsDraft, taxCode: "" },
  });
  try {
    assert.ok(
      (await (await request("tax-policy-review")).json()).issues.some(
        (i) => i.code === "SELLER_INCOMPLETE",
      ),
    );
  } finally {
    await prisma.organization.update({
      where: { id: orgId() },
      data: { taxCode: stored.taxCode },
    });
  }
});
test("role revocation between the outer check and transaction prevents any revision write", async () => {
  const saved = await save(complete());
  const beforeCount = await prisma.taxPolicyRevision.count();
  const instrumented = {
    user: prisma.user,
    $transaction: async (callback, options) => {
      await prisma.user.update({
        where: { id: fixture.admin.id },
        data: { level: "kassa" },
      });
      return prisma.$transaction(callback, options);
    },
  };
  try {
    await assert.rejects(
      createTaxPolicyRevision(instrumented, fixture.admin.id, {
        expectedDraftVersion: saved.version,
      }),
      (error) => error.status === 403,
    );
    assert.equal(await prisma.taxPolicyRevision.count(), beforeCount);
  } finally {
    await prisma.user.update({
      where: { id: fixture.admin.id },
      data: { level: "admin" },
    });
  }
});
test("competing creation stores one immutable server copy and exact replay survives later edits", async () => {
  const saved = await save(complete());
  const responses = await Promise.all([
    request("tax-policy-revisions", "POST", {
      expectedDraftVersion: saved.version,
    }),
    request("tax-policy-revisions", "POST", {
      expectedDraftVersion: saved.version,
    }),
  ]);
  assert.equal(responses.filter((r) => r.status === 201).length, 1);
  for (const r of responses) assert.ok([200, 201, 409].includes(r.status));
  const original = await (
    await request("tax-policy-revisions", "POST", {
      expectedDraftVersion: saved.version,
    })
  ).json();
  assert.equal(original.created, false);
  assert.equal(original.revision.createdByUserId, fixture.admin.id);
  assert.equal(
    Object.hasOwn(original.revision.configuration, "savedAt"),
    false,
  );
  assert.equal(Object.hasOwn(original.revision.sellerSnapshot, "logo"), false);
  assert.equal(
    await prisma.taxPolicyRevision.count({
      where: { organizationId: orgId(), sourceDraftVersion: saved.version },
    }),
    1,
  );
  await assert.rejects(
    prisma.organization.delete({ where: { id: orgId() } }),
    (e) =>
      e.code === "P2003" || e.message.includes("violates RESTRICT setting"),
  );
  const org = await prisma.organization.findUnique({ where: { id: orgId() } });
  const oldName = (
    await prisma.user.findUnique({ where: { id: fixture.admin.id } })
  ).name;
  await prisma.organization.update({
    where: { id: orgId() },
    data: { name: "Changed seller" },
  });
  await prisma.user.update({
    where: { id: fixture.admin.id },
    data: { name: "Changed admin" },
  });
  try {
    assert.equal(
      (await (await request("tax-policy-review")).json()).existingRevisionId,
      original.revision.id,
    );
    await save({ ...complete(), reviewerName: "New reviewer" });
    const replay = await request("tax-policy-revisions", "POST", {
      expectedDraftVersion: saved.version,
    });
    assert.equal(replay.status, 200);
    assert.deepEqual(await replay.json(), original);
    assert.deepEqual(
      await prisma.taxPolicyRevision
        .findUnique({ where: { id: original.revision.id } })
        .then((r) => JSON.parse(JSON.stringify(r))),
      original.revision,
    );
    for (const method of ["PUT", "PATCH", "DELETE"])
      assert.equal(
        (
          await request("tax-policy-revisions", method, {
            expectedDraftVersion: saved.version,
          })
        ).status,
        404,
      );
    const unknown = await request("tax-policy-revisions", "POST", {
      expectedDraftVersion: saved.version,
      approvedAt: "spoof",
    });
    assert.equal(unknown.status, 400);
    const stale = await request("tax-policy-revisions", "POST", {
      expectedDraftVersion: saved.version + 10,
    });
    assert.equal(stale.status, 409);
  } finally {
    await prisma.organization.update({
      where: { id: orgId() },
      data: { name: org.name },
    });
    await prisma.user.update({
      where: { id: fixture.admin.id },
      data: { name: oldName },
    });
  }
});
test("row lock captures committed seller and rejects a draft changed during capture", async () => {
  const saved = await save(complete());
  let release, locked;
  const gate = new Promise((resolve) => {
    release = resolve;
  });
  const ready = new Promise((resolve) => {
    locked = resolve;
  });
  const writer = prisma.$transaction(async (tx) => {
    await tx.$queryRaw`SELECT "id" FROM "Organization" WHERE "id" = ${orgId()} FOR UPDATE`;
    await tx.organization.update({
      where: { id: orgId() },
      data: {
        name: "Concurrent committed seller",
        taxSettingsVersion: { increment: 1 },
      },
    });
    locked();
    await gate;
  });
  await ready;
  let capturing;
  const started = new Promise((resolve) => {
    capturing = resolve;
  });
  const instrumented = {
    user: prisma.user,
    $transaction: (callback, options) =>
      prisma.$transaction(
        (tx) =>
          callback(
            new Proxy(tx, {
              get(target, key) {
                if (key === "$queryRaw")
                  return (...args) => {
                    const pending = target
                      .$queryRaw(...args)
                      .then((rows) => rows);
                    capturing();
                    return pending;
                  };
                return Reflect.get(target, key);
              },
            }),
          ),
        options,
      ),
  };
  const pending = createTaxPolicyRevision(instrumented, fixture.admin.id, {
    expectedDraftVersion: saved.version,
  });
  const outcome = pending.then(
    (value) => ({ value }),
    (error) => ({ error }),
  );
  await started;
  release();
  await writer;
  const conflict = await outcome;
  assert.equal(conflict.error.status, 409, String(conflict.error));
  assert.equal(
    await prisma.taxPolicyRevision.count({
      where: { organizationId: orgId(), sourceDraftVersion: saved.version },
    }),
    0,
  );
  const latest = await (await request("tax-policy-review")).json();
  assert.equal(latest.sellerSnapshot.name, "Concurrent committed seller");
  const created = await request("tax-policy-revisions", "POST", {
    expectedDraftVersion: latest.draftVersion,
  });
  assert.equal(created.status, 201);
  assert.equal(
    (await created.json()).revision.sellerSnapshot.name,
    latest.sellerSnapshot.name,
  );
});
test("history bounds and descending pages preserve seller and actor snapshots", async () => {
  for (let i = 0; i < 10; i++) {
    const saved = await save(complete());
    await createTaxPolicyRevision(prisma, fixture.admin.id, {
      expectedDraftVersion: saved.version,
    });
  }
  const first = await (
    await request("tax-policy-revisions?page=1&limit=10")
  ).json();
  const second = await (
    await request("tax-policy-revisions?page=2&limit=10")
  ).json();
  assert.equal(first.results.length, 10);
  assert.equal(first.totalCount, 13);
  assert.equal(first.pageCount, 2);
  assert.equal(second.results.length, 3);
  assert.ok(
    first.results.every((r, i) => i === 0 || first.results[i - 1].id > r.id),
  );
  assert.ok(first.results.at(-1).id > second.results[0].id);
  for (const query of ["limit=51", "page=0", "page=1&page=2", "approved=true"])
    assert.equal((await request(`tax-policy-revisions?${query}`)).status, 400);
});
test("stored review candidates do not change payment VAT, exact replay or receipt output", async () => {
  const prior = process.env.VAT_DEMO_ENABLED;
  process.env.VAT_DEMO_ENABLED = "true";
  await prisma.food.update({
    where: { id: fixture.food.id },
    data: { taxCategory: "FOOD_NON_ALCOHOLIC" },
  });
  try {
    const intent = {
      actor: { type: "STAFF", userId: fixture.admin.id, level: "admin" },
      idempotencyKey: randomUUID(),
      intent: {
        serviceType: "TAKEAWAY",
        items: [{ foodId: fixture.food.id, quantity: 1 }],
      },
      expectedTotal: 20,
      payType: "cash",
      inputMoney: 30,
    };
    const bill = await checkoutCounterDraft(prisma, intent);
    const receipt = await printBillAfterPay({
      user: fixture.user,
      body: { billId: bill.id },
    });
    const saved = await save({
      ...complete(),
      rates: { FOOD_NON_ALCOHOLIC: 9900, ALCOHOL: 9800 },
    });
    await createTaxPolicyRevision(prisma, fixture.admin.id, {
      expectedDraftVersion: saved.version,
    });
    assert.equal((await checkoutCounterDraft(prisma, intent)).id, bill.id);
    assert.deepEqual(
      await printBillAfterPay({
        user: fixture.user,
        body: { billId: bill.id },
      }),
      receipt,
    );
    const next = await checkoutCounterDraft(prisma, {
      ...intent,
      idempotencyKey: randomUUID(),
    });
    assert.deepEqual(next.vatSnapshot, bill.vatSnapshot);
    assert.equal(next.amount, bill.amount);
    assert.equal(
      BigInt(next.vatSnapshot.netCents) + BigInt(next.vatSnapshot.taxCents),
      next.amount,
    );
    assert.equal(next.vatSnapshot.profile, "FI_RESTAURANT_DEMO_V1");
    const order = await prisma.order.findUniqueOrThrow({
      where: { id: bill.Orders[0].id },
    });
    const key = randomUUID();
    const refund = await reserveRefund(prisma, {
      actor: intent.actor,
      orderId: order.id,
      body: {
        expectedVersion: order.version,
        idempotencyKey: key,
        method: "cash",
        reason: "Review candidate regression",
      },
    });
    assert.equal(
      refund.vatSnapshot.taxCents,
      (-BigInt(bill.vatSnapshot.taxCents)).toString(),
    );
    const finish = {
      actor: intent.actor,
      orderId: order.id,
      body: { idempotencyKey: key, reference: "Synthetic returned cash" },
    };
    const completed = await finishRefund(prisma, finish);
    assert.deepEqual(
      (await finishRefund(prisma, finish)).vatSnapshot,
      completed.vatSnapshot,
    );
  } finally {
    if (prior === undefined) delete process.env.VAT_DEMO_ENABLED;
    else process.env.VAT_DEMO_ENABLED = prior;
  }
});
