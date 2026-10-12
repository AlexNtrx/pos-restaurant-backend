const { before, after, test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { randomUUID } = require("node:crypto");
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
  createTaxApproval,
  listTaxApprovals,
} = require("../lib/tax-approval-service");
const {
  validateApprovalRequest,
  validateApprovalPage,
  helsinkiDay,
} = require("../lib/tax-approval-validation");
let fixture, organizationFixture, api, source;
const orgId = () => organizationFixture.organization.id;
const configuration = () => ({
  countryCode: "FI",
  vatStatus: "REGISTERED",
  pricingMode: "FINAL_PRICE",
  rates: { FOOD_NON_ALCOHOLIC: 1350, ALCOHOL: 2550 },
  requestedEffectiveDate: "2030-01-01",
  reviewerName: "Proposed reviewer",
  nonRegistrationReason: null,
});
const evidence = () => ({
  schemaVersion: 1,
  reviewedByName: "Actual synthetic reviewer",
  reviewedOn: "2026-01-01",
  evidenceReference: "Disposable test-only evidence",
  attestations: {
    merchantIdentityConfirmed: true,
    taxTreatmentConfirmed: true,
    categoryMappingConfirmed: true,
    roundingConfirmed: true,
  },
});
const body = () => ({
  sourceRevisionId: source.id,
  expectedDraftVersion: source.sourceDraftVersion,
  idempotencyKey: randomUUID(),
  reviewEvidence: evidence(),
});
const saveSource = async (draft = configuration()) => {
  const organization = await prisma.organization.findUnique({
    where: { id: orgId() },
  });
  const saved = await saveTaxDraft(prisma, fixture.admin.id, {
    expectedVersion: organization.taxSettingsVersion,
    draft,
  });
  return (
    await createTaxPolicyRevision(prisma, fixture.admin.id, {
      expectedDraftVersion: saved.version,
    })
  ).revision;
};
const request = (method = "GET", payload, query = "", user = fixture.admin) =>
  fetch(`${api.apiBaseUrl}/organization/tax-policy-approvals${query}`, {
    method,
    headers: user ? headersFor(user) : { "Content-Type": "application/json" },
    ...(payload && { body: JSON.stringify(payload) }),
  });
before(async () => {
  fixture = await createTestFixture();
  organizationFixture = await beginOrganizationFixture();
  source = await saveSource();
  api = await startApiServer();
});
after(async () => {
  await stopApiServer(api?.server);
  if (organizationFixture) {
    await prisma.taxPolicyApproval.deleteMany({
      where: { organizationId: orgId() },
    });
    await prisma.taxPolicyRevision.deleteMany({
      where: { organizationId: orgId() },
    });
  }
  await cleanupTestFixture(fixture);
  await restoreOrganizationFixture(organizationFixture);
  await prisma.$disconnect();
});
test("additive migration preserves parent data and enforces same-org source, immutable actor copies and SQL constraints", async () => {
  const migration = fs
    .readFileSync(
      path.join(
        __dirname,
        "../prisma/migrations/20261012100000_tax_policy_approvals/migration.sql",
      ),
      "utf8",
    )
    .replaceAll('"TaxPolicyApproval', '"ApprovalProbe')
    .replaceAll('"TaxPolicyRevision', '"RevisionProbe')
    .replaceAll('"Organization"', '"OrgProbe"')
    .replace(
      'CREATE TABLE "ApprovalProbe"',
      'CREATE TEMP TABLE "ApprovalProbe"',
    );
  await prisma.$transaction(async (tx) => {
    await tx.$executeRawUnsafe(
      'CREATE TEMP TABLE "OrgProbe" (id INTEGER PRIMARY KEY, name TEXT) ON COMMIT DROP',
    );
    await tx.$executeRawUnsafe(
      'CREATE TEMP TABLE "RevisionProbe" (id INTEGER PRIMARY KEY, "organizationId" INTEGER, configuration JSONB) ON COMMIT DROP',
    );
    await tx.$executeRaw`INSERT INTO "OrgProbe" VALUES (1, 'Original'), (2, 'Other')`;
    await tx.$executeRaw`INSERT INTO "RevisionProbe" VALUES (1, 1, '{}'::jsonb)`;
    for (const sql of migration.split(";").filter((sql) => sql.trim()))
      await tx.$executeRawUnsafe(sql);
    const insert = (overrides = {}) => {
      const d = {
        org: 1,
        source: 1,
        version: 1,
        schema: 1,
        actor: 999999,
        name: "Historical actor",
        key: randomUUID(),
        fingerprint: "a".repeat(64),
        config: "{}",
        ...overrides,
      };
      return tx.$executeRaw`INSERT INTO "ApprovalProbe" ("organizationId","sourceRevisionId","sourceDraftVersion","schemaVersion","configuration","sellerSnapshot","reviewEvidence","idempotencyKey","requestFingerprint","recordedByUserId","recordedByName") VALUES (${d.org},${d.source},${d.version},${d.schema},${d.config}::jsonb,'{}'::jsonb,'{}'::jsonb,${d.key},${d.fingerprint},${d.actor},${d.name})`;
    };
    for (const data of [
      { org: 2 },
      { version: 0 },
      { schema: 2 },
      { actor: 0 },
      { name: " " },
      { key: "bad" },
      { fingerprint: "B".repeat(64) },
      { config: "[]" },
    ]) {
      await tx.$executeRawUnsafe("SAVEPOINT invalid_probe");
      await assert.rejects(insert(data));
      await tx.$executeRawUnsafe("ROLLBACK TO SAVEPOINT invalid_probe");
    }
    await insert();
    assert.deepEqual(
      await tx.$queryRaw`SELECT name FROM "OrgProbe" WHERE id=1`,
      [{ name: "Original" }],
    );
    assert.equal(
      (await tx.$queryRaw`SELECT "recordedByUserId" FROM "ApprovalProbe"`)[0]
        .recordedByUserId,
      999999,
    );
    await tx.$executeRawUnsafe('DROP TABLE "ApprovalProbe"');
  });
});
test("strict body/evidence/calendar/query reject forged values without defaults", () => {
  assert.equal(
    validateApprovalRequest(body()).reviewEvidence.reviewedByName,
    "Actual synthetic reviewer",
  );
  for (const payload of [
    { ...body(), active: true },
    { ...body(), recordedByUserId: 99 },
    { ...body(), configuration: configuration() },
    { ...body(), sourceRevisionId: "1" },
    { ...body(), expectedDraftVersion: 2147483648 },
    { ...body(), idempotencyKey: randomUUID().toUpperCase() },
    { ...body(), reviewEvidence: { ...evidence(), reviewedOn: "2026-02-30" } },
    { ...body(), reviewEvidence: { ...evidence(), reviewedByName: " " } },
    {
      ...body(),
      reviewEvidence: { ...evidence(), evidenceReference: "x".repeat(501) },
    },
    {
      ...body(),
      reviewEvidence: {
        ...evidence(),
        attestations: { ...evidence().attestations, roundingConfirmed: "true" },
      },
    },
  ])
    assert.throws(
      () => validateApprovalRequest(payload),
      (error) => error.status === 400,
    );
  for (const query of [
    { page: "01" },
    { page: ["1", "2"] },
    { limit: "51" },
    { page: "2147483647", limit: "50" },
    { active: "true" },
  ])
    assert.throws(
      () => validateApprovalPage(query),
      (error) => error.body.code === "INVALID_TAX_APPROVAL_QUERY",
    );
  assert.equal(helsinkiDay(new Date("2026-01-01T22:30:00.000Z")), "2026-01-02");
});
test("HTTP admin boundaries/cache, strict query and unsupported edit routes", async () => {
  for (const method of ["GET", "POST"])
    for (const [user, status] of [
      [null, 401],
      [fixture.user, 403],
    ]) {
      const response = await request(
        method,
        method === "POST" ? body() : undefined,
        "",
        user,
      );
      assert.equal(response.status, status);
      assert.equal(response.headers.get("cache-control"), "private, no-store");
    }
  for (const query of [
    "?page=01",
    "?page=1&page=2",
    "?limit=51",
    "?active=true",
  ])
    assert.equal((await request("GET", undefined, query)).status, 400);
  for (const method of ["PUT", "PATCH", "DELETE"])
    assert.equal((await request(method, body())).status, 404);
  assert.equal(
    (await request("POST", { ...body(), effectiveFrom: "2026-01-01" })).status,
    400,
  );
});
test("actual approval records server copies while payments, drafts and carts remain untouched", async () => {
  const before = await Promise.all([
    prisma.organization.findMany(),
    prisma.order.findMany(),
    prisma.billSale.findMany(),
    prisma.saleTemp.findMany(),
    prisma.orderRefund.findMany(),
  ]);
  const payload = body();
  const response = await request("POST", payload);
  assert.equal(response.status, 201);
  assert.equal(response.headers.get("cache-control"), "private, no-store");
  const result = await response.json();
  assert.equal(result.created, true);
  assert.equal(result.canActivate, false);
  assert.equal(result.commercialReady, false);
  assert.equal(result.approval.configuration.reviewerName, "Proposed reviewer");
  assert.equal(
    result.approval.reviewEvidence.reviewedByName,
    "Actual synthetic reviewer",
  );
  assert.equal(result.approval.recordedByUserId, fixture.admin.id);
  assert.equal(Object.hasOwn(result.approval, "idempotencyKey"), false);
  assert.equal(Object.hasOwn(result.approval, "effectiveFrom"), false);
  assert.deepEqual(
    await Promise.all([
      prisma.organization.findMany(),
      prisma.order.findMany(),
      prisma.billSale.findMany(),
      prisma.saleTemp.findMany(),
      prisma.orderRefund.findMany(),
    ]),
    before,
  );
  assert.deepEqual(
    (await (await request("POST", payload)).json()).approval,
    result.approval,
  );
});
test("exact retry returns original approval after current draft, seller, name and clock change; owner/body/key conflicts stay distinct", async () => {
  source = await saveSource();
  const payload = body();
  const first = await createTaxApproval(prisma, fixture.admin.id, payload);
  const organization = await prisma.organization.findUnique({
    where: { id: orgId() },
  });
  try {
    await prisma.organization.update({
      where: { id: orgId() },
      data: {
        name: "Changed seller",
        taxSettingsVersion: organization.taxSettingsVersion + 1,
      },
    });
    await prisma.user.update({
      where: { id: fixture.admin.id },
      data: { name: "Changed actor" },
    });
    const replay = await createTaxApproval(
      prisma,
      fixture.admin.id,
      payload,
      () => new Date("2000-01-01T00:00:00.000Z"),
    );
    assert.equal(replay.created, false);
    assert.deepEqual(replay.approval, first.approval);
    await assert.rejects(
      createTaxApproval(prisma, fixture.admin.id, {
        ...payload,
        reviewEvidence: {
          ...payload.reviewEvidence,
          evidenceReference: "Other evidence",
        },
      }),
      (error) => error.body.code === "TAX_APPROVAL_IDEMPOTENCY_CONFLICT",
    );
    await prisma.user.update({
      where: { id: fixture.user.id },
      data: { level: "admin" },
    });
    await assert.rejects(
      createTaxApproval(prisma, fixture.user.id, payload),
      (error) => error.body.code === "TAX_APPROVAL_IDEMPOTENCY_CONFLICT",
    );
    await assert.rejects(
      createTaxApproval(prisma, fixture.admin.id, {
        ...payload,
        idempotencyKey: randomUUID(),
      }),
      (error) =>
        error.body.code === "TAX_POLICY_APPROVAL_ALREADY_EXISTS" &&
        error.body.existingApprovalId === first.approval.id,
    );
    await prisma.user.update({
      where: { id: fixture.admin.id },
      data: { status: "delete" },
    });
    await assert.rejects(
      createTaxApproval(prisma, fixture.admin.id, payload),
      (error) => error.status === 403,
    );
  } finally {
    const { id, ...data } = organization;
    await prisma.organization.update({ where: { id }, data });
    await prisma.user.update({
      where: { id: fixture.admin.id },
      data: { name: fixture.admin.name, status: "use" },
    });
    await prisma.user.update({
      where: { id: fixture.user.id },
      data: { level: "kassa" },
    });
  }
});
test("first creation rejects seller/version/content drift, absent source, future review and revoked transaction actor", async () => {
  source = await saveSource();
  const payload = body();
  const organization = await prisma.organization.findUnique({
    where: { id: orgId() },
  });
  try {
    for (const data of [
      { name: "Other merchant" },
      { taxSettingsVersion: organization.taxSettingsVersion + 1 },
      {
        taxSettingsDraft: {
          ...organization.taxSettingsDraft,
          reviewerName: "Other draft",
        },
      },
    ]) {
      await prisma.organization.update({ where: { id: orgId() }, data });
      await assert.rejects(
        createTaxApproval(prisma, fixture.admin.id, payload),
        (error) => error.body.code === "TAX_APPROVAL_SOURCE_CHANGED",
      );
      const { id, ...restored } = organization;
      await prisma.organization.update({ where: { id }, data: restored });
    }
    await assert.rejects(
      createTaxApproval(prisma, fixture.admin.id, {
        ...payload,
        sourceRevisionId: 2147483647,
      }),
      (error) => error.status === 404,
    );
    await assert.rejects(
      createTaxApproval(prisma, fixture.admin.id, {
        ...payload,
        reviewEvidence: { ...evidence(), reviewedOn: "2099-01-01" },
      }),
      (error) => error.body.code === "TAX_APPROVAL_INCOMPLETE",
    );
    const revoked = {
      user: prisma.user,
      $transaction: (callback, options) =>
        prisma.$transaction(
          (tx) =>
            callback({
              ...tx,
              user: {
                findUnique: async () => ({
                  status: "use",
                  level: "kassa",
                  name: "Revoked",
                }),
              },
            }),
          options,
        ),
    };
    await assert.rejects(
      createTaxApproval(revoked, fixture.admin.id, payload),
      (error) => error.status === 403,
    );
    assert.equal(
      await prisma.taxPolicyApproval.count({
        where: { sourceRevisionId: source.id },
      }),
      0,
    );
  } finally {
    const { id, ...restored } = organization;
    await prisma.organization.update({ where: { id }, data: restored });
  }
});
test("NOT_REGISTERED stores absent rates and reason without activation; incomplete source is blocked", async () => {
  source = await saveSource({
    ...configuration(),
    vatStatus: "NOT_REGISTERED",
    rates: { FOOD_NON_ALCOHOLIC: null, ALCOHOL: null },
    nonRegistrationReason: "Synthetic review reason",
  });
  const result = await createTaxApproval(prisma, fixture.admin.id, body());
  assert.deepEqual(result.approval.configuration.rates, {
    FOOD_NON_ALCOHOLIC: null,
    ALCOHOL: null,
  });
  assert.equal(
    result.approval.configuration.nonRegistrationReason,
    "Synthetic review reason",
  );
  source = await saveSource();
  const sourceRow = await prisma.taxPolicyRevision.findUnique({
    where: { id: source.id },
  });
  const organization = await prisma.organization.findUnique({
    where: { id: orgId() },
  });
  try {
    await prisma.taxPolicyRevision.update({
      where: { id: source.id },
      data: {
        configuration: { ...sourceRow.configuration, reviewerName: null },
      },
    });
    await prisma.organization.update({
      where: { id: orgId() },
      data: {
        taxSettingsDraft: {
          ...organization.taxSettingsDraft,
          reviewerName: null,
        },
      },
    });
    await assert.rejects(
      createTaxApproval(prisma, fixture.admin.id, body()),
      (error) => error.body.code === "TAX_APPROVAL_INCOMPLETE",
    );
  } finally {
    await prisma.taxPolicyRevision.update({
      where: { id: source.id },
      data: { configuration: sourceRow.configuration },
    });
    await prisma.organization.update({
      where: { id: orgId() },
      data: { taxSettingsDraft: organization.taxSettingsDraft },
    });
  }
});
test("concurrent requests create one immutable record; exact retry after conflicts returns it", async () => {
  source = await saveSource();
  const payload = body();
  const results = await Promise.allSettled(
    Array.from({ length: 5 }, () =>
      createTaxApproval(prisma, fixture.admin.id, payload),
    ),
  );
  assert.equal(
    results.filter((r) => r.status === "fulfilled" && r.value.created).length,
    1,
  );
  for (const result of results.filter((r) => r.status === "rejected"))
    assert.equal(result.reason.body.code, "TAX_APPROVAL_CONFLICT");
  assert.equal(
    await prisma.taxPolicyApproval.count({
      where: { sourceRevisionId: source.id },
    }),
    1,
  );
  assert.equal(
    (await createTaxApproval(prisma, fixture.admin.id, payload)).created,
    false,
  );
});
test("row lock captures committed seller and refuses a newer draft without writing approval", async () => {
  source = await saveSource();
  const payload = body();
  const organization = await prisma.organization.findUnique({
    where: { id: orgId() },
  });
  let release, locked;
  const ready = new Promise((resolve) => {
      locked = resolve;
    }),
    hold = new Promise((resolve) => {
      release = resolve;
    });
  const writer = prisma.$transaction(async (tx) => {
    await tx.$queryRaw`SELECT id FROM "Organization" WHERE id=${orgId()} FOR UPDATE`;
    locked();
    await hold;
    await tx.organization.update({
      where: { id: orgId() },
      data: { taxSettingsVersion: organization.taxSettingsVersion + 1 },
    });
  });
  await ready;
  const approval = createTaxApproval(prisma, fixture.admin.id, payload).then(
    (result) => ({ result }),
    (error) => ({ error }),
  );
  release();
  await writer;
  try {
    const result = await approval;
    assert.ok(
      ["TAX_APPROVAL_CONFLICT", "TAX_APPROVAL_SOURCE_CHANGED"].includes(
        result.error?.body.code,
      ),
    );
    assert.equal(
      await prisma.taxPolicyApproval.count({
        where: { sourceRevisionId: source.id },
      }),
      0,
    );
  } finally {
    await prisma.organization.update({
      where: { id: orgId() },
      data: { taxSettingsVersion: organization.taxSettingsVersion },
    });
  }
});
test("bounded descending history validates copies and retains original actor after rename/deletion", async () => {
  const page = await listTaxApprovals(prisma, fixture.admin.id, {
    page: "1",
    limit: "2",
  });
  assert.equal(page.results.length, 2);
  assert.equal(page.canActivate, false);
  assert.equal(page.commercialReady, false);
  assert.ok(page.results[0].id > page.results[1].id);
  const approval = page.results[0],
    row = await prisma.taxPolicyApproval.findUnique({
      where: { id: approval.id },
    });
  try {
    await prisma.taxPolicyApproval.update({
      where: { id: approval.id },
      data: { recordedByUserId: 9999999 },
    });
    assert.equal(
      (await listTaxApprovals(prisma, fixture.admin.id, {})).results[0]
        .recordedByName,
      approval.recordedByName,
    );
    for (const data of [
      { configuration: { ...row.configuration, active: true } },
      {
        reviewEvidence: {
          ...row.reviewEvidence,
          attestations: {
            ...row.reviewEvidence.attestations,
            roundingConfirmed: false,
          },
        },
      },
      { sellerSnapshot: { ...row.sellerSnapshot, extra: true } },
      { requestFingerprint: "b".repeat(64) },
    ]) {
      await prisma.taxPolicyApproval.update({
        where: { id: approval.id },
        data,
      });
      const response = await request();
      assert.equal(response.status, 409);
      assert.equal((await response.json()).code, "TAX_POLICY_APPROVAL_INVALID");
      const { id, ...restored } = row;
      await prisma.taxPolicyApproval.update({ where: { id }, data: restored });
    }
  } finally {
    const { id, ...restored } = row;
    await prisma.taxPolicyApproval.update({ where: { id }, data: restored });
  }
});
