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
const { validateTaxDraftRequest } = require("../lib/tax-draft-validation");
const { saveTaxDraft } = require("../lib/tax-draft-service");
const { checkoutCounterDraft } = require("../lib/order-service");
const { printBillAfterPay } = require("../lib/legacy-receipt-service");
let fixture, organizationFixture, api;
const empty = () => ({
  countryCode: null,
  vatStatus: "UNCONFIRMED",
  pricingMode: "FINAL_PRICE",
  rates: { FOOD_NON_ALCOHOLIC: null, ALCOHOL: null },
  requestedEffectiveDate: null,
  reviewerName: null,
  nonRegistrationReason: null,
});
const request = (method = "GET", body, user = fixture.admin) =>
  fetch(`${api.apiBaseUrl}/organization/tax-draft`, {
    method,
    headers: headersFor(user),
    ...(body && { body: JSON.stringify(body) }),
  });
before(async () => {
  fixture = await createTestFixture();
  organizationFixture = await beginOrganizationFixture();
  api = await startApiServer();
});
after(async () => {
  await stopApiServer(api?.server);
  await cleanupTestFixture(fixture);
  await restoreOrganizationFixture(organizationFixture);
  await prisma.$disconnect();
});

test("additive migration preserves an existing seller row with null draft and version zero", async () => {
  // EN: Replay the exact migration against a temporary pre-migration table, never the live Organization table.
  // FI: Toista sama migraatio tilapäiseen vanhan rakenteen tauluun, älä koskaan aktiiviseen Organization-tauluun.
  const migration = fs
    .readFileSync(
      path.join(
        __dirname,
        "../prisma/migrations/20261011140000_tax_settings_draft/migration.sql",
      ),
      "utf8",
    )
    .replaceAll('"Organization"', '"FIN02A_MigrationProbe"');
  await prisma.$transaction(async (tx) => {
    await tx.$executeRawUnsafe(
      'CREATE TEMP TABLE "FIN02A_MigrationProbe" ("id" INTEGER PRIMARY KEY, "name" TEXT NOT NULL, "taxCode" TEXT NOT NULL) ON COMMIT DROP',
    );
    await tx.$executeRaw`INSERT INTO "FIN02A_MigrationProbe" ("id", "name", "taxCode") VALUES (1, 'Existing seller', 'TEST')`;
    await tx.$executeRawUnsafe(migration);
    const rows = await tx.$queryRaw`SELECT * FROM "FIN02A_MigrationProbe"`;
    assert.deepEqual(rows, [
      {
        id: 1,
        name: "Existing seller",
        taxCode: "TEST",
        taxSettingsDraft: null,
        taxSettingsVersion: 0,
      },
    ]);
  });
});
test("draft validator accepts incomplete data and strictly rejects malformed or client metadata", () => {
  assert.deepEqual(
    validateTaxDraftRequest({ expectedVersion: 0, draft: empty() }).draft,
    empty(),
  );
  const valid = {
    ...empty(),
    requestedEffectiveDate: "2028-02-29",
    reviewerName: " Reviewer ",
  };
  assert.equal(
    validateTaxDraftRequest({ expectedVersion: 0, draft: valid }).draft
      .reviewerName,
    "Reviewer",
  );
  for (const patch of [
    { countryCode: "SE" },
    { vatStatus: "ACTIVE" },
    { pricingMode: "NET" },
    { requestedEffectiveDate: "2026-02-29" },
    { requestedEffectiveDate: "0000-01-01" },
    { requestedEffectiveDate: 3 },
    { reviewerName: "x".repeat(121) },
    { nonRegistrationReason: "x".repeat(501) },
    { savedByUserId: 2 },
    { schemaVersion: 1 },
    { savedAt: "2026-01-01" },
  ])
    assert.throws(
      () =>
        validateTaxDraftRequest({
          expectedVersion: 0,
          draft: { ...empty(), ...patch },
        }),
      (error) => error.status === 400,
    );
  for (const rate of [0, -1, 13.5, 10001, "1350", undefined])
    assert.throws(() =>
      validateTaxDraftRequest({
        expectedVersion: 0,
        draft: {
          ...empty(),
          rates: { FOOD_NON_ALCOHOLIC: rate, ALCOHOL: null },
        },
      }),
    );
  for (const version of [-1, 1.5, "0", 2147483647])
    assert.throws(() =>
      validateTaxDraftRequest({ expectedVersion: version, draft: empty() }),
    );
  assert.throws(() =>
    validateTaxDraftRequest({
      expectedVersion: 0,
      draft: empty(),
      activate: true,
    }),
  );
});
test("admin boundary, missing setup, and additive defaults", async () => {
  for (const method of ["GET", "PUT"])
    assert.equal(
      (
        await request(
          method,
          method === "PUT" ? { expectedVersion: 0, draft: empty() } : undefined,
          fixture.user,
        )
      ).status,
      403,
    );
  for (const level of ["waiter", "kitchen"]) {
    const user = await prisma.user.create({
      data: {
        name: `tax-${level}`,
        username: randomUUID(),
        password: "synthetic",
        level,
        status: "use",
      },
    });
    try {
      for (const method of ["GET", "PUT"])
        assert.equal(
          (
            await request(
              method,
              method === "PUT"
                ? { expectedVersion: 0, draft: empty() }
                : undefined,
              user,
            )
          ).status,
          403,
        );
    } finally {
      await prisma.user.delete({ where: { id: user.id } });
    }
  }
  assert.equal(
    (await fetch(`${api.apiBaseUrl}/organization/tax-draft`)).status,
    401,
  );
  const org = await prisma.organization.findUnique({
    where: { id: organizationFixture.organization.id },
  });
  assert.equal(org.taxSettingsDraft, null);
  assert.equal(org.taxSettingsVersion, 0);
  await prisma.organization.delete({ where: { id: org.id } });
  try {
    assert.deepEqual(await (await request()).json(), {
      organizationConfigured: false,
      draft: null,
      version: 0,
    });
    const missing = await request("PUT", {
      expectedVersion: 0,
      draft: empty(),
    });
    assert.equal(missing.status, 409);
    assert.equal((await missing.json()).code, "RESTAURANT_SETUP_REQUIRED");
  } finally {
    const { taxSettingsDraft, ...data } = org;
    await prisma.organization.create({ data });
  }
  await prisma.user.update({
    where: { id: fixture.admin.id },
    data: { status: "cancel" },
  });
  try {
    await assert.rejects(
      saveTaxDraft(prisma, fixture.admin.id, {
        expectedVersion: 0,
        draft: empty(),
      }),
      (error) => error.status === 403,
    );
    assert.equal((await request()).status, 401);
  } finally {
    await prisma.user.update({
      where: { id: fixture.admin.id },
      data: { status: "use" },
    });
  }
  await prisma.user.update({
    where: { id: fixture.admin.id },
    data: { level: "kassa" },
  });
  try {
    assert.equal((await request()).status, 403);
  } finally {
    await prisma.user.update({
      where: { id: fixture.admin.id },
      data: { level: "admin" },
    });
  }
});
test("competing tabs have one winner, server metadata, and stale or invalid writes leave draft intact", async () => {
  const responses = await Promise.all([
    request("PUT", { expectedVersion: 0, draft: empty() }),
    request("PUT", {
      expectedVersion: 0,
      draft: { ...empty(), reviewerName: "Other tab" },
    }),
  ]);
  assert.deepEqual(responses.map((r) => r.status).sort(), [200, 409]);
  const saved = await (await request()).json();
  assert.equal(saved.version, 1);
  assert.equal(saved.draft.schemaVersion, 1);
  assert.equal(saved.draft.savedByUserId, fixture.admin.id);
  assert.ok(Number.isFinite(Date.parse(saved.draft.savedAt)));
  const stale = await request("PUT", { expectedVersion: 0, draft: empty() });
  assert.equal(stale.status, 409);
  assert.equal((await stale.json()).code, "TAX_DRAFT_CONFLICT");
  const invalid = await request("PUT", {
    expectedVersion: 1,
    draft: { ...empty(), savedAt: "spoof" },
  });
  assert.equal(invalid.status, 400);
  assert.deepEqual(await (await request()).json(), saved);
  const info = await fetch(`${api.apiBaseUrl}/organization/info`, {
    headers: headersFor(fixture.admin),
  });
  const result = (await info.json()).result;
  assert.deepEqual(
    Object.keys(result).sort(),
    [
      "id",
      "name",
      "phone",
      "address",
      "email",
      "website",
      "bankNo",
      "logo",
      "taxCode",
    ].sort(),
  );
  const { id, ...settings } = result;
  const update = await fetch(`${api.apiBaseUrl}/organization/create`, {
    method: "POST",
    headers: headersFor(fixture.admin),
    body: JSON.stringify(settings),
  });
  assert.equal(update.status, 200);
  assert.deepEqual(await (await request()).json(), saved);
});
test("draft edits do not change new payments, committed snapshots, exact replay, or demo policy", async () => {
  const previousFlag = process.env.VAT_DEMO_ENABLED;
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
    assert.ok(
      bill.vatSnapshot,
      "demo snapshot must exist for financial comparison",
    );
    const original = await printBillAfterPay({
      user: fixture.user,
      body: { billId: bill.id },
    });
    for (const vatStatus of ["REGISTERED", "NOT_REGISTERED"]) {
      const current = await (await request()).json();
      const changed = await request("PUT", {
        expectedVersion: current.version,
        draft: {
          ...empty(),
          countryCode: "FI",
          vatStatus,
          rates: { FOOD_NON_ALCOHOLIC: 9900, ALCOHOL: 9800 },
          requestedEffectiveDate: "2030-01-01",
        },
      });
      assert.equal(changed.status, 200);
      assert.deepEqual(
        await printBillAfterPay({
          user: fixture.user,
          body: { billId: bill.id },
        }),
        original,
      );
      assert.equal((await checkoutCounterDraft(prisma, intent)).id, bill.id);
      const next = await checkoutCounterDraft(prisma, {
        ...intent,
        idempotencyKey: randomUUID(),
      });
      assert.equal(next.amount, bill.amount);
      assert.deepEqual(next.vatSnapshot, bill.vatSnapshot);
      assert.deepEqual(next.receiptSnapshot, bill.receiptSnapshot);
    }
  } finally {
    if (previousFlag === undefined) delete process.env.VAT_DEMO_ENABLED;
    else process.env.VAT_DEMO_ENABLED = previousFlag;
  }
});
