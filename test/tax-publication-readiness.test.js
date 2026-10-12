const { before, after, test } = require("node:test");
const assert = require("node:assert/strict");
const { randomUUID } = require("node:crypto");
const { PrismaClient } = require("@prisma/client");
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
  readTaxPublicationReadiness,
  validateReadinessQuery,
} = require("../lib/tax-publication-readiness-service");
let fixture, organizationFixture, api, candidate;
const orgId = () => organizationFixture.organization.id;
const configuration = () => ({
  countryCode: "FI",
  vatStatus: "REGISTERED",
  pricingMode: "FINAL_PRICE",
  rates: { FOOD_NON_ALCOHOLIC: 1350, ALCOHOL: 2550 },
  requestedEffectiveDate: "2030-01-01",
  reviewerName: "Synthetic reviewer",
  nonRegistrationReason: null,
});
const saveCandidate = async (draft = configuration()) => {
  const current = await prisma.organization.findUnique({
    where: { id: orgId() },
  });
  const saved = await saveTaxDraft(prisma, fixture.admin.id, {
    expectedVersion: current.taxSettingsVersion,
    draft,
  });
  return (
    await createTaxPolicyRevision(prisma, fixture.admin.id, {
      expectedDraftVersion: saved.version,
    })
  ).revision;
};
const request = (query = `revisionId=${candidate.id}`, user = fixture.admin) =>
  fetch(
    `${api.apiBaseUrl}/organization/tax-policy-publication-readiness?${query}`,
    {
      headers: user ? headersFor(user) : {},
    },
  );
const read = async (id = candidate.id) => {
  const response = await request(`revisionId=${id}`);
  assert.equal(response.status, 200);
  assert.equal(response.headers.get("cache-control"), "private, no-store");
  return response.json();
};
const state = (report, code) =>
  report.checks.find((check) => check.code === code)?.state;
before(async () => {
  fixture = await createTestFixture();
  organizationFixture = await beginOrganizationFixture();
  await prisma.food.update({
    where: { id: fixture.food.id },
    data: { taxCategory: "FOOD_NON_ALCOHOLIC" },
  });
  candidate = await saveCandidate();
  api = await startApiServer();
});
after(async () => {
  await stopApiServer(api?.server);
  if (organizationFixture)
    await prisma.taxPolicyRevision.deleteMany({
      where: { organizationId: orgId() },
    });
  await cleanupTestFixture(fixture);
  const table = await prisma.restaurantTable.findUnique({
    where: { tableNo: 910001 },
  });
  if (table) {
    await prisma.tableSession.deleteMany({
      where: { restaurantTableId: table.id },
    });
    await prisma.restaurantTable.delete({ where: { id: table.id } });
  }
  await restoreOrganizationFixture(organizationFixture);
  await prisma.$disconnect();
});
test("strict revision query rejects duplicates, extra fields and invalid identifiers", async () => {
  assert.equal(
    validateReadinessQuery({ revisionId: "2147483647" }),
    2147483647,
  );
  for (const query of [
    null,
    {},
    { revisionId: 1 },
    { revisionId: ["1", "2"] },
    { revisionId: "01" },
    { revisionId: "0" },
    { revisionId: "2147483648" },
    { revisionId: "1", active: "true" },
  ])
    assert.throws(
      () => validateReadinessQuery(query),
      (error) => error.status === 400,
    );
  for (const query of [
    "",
    "revisionId=01",
    "revisionId=1&revisionId=2",
    "revisionId=1&publish=true",
    "revisionId[]=1",
    "revisionId=-1",
  ])
    assert.equal((await request(query)).status, 400);
});
test("admin identity is checked against current database state; every response is private", async () => {
  for (const [user, status] of [
    [null, 401],
    [fixture.user, 403],
  ]) {
    const response = await request(undefined, user);
    assert.equal(response.status, status);
    assert.equal(response.headers.get("cache-control"), "private, no-store");
  }
  const signed = headersFor(fixture.admin);
  try {
    await prisma.user.update({
      where: { id: fixture.admin.id },
      data: { level: "kassa" },
    });
    assert.equal(
      (
        await fetch(
          `${api.apiBaseUrl}/organization/tax-policy-publication-readiness?revisionId=${candidate.id}`,
          { headers: signed },
        )
      ).status,
      403,
    );
    await assert.rejects(
      readTaxPublicationReadiness(prisma, fixture.admin.id, {
        revisionId: String(candidate.id),
      }),
      (error) => error.status === 403,
    );
    await prisma.user.update({
      where: { id: fixture.admin.id },
      data: { level: "admin", status: "delete" },
    });
    assert.equal(
      (
        await fetch(
          `${api.apiBaseUrl}/organization/tax-policy-publication-readiness?revisionId=${candidate.id}`,
          { headers: signed },
        )
      ).status,
      401,
    );
  } finally {
    await prisma.user.update({
      where: { id: fixture.admin.id },
      data: { level: "admin", status: "use" },
    });
  }
});
test("a passing technical report never authorizes publication and GET changes no stored data", async () => {
  const snapshot = () =>
    Promise.all([
      prisma.organization.findMany(),
      prisma.taxPolicyRevision.findMany(),
      prisma.food.findMany(),
      prisma.order.findMany(),
      prisma.saleTemp.findMany(),
      prisma.tableSession.findMany(),
      prisma.orderRefund.findMany(),
      prisma.billSale.findMany(),
    ]);
  const before = await snapshot();
  const report = await read();
  assert.equal(report.technicalChecksPassed, true);
  assert.deepEqual(
    [report.canPublish, report.canActivate, report.commercialReady],
    [false, false, false],
  );
  assert.equal(report.checks.length, 18);
  assert.equal(state(report, "PUBLICATION_RUNTIME_NOT_IMPLEMENTED"), "BLOCKED");
  assert.equal(
    report.checks
      .filter((check) => check.scope === "EXTERNAL")
      .every((check) => check.state === "UNVERIFIED"),
    true,
  );
  assert.equal(Number.isFinite(Date.parse(report.observedAt)), true);
  assert.equal(Object.hasOwn(report.revision, "createdByUserId"), false);
  assert.deepEqual(await snapshot(), before);
});
test("candidate lookup is scoped to the singleton restaurant and absent revisions return 404", async () => {
  const response = await request("revisionId=2147483647");
  assert.equal(response.status, 404);
  assert.equal((await response.json()).code, "TAX_POLICY_REVISION_NOT_FOUND");
  const scoped = {
    user: prisma.user,
    $transaction: (callback, options) =>
      prisma.$transaction(
        (tx) =>
          callback({
            ...tx,
            taxPolicyRevision: {
              findFirst: async (query) => {
                assert.deepEqual(query.where, {
                  id: candidate.id,
                  organizationId: orgId(),
                });
                return null;
              },
            },
          }),
        options,
      ),
  };
  await assert.rejects(
    readTaxPublicationReadiness(scoped, fixture.admin.id, {
      revisionId: String(candidate.id),
    }),
    (error) => error.status === 404,
  );
});
test("draft content/version and current merchant changes block an old candidate without rewriting it", async () => {
  const original = await prisma.organization.findUnique({
    where: { id: orgId() },
  });
  const stored = await prisma.taxPolicyRevision.findUnique({
    where: { id: candidate.id },
  });
  try {
    await prisma.organization.update({
      where: { id: orgId() },
      data: {
        name: "Changed merchant",
        taxSettingsDraft: {
          ...original.taxSettingsDraft,
          reviewerName: "Other proposed reviewer",
        },
      },
    });
    let report = await read();
    assert.equal(report.candidateMatchesCurrentDraft, false);
    assert.equal(report.sellerMatchesCurrent, false);
    assert.equal(report.revision.sellerSnapshot.name, original.name);
    assert.equal(report.technicalChecksPassed, false);
    await prisma.organization.update({
      where: { id: orgId() },
      data: {
        name: original.name,
        taxSettingsDraft: original.taxSettingsDraft,
        taxSettingsVersion: original.taxSettingsVersion + 1,
      },
    });
    report = await read();
    assert.equal(report.candidateMatchesCurrentDraft, false);
    assert.equal(report.sellerMatchesCurrent, true);
    await prisma.organization.update({
      where: { id: orgId() },
      data: { taxCode: "" },
    });
    assert.equal(state(await read(), "SELLER_COMPLETE"), "BLOCKED");
    assert.deepEqual(
      await prisma.taxPolicyRevision.findUnique({
        where: { id: candidate.id },
      }),
      stored,
    );
  } finally {
    const { id, ...data } = original;
    await prisma.organization.update({ where: { id }, data });
  }
});
test("catalog counts exclude inactive items and distinguish null, unsupported and no active menu", async () => {
  try {
    await prisma.food.update({
      where: { id: fixture.food.id },
      data: { taxCategory: null },
    });
    let report = await read();
    assert.deepEqual(report.catalog, {
      activeItems: 1,
      unclassifiedItems: 1,
      unsupportedItems: 0,
    });
    assert.equal(state(report, "TAX_CATEGORY_ASSIGNMENT"), "BLOCKED");
    await assert.rejects(
      prisma.food.update({
        where: { id: fixture.food.id },
        data: { taxCategory: "UNKNOWN" },
      }),
    );
    await prisma.food.update({
      where: { id: fixture.food.id },
      data: { status: "delete" },
    });
    report = await read();
    assert.deepEqual(report.catalog, {
      activeItems: 0,
      unclassifiedItems: 0,
      unsupportedItems: 0,
    });
    assert.equal(state(report, "ACTIVE_MENU"), "BLOCKED");
  } finally {
    await prisma.food.update({
      where: { id: fixture.food.id },
      data: { status: "use", taxCategory: "FOOD_NON_ALCOHOLIC" },
    });
  }
});
test("NOT_REGISTERED permits unclassified menu but still rejects unsupported classes", async () => {
  const nonRegistered = await saveCandidate({
    ...configuration(),
    vatStatus: "NOT_REGISTERED",
    rates: { FOOD_NON_ALCOHOLIC: null, ALCOHOL: null },
    nonRegistrationReason: "Synthetic non-registration reason",
  });
  try {
    await prisma.food.update({
      where: { id: fixture.food.id },
      data: { taxCategory: null },
    });
    assert.equal((await read(nonRegistered.id)).technicalChecksPassed, true);
    // EN: The database prevents unsupported classes; inject the count to exercise defensive reporting without relaxing that constraint.
    // FI: Tietokanta estää tukemattomat luokat; syötä laskentatulos puolustavan raportoinnin testaamiseksi rajoitetta poistamatta.
    const unsupported = {
      user: prisma.user,
      $transaction: (callback, options) =>
        prisma.$transaction(
          (tx) =>
            callback({
              ...tx,
              food: {
                count: async (query) =>
                  query.where.taxCategory === null
                    ? 0
                    : typeof query.where.taxCategory === "object"
                      ? 1
                      : tx.food.count(query),
              },
            }),
          options,
        ),
    };
    assert.equal(
      state(
        await readTaxPublicationReadiness(unsupported, fixture.admin.id, {
          revisionId: String(nonRegistered.id),
        }),
        "TAX_CATEGORY_SUPPORTED",
      ),
      "BLOCKED",
    );
  } finally {
    await prisma.food.update({
      where: { id: fixture.food.id },
      data: { taxCategory: "FOOD_NON_ALCOHOLIC" },
    });
    candidate = await saveCandidate();
  }
});
test("nonterminal fulfillment, legacy carts, sessions and recoverable refunds are counted separately", async () => {
  const bill = await prisma.billSale.create({
    data: {
      amount: 2000n,
      payType: "cash",
      userId: fixture.user.id,
      inputMoney: 2000n,
      returnMoney: 0n,
      serviceType: "TAKEAWAY",
    },
  });
  const table = await prisma.restaurantTable.create({
    data: { tableNo: 910001 },
  });
  const open = await prisma.tableSession.create({
    data: { restaurantTableId: table.id },
  });
  const closed = await prisma.tableSession.create({
    data: {
      restaurantTableId: table.id,
      status: "CLOSED",
      closedAt: new Date(),
    },
  });
  const createOrder = (status, billSaleId = null) =>
    prisma.order.create({
      data: {
        channel: "COUNTER",
        serviceType: "TAKEAWAY",
        status,
        createdByUserId: fixture.user.id,
        subtotal: 2000n,
        modifierTotal: 0n,
        total: 2000n,
        idempotencyScope: fixture.marker,
        idempotencyKey: randomUUID(),
        idempotencyFingerprint: "a".repeat(64),
        billSaleId,
      },
    });
  const orders = [];
  try {
    orders.push(
      await createOrder("SUBMITTED"),
      await createOrder("PREPARING", bill.id),
    );
    for (const status of ["COMPLETED", "CANCELLED", "REJECTED"])
      orders.push(
        await createOrder(status, bill.id),
        await createOrder(status),
      );
    const pending = await createOrder("CANCELLED", bill.id),
      failed = await createOrder("CANCELLED", bill.id),
      completed = await createOrder("CANCELLED", bill.id);
    orders.push(pending, failed, completed);
    for (const [order, status] of [
      [pending, "PENDING"],
      [failed, "FAILED"],
      [completed, "COMPLETED"],
    ])
      await prisma.orderRefund.create({
        data: {
          orderId: order.id,
          billSaleId: bill.id,
          idempotencyKey: randomUUID(),
          amount: 2000n,
          method: "cash",
          reason: "Synthetic fixture",
          status,
          ...(status === "COMPLETED" && {
            completedAt: new Date(),
            reference: "Synthetic confirmation",
            confirmedByUserId: fixture.admin.id,
          }),
          reservedByUserId: fixture.admin.id,
        },
      });
    const cart = await prisma.saleTemp.create({
      data: {
        userId: fixture.user.id,
        tableNo: 0,
        foodId: fixture.food.id,
        qty: 3,
      },
    });
    try {
      const report = await read();
      assert.deepEqual(report.outstanding, {
        unpaidOrders: 1,
        paidOpenOrders: 1,
        legacyCartLines: 1,
        openTableSessions: 1,
        pendingRefunds: 1,
        failedRefunds: 1,
      });
      assert.equal(report.technicalChecksPassed, false);
      assert.equal(
        report.checks
          .filter((check) => check.scope === "OPERATIONAL")
          .every((check) => check.state === "BLOCKED"),
        true,
      );
      assert.equal(
        (await prisma.saleTemp.findUnique({ where: { id: cart.id } })).qty,
        3,
      );
      await prisma.orderRefund.update({
        where: { orderId: failed.id },
        data: {
          status: "COMPLETED",
          completedAt: new Date(),
          reference: "Synthetic recovery",
          confirmedByUserId: fixture.admin.id,
        },
      });
      assert.equal((await read()).outstanding.failedRefunds, 0);
    } finally {
      await prisma.saleTemp.delete({ where: { id: cart.id } });
    }
  } finally {
    await prisma.order.deleteMany({
      where: { id: { in: orders.map((order) => order.id) } },
    });
    await prisma.billSale.delete({ where: { id: bill.id } });
    await prisma.tableSession.deleteMany({
      where: { id: { in: [open.id, closed.id] } },
    });
    await prisma.restaurantTable.delete({ where: { id: table.id } });
  }
});
test("malformed stored revision or draft produces a conflict instead of a passing report", async () => {
  const original = await prisma.taxPolicyRevision.findUnique({
    where: { id: candidate.id },
  });
  const organization = await prisma.organization.findUnique({
    where: { id: orgId() },
  });
  try {
    for (const data of [
      {
        configuration: {
          ...configuration(),
          rates: { FOOD_NON_ALCOHOLIC: -1, ALCOHOL: 2550 },
        },
      },
      { sellerSnapshot: { ...original.sellerSnapshot, unexpected: true } },
      { createdByName: "" },
    ]) {
      await prisma.taxPolicyRevision.update({
        where: { id: candidate.id },
        data,
      });
      const response = await request();
      assert.equal(response.status, 409);
      assert.equal((await response.json()).code, "TAX_POLICY_REVISION_INVALID");
      const { id, ...restored } = original;
      await prisma.taxPolicyRevision.update({ where: { id }, data: restored });
    }
    await prisma.organization.update({
      where: { id: orgId() },
      data: {
        taxSettingsDraft: {
          ...organization.taxSettingsDraft,
          schemaVersion: 99,
        },
      },
    });
    const response = await request();
    assert.equal(response.status, 409);
    assert.equal((await response.json()).code, "TAX_POLICY_DRAFT_INVALID");
  } finally {
    const { id, ...data } = original;
    await prisma.taxPolicyRevision.update({ where: { id }, data });
    await prisma.organization.update({
      where: { id: orgId() },
      data: { taxSettingsDraft: organization.taxSettingsDraft },
    });
  }
});
test("a failed count propagates; RepeatableRead sees one snapshot during concurrent writes", async () => {
  const injected = new Error("Synthetic count failure");
  const failing = {
    user: prisma.user,
    $transaction: (callback, options) =>
      prisma.$transaction(
        (tx) =>
          callback({
            ...tx,
            food: {
              ...tx.food,
              count: () => {
                throw injected;
              },
            },
          }),
        options,
      ),
  };
  await assert.rejects(
    readTaxPublicationReadiness(failing, fixture.admin.id, {
      revisionId: String(candidate.id),
    }),
    (error) => error === injected,
  );
  const writer = new PrismaClient();
  let updated = false;
  const interleaved = {
    user: prisma.user,
    $transaction: (callback, options) => {
      assert.equal(options.isolationLevel, "RepeatableRead");
      return prisma.$transaction(
        (tx) =>
          callback({
            ...tx,
            food: {
              ...tx.food,
              count: async (query) => {
                if (!updated) {
                  updated = true;
                  await writer.food.update({
                    where: { id: fixture.food.id },
                    data: { taxCategory: null },
                  });
                }
                return tx.food.count(query);
              },
            },
          }),
        options,
      );
    },
  };
  try {
    const report = await readTaxPublicationReadiness(
      interleaved,
      fixture.admin.id,
      { revisionId: String(candidate.id) },
    );
    assert.equal(report.catalog.unclassifiedItems, 0);
    assert.equal((await read()).catalog.unclassifiedItems, 1);
  } finally {
    await writer.food.update({
      where: { id: fixture.food.id },
      data: { taxCategory: "FOOD_NON_ALCOHOLIC" },
    });
    await writer.$disconnect();
  }
});
test("setup absence and an administrator revoked inside the snapshot fail closed", async () => {
  for (const [overrides, status, code] of [
    [
      { organization: { findFirst: async () => null } },
      409,
      "RESTAURANT_SETUP_REQUIRED",
    ],
    [
      { user: { findUnique: async () => ({ status: "use", level: "kassa" }) } },
      403,
      undefined,
    ],
  ]) {
    const client = {
      user: prisma.user,
      $transaction: (callback, options) =>
        prisma.$transaction((tx) => callback({ ...tx, ...overrides }), options),
    };
    await assert.rejects(
      readTaxPublicationReadiness(client, fixture.admin.id, {
        revisionId: String(candidate.id),
      }),
      (error) => error.status === status && (!code || error.body.code === code),
    );
  }
});
test("syntactically valid but incomplete stored candidates return blocked field checks", async () => {
  const original = await prisma.taxPolicyRevision.findUnique({
    where: { id: candidate.id },
  });
  try {
    for (const configuration of [
      {
        ...original.configuration,
        requestedEffectiveDate: null,
        reviewerName: null,
        rates: { FOOD_NON_ALCOHOLIC: null, ALCOHOL: null },
      },
      {
        ...original.configuration,
        vatStatus: "NOT_REGISTERED",
        nonRegistrationReason: null,
      },
    ]) {
      await prisma.taxPolicyRevision.update({
        where: { id: candidate.id },
        data: { configuration },
      });
      const report = await read();
      assert.equal(state(report, "CANDIDATE_COMPLETE"), "BLOCKED");
      assert.equal(report.technicalChecksPassed, false);
      assert.equal(
        report.checks.some(
          (check) => check.code === "CANDIDATE_FIELD_REQUIRED",
        ),
        true,
      );
      if (configuration.vatStatus === "NOT_REGISTERED")
        assert.equal(
          report.checks.filter(
            (check) => check.code === "CANDIDATE_RATE_MUST_BE_EMPTY",
          ).length,
          2,
        );
    }
  } finally {
    await prisma.taxPolicyRevision.update({
      where: { id: candidate.id },
      data: { configuration: original.configuration },
    });
  }
});
