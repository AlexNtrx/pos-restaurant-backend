const { test } = require("node:test");
const assert = require("node:assert/strict");
const {
  CommercialTaxError,
  ROUNDING_POLICY,
  validateCommercialPolicy,
  validateCommercialTimeline,
  validateTaxPoint,
  validateCommercialContext,
  resolveCommercialTaxContext,
} = require("../lib/commercial-tax-policy");
const {
  finalizeCommercialVat,
  validateCommercialSaleSnapshot,
  refundCommercialVat,
} = require("../lib/commercial-vat");
const policy = (id = 1, changes = {}) => ({
  id,
  effectiveFrom: "2026-01-01T00:00:00.000Z",
  countryCode: "FI",
  pricingMode: "FINAL_PRICE",
  currency: "EUR",
  vatStatus: "REGISTERED",
  rates: { FOOD_NON_ALCOHOLIC: 1350, ALCOHOL: 2550 },
  nonRegistrationReason: null,
  roundingPolicy: ROUNDING_POLICY,
  ...changes,
});
const unregistered = (id = 1, changes = {}) =>
  policy(id, {
    vatStatus: "NOT_REGISTERED",
    rates: { FOOD_NON_ALCOHOLIC: null, ALCOHOL: null },
    nonRegistrationReason: "Synthetic non-registration proposal",
    ...changes,
  });
const event = (
  occurredAt = "2026-06-01T12:00:00.000Z",
  kind = "SUPPLY_COMPLETED",
) => ({ kind, occurredAt });
const context = (
  category = "FOOD_NON_ALCOHOLIC",
  values = [policy()],
  taxPoint = event(),
) => resolveCommercialTaxContext(values, { category, taxPoint });
const unit = (grossCents, ctx = context()) => ({ grossCents, context: ctx });
const clone = (value) => structuredClone(value);
const rejects = (callback, code) =>
  assert.throws(
    callback,
    (error) =>
      error instanceof CommercialTaxError && (!code || error.code === code),
  );
const example = () =>
  finalizeCommercialVat(
    [
      unit(1440n),
      unit(1440n),
      unit(650n, context("ALCOHOL")),
      unit(650n, context("ALCOHOL")),
    ],
    4180n,
  );
const freeze = (value) => {
  if (value && typeof value === "object") {
    Object.values(value).forEach(freeze);
    Object.freeze(value);
  }
  return value;
};
test("explicit policy validation rejects incomplete, unsupported and forged configuration without defaults", () => {
  assert.deepEqual(validateCommercialPolicy(policy()), policy());
  assert.equal(
    validateCommercialPolicy(
      unregistered(1, { nonRegistrationReason: " Reason " }),
    ).nonRegistrationReason,
    "Reason",
  );
  for (const patch of [
    { id: 0 },
    { id: "1" },
    { id: 2147483648 },
    { id: 1.5 },
    { countryCode: "SE" },
    { pricingMode: "NET" },
    { currency: "USD" },
    { vatStatus: "UNCONFIRMED" },
    { vatStatus: "EXEMPT" },
    { roundingPolicy: "AUTO" },
    { active: true },
    { reviewerName: "Approved" },
    { rates: { FOOD_NON_ALCOHOLIC: 1350 } },
    { rates: { FOOD_NON_ALCOHOLIC: 1350, ALCOHOL: 2550, OTHER: 1000 } },
    { nonRegistrationReason: "x".repeat(501) },
  ])
    rejects(
      () => validateCommercialPolicy(policy(1, patch)),
      "INVALID_COMMERCIAL_POLICY",
    );
  for (const rate of [null, 0, -1, 1.5, "1350", NaN, 10001])
    rejects(
      () =>
        validateCommercialPolicy(
          policy(1, { rates: { FOOD_NON_ALCOHOLIC: rate, ALCOHOL: 2550 } }),
        ),
      "INVALID_COMMERCIAL_POLICY",
    );
  for (const reason of [null, "", " ", 123])
    rejects(() =>
      validateCommercialPolicy(
        unregistered(1, { nonRegistrationReason: reason }),
      ),
    );
  rejects(() =>
    validateCommercialPolicy(
      unregistered(1, { rates: { FOOD_NON_ALCOHOLIC: 1350, ALCOHOL: null } }),
    ),
  );
  const { effectiveFrom, ...missing } = policy();
  rejects(() => validateCommercialPolicy(missing));
});
test("timestamps require real calendars and explicit offsets, with deterministic UTC normalization", () => {
  assert.equal(
    validateTaxPoint(event("2028-02-29T12:30:00+02:00")).occurredAt,
    "2028-02-29T10:30:00.000Z",
  );
  for (const timestamp of [
    null,
    new Date("2026-01-01Z"),
    "2026-01-01",
    "2026-01-01T00:00:00",
    "2026-02-29T00:00:00Z",
    "2026-04-31T00:00:00Z",
    "0000-01-01T00:00:00Z",
    "2026-01-01T24:00:00Z",
    "2026-01-01T12:00:60Z",
    "2026-01-01T00:00:00.1Z",
    "2026-01-01T00:00:00+99:00",
    "2026-01-01T00:00:00+02:99",
    "2026-01-01T00:00:00-00:00",
    " 2026-01-01T00:00:00Z",
    "2026-01-01t00:00:00z",
  ])
    rejects(
      () => validateTaxPoint(event(timestamp)),
      "INVALID_COMMERCIAL_TAX_POINT",
    );
  assert.equal(
    validateTaxPoint(event("2026-01-01T00:00:00+00:00")).occurredAt,
    "2026-01-01T00:00:00.000Z",
  );
});
test("timeline rejects duplicate references, duplicate instants, wrong order, empty and sparse input", () => {
  for (const timeline of [
    [],
    null,
    [policy(), policy()],
    [policy(), policy(2, { effectiveFrom: "2026-01-01T02:00:00+02:00" })],
    [policy(2, { effectiveFrom: "2027-01-01T00:00:00Z" }), policy()],
    Array(1),
    Array(1001).fill(policy()),
  ])
    rejects(() => validateCommercialTimeline(timeline));
  const input = freeze([
    policy(),
    policy(2, {
      effectiveFrom: "2026-07-01T00:00:00+03:00",
      rates: { FOOD_NON_ALCOHOLIC: 1400, ALCOHOL: 2600 },
    }),
  ]);
  const output = validateCommercialTimeline(input);
  assert.equal(output[1].effectiveFrom, "2026-06-30T21:00:00.000Z");
  assert.notEqual(output[0].rates, input[0].rates);
});
test("before/at/after tax event boundaries select the explicit revision for either event kind", () => {
  const timeline = [
    policy(),
    policy(2, {
      effectiveFrom: "2026-07-01T00:00:00+03:00",
      rates: { FOOD_NON_ALCOHOLIC: 1400, ALCOHOL: 2600 },
    }),
  ];
  for (const kind of ["SUPPLY_COMPLETED", "RECEIVED_FULL_ADVANCE"]) {
    assert.equal(
      context(
        "FOOD_NON_ALCOHOLIC",
        timeline,
        event("2026-06-30T20:59:59.999Z", kind),
      ).policyRevisionId,
      1,
    );
    for (const at of [
      "2026-06-30T21:00:00.000Z",
      "2026-07-01T00:00:00+03:00",
      "2026-06-30T21:00:00.001Z",
    ]) {
      const selected = context("FOOD_NON_ALCOHOLIC", timeline, event(at, kind));
      assert.equal(selected.policyRevisionId, 2);
      assert.equal(selected.rateBps, 1400);
      assert.equal(selected.taxPoint.kind, kind);
    }
  }
  rejects(
    () =>
      context(
        "FOOD_NON_ALCOHOLIC",
        timeline,
        event("2025-12-31T23:59:59.999Z"),
      ),
    "COMMERCIAL_POLICY_NOT_FOUND",
  );
  assert.equal(
    context(
      "FOOD_NON_ALCOHOLIC",
      [policy(1, { effectiveFrom: "2026-01-01T00:00:00+02:00" })],
      event("2025-12-31T22:00:00Z"),
    ).policyRevisionId,
    1,
  );
});
test("DST repeated-hour instants stay distinct and no channel, quote or partial advance chooses the tax event", () => {
  const timeline = [
    policy(),
    policy(2, { effectiveFrom: "2026-10-25T01:00:00Z" }),
  ];
  assert.equal(
    context("ALCOHOL", timeline, event("2026-10-25T03:30:00+03:00"))
      .policyRevisionId,
    1,
  );
  assert.equal(
    context("ALCOHOL", timeline, event("2026-10-25T03:30:00+02:00"))
      .policyRevisionId,
    2,
  );
  for (const kind of [
    "SUBMITTED",
    "READY",
    "PAID",
    "BANK_AUTHORIZED",
    "RECEIVED_PARTIAL_ADVANCE",
    undefined,
  ])
    rejects(() => validateTaxPoint({ kind, occurredAt: event().occurredAt }));
  rejects(() => validateTaxPoint({ ...event(), amountCents: "10" }));
  rejects(() =>
    resolveCommercialTaxContext(timeline, {
      category: "ALCOHOL",
      channel: "COUNTER",
    }),
  );
  for (const category of ["OTHER", {}, 1]) rejects(() => context(category));
  rejects(() => context(null));
});
test("commercial contexts reject unknown/demo, zero rates, invalid refs and events before policy", () => {
  assert.deepEqual(validateCommercialContext(context()), context());
  for (const change of [
    { mode: "DEMO" },
    { schemaVersion: 2 },
    { profile: "FI_RESTAURANT_DEMO_V1" },
    { policyRevisionId: -1 },
    { rateBps: 0 },
    { rateBps: null },
    { category: "UNMAPPED" },
    { vatStatus: "UNCONFIRMED" },
    { effectiveFrom: "2027-01-01T00:00:00Z" },
    { taxPoint: null },
  ])
    rejects(() => validateCommercialContext({ ...context(), ...change }));
});
test("mixed category final bill preserves exact established half-up allocation and authoritative gross", () => {
  const snapshot = example();
  assert.deepEqual(
    [snapshot.grossCents, snapshot.netCents, snapshot.taxCents],
    ["4180", "3573", "607"],
  );
  assert.deepEqual(
    snapshot.groups.map((group) => [
      group.category,
      group.netCents,
      group.taxCents,
      group.grossCents,
    ]),
    [
      ["FOOD_NON_ALCOHOLIC", "2537", "343", "2880"],
      ["ALCOHOL", "1036", "264", "1300"],
    ],
  );
  assert.deepEqual(
    snapshot.lines.map((line) => line.taxCents),
    ["172", "171", "132", "132"],
  );
  assert.deepEqual(snapshot.policyRevisionIds, [1]);
  assert.equal(snapshot.mode, "COMMERCIAL");
});
test("compatible revisions retain each reference/event and group shared rates across revisions once", () => {
  const timeline = [
    policy(),
    policy(2, { effectiveFrom: "2026-07-01T00:00:00Z" }),
  ];
  const before = context(
    "FOOD_NON_ALCOHOLIC",
    timeline,
    event("2026-06-30T12:00:00Z", "RECEIVED_FULL_ADVANCE"),
  );
  const after = context(
    "FOOD_NON_ALCOHOLIC",
    timeline,
    event("2026-07-01T12:00:00Z"),
  );
  const shared = finalizeCommercialVat(
    [unit(10n, before), unit(10n, after), unit(10n, after)],
    30n,
  );
  assert.equal(shared.taxCents, "4");
  assert.equal(shared.groups.length, 1);
  assert.deepEqual(
    shared.lines.map((line) => line.taxCents),
    ["2", "1", "1"],
  );
  assert.deepEqual(shared.policyRevisionIds, [1, 2]);
  assert.equal(shared.lines[0].context.taxPoint.kind, "RECEIVED_FULL_ADVANCE");
  const refund = refundCommercialVat(shared);
  assert.deepEqual(refund.policyRevisionIds, [1, 2]);
  assert.equal(refund.taxCents, "-4");
  assert.deepEqual(
    refund.lines.map((line) => line.context),
    shared.lines.map((line) => line.context),
  );
  const different = context("FOOD_NON_ALCOHOLIC", [
    policy(2, { rates: { FOOD_NON_ALCOHOLIC: 2550, ALCOHOL: 2550 } }),
  ]);
  const mixed = finalizeCommercialVat(
    [unit(100n, before), unit(100n, different)],
    200n,
  );
  assert.equal(mixed.taxCents, "32");
  assert.equal(mixed.groups.length, 2);
});
test("range of supported amounts reconciles every line/group and stable rounding includes half-cent ties", () => {
  for (const rate of [1, 1350, 2550, 10000])
    for (const gross of [0n, 1n, 5n, 10n, 1290n, 999999999n, 1000000000000n])
      for (const qty of [1, 3, 200]) {
        const ctx = context("FOOD_NON_ALCOHOLIC", [
          policy(1, { rates: { FOOD_NON_ALCOHOLIC: rate, ALCOHOL: 2550 } }),
        ]);
        const snapshot = finalizeCommercialVat(
          Array.from({ length: qty }, () => unit(gross, ctx)),
          gross * BigInt(qty),
        );
        assert.equal(
          BigInt(snapshot.netCents) + BigInt(snapshot.taxCents),
          BigInt(snapshot.grossCents),
        );
        assert.equal(
          snapshot.lines.reduce((sum, line) => sum + BigInt(line.taxCents), 0n),
          BigInt(snapshot.taxCents),
        );
        for (const line of snapshot.lines)
          assert.equal(BigInt(line.netCents) + BigInt(line.taxCents), gross);
        assert.deepEqual(
          snapshot,
          finalizeCommercialVat(
            Array.from({ length: qty }, () => unit(gross, ctx)),
            gross * BigInt(qty),
          ),
        );
      }
  const ctx = context("ALCOHOL", [
    policy(1, { rates: { FOOD_NON_ALCOHOLIC: 1, ALCOHOL: 10000 } }),
  ]);
  assert.equal(finalizeCommercialVat([unit(1n, ctx)], 1n).taxCents, "1");
});
test("NOT_REGISTERED keeps known treatment/reason with absent VAT, not a zero rate or unknown", () => {
  const ctx = context(null, [unregistered()]);
  const snapshot = finalizeCommercialVat(
    [unit(123n, ctx), unit(0n, ctx)],
    123n,
  );
  assert.equal(snapshot.vatStatus, "NOT_REGISTERED");
  assert.equal(snapshot.grossCents, "123");
  assert.equal(snapshot.taxCents, null);
  assert.equal(snapshot.netCents, null);
  assert.deepEqual(snapshot.groups, []);
  assert.equal(snapshot.lines[0].context.rateBps, null);
  assert.equal(snapshot.lines[0].taxCents, null);
  assert.equal(
    snapshot.lines[0].context.nonRegistrationReason,
    "Synthetic non-registration proposal",
  );
  rejects(() => validateCommercialContext({ ...ctx, rateBps: 0 }));
  rejects(() =>
    validateCommercialContext({ ...ctx, nonRegistrationReason: null }),
  );
});
test("prices/total/extra scope and arithmetic overflow fail rather than silently changing money", () => {
  for (const bad of [[], null, Array(1), Array(10001).fill(unit(1n))])
    rejects(() => finalizeCommercialVat(bad, 0n));
  for (const bad of [1, "1", -1n, 9223372036854775807n, 9007199254740991n])
    rejects(() => finalizeCommercialVat([unit(bad)], bad));
  rejects(
    () => finalizeCommercialVat([unit(1n)], 2n),
    "INVALID_COMMERCIAL_AMOUNT",
  );
  rejects(() =>
    finalizeCommercialVat(
      [unit(9000000000000000n), unit(9000000000000000n)],
      18000000000000000n,
    ),
  );
  for (const scope of [
    { quantity: 2 },
    { discountCents: 1n },
    { tipCents: 1n },
    { split: true },
  ])
    rejects(() => finalizeCommercialVat([{ ...unit(1n), ...scope }], 1n));
});
test("mixed unknown/demo/treatments and inconsistent references never produce partial commercial VAT", () => {
  for (const ctx of [
    null,
    {},
    { profile: "FI_RESTAURANT_DEMO_V1", category: "ALCOHOL", rateBps: 2550 },
  ])
    rejects(() => finalizeCommercialVat([unit(1n), unit(1n, ctx)], 2n));
  rejects(
    () =>
      finalizeCommercialVat(
        [unit(1n), unit(1n, context(null, [unregistered(2)]))],
        2n,
      ),
    "MIXED_COMMERCIAL_TREATMENT",
  );
  rejects(
    () =>
      finalizeCommercialVat(
        [unit(1n), unit(1n, { ...context(), rateBps: 2550 })],
        2n,
      ),
    "COMMERCIAL_POLICY_REFERENCE_MISMATCH",
  );
  rejects(
    () =>
      finalizeCommercialVat(
        [
          unit(1n),
          unit(1n, { ...context(), effectiveFrom: "2026-02-01T00:00:00.000Z" }),
        ],
        2n,
      ),
    "COMMERCIAL_POLICY_REFERENCE_MISMATCH",
  );
});
test("frozen inputs remain unchanged and later policy edits cannot alter captured contexts or snapshots", () => {
  const policies = [policy()];
  const captured = context("FOOD_NON_ALCOHOLIC", policies);
  const input = freeze([unit(10n, captured), unit(10n, captured)]);
  const original = clone(input);
  const snapshot = finalizeCommercialVat(input, 20n);
  const originalSnapshot = clone(snapshot);
  assert.deepEqual(input, original);
  policies[0].rates.FOOD_NON_ALCOHOLIC = 9900;
  assert.equal(context("FOOD_NON_ALCOHOLIC", policies).rateBps, 9900);
  assert.equal(captured.rateBps, 1350);
  assert.deepEqual(snapshot, originalSnapshot);
  assert.equal(refundCommercialVat(snapshot).lines[0].context.rateBps, 1350);
  assert.notEqual(snapshot.lines[0].context.taxPoint, captured.taxPoint);
});
test("full registered refund negates only original frozen amounts and retains provenance deterministically", () => {
  const original = freeze(example());
  const refund = refundCommercialVat(original);
  assert.deepEqual(
    [refund.grossCents, refund.netCents, refund.taxCents],
    ["-4180", "-3573", "-607"],
  );
  assert.equal(refund.kind, "FULL_REFUND");
  assert.deepEqual(refund.policyRevisionIds, original.policyRevisionIds);
  refund.lines.forEach((line, i) => {
    assert.deepEqual(line.context, original.lines[i].context);
    assert.equal(BigInt(line.taxCents), -BigInt(original.lines[i].taxCents));
  });
  assert.deepEqual(refundCommercialVat(original), refund);
  assert.deepEqual(validateCommercialSaleSnapshot(original), original);
  rejects(() => refundCommercialVat(refund), "INVALID_COMMERCIAL_SNAPSHOT");
});
test("full NOT_REGISTERED refund preserves null tax/net and original reason, including zero amounts", () => {
  const original = finalizeCommercialVat(
    [
      unit(123n, context(null, [unregistered()])),
      unit(0n, context(null, [unregistered()])),
    ],
    123n,
  );
  const refund = refundCommercialVat(original);
  assert.equal(refund.grossCents, "-123");
  assert.equal(refund.netCents, null);
  assert.equal(refund.taxCents, null);
  assert.deepEqual(refund.groups, []);
  assert.equal(refund.lines[1].grossCents, "0");
  assert.equal(
    refund.lines[0].context.nonRegistrationReason,
    original.lines[0].context.nonRegistrationReason,
  );
  assert.deepEqual(refundCommercialVat(original), refund);
});
test("refund validation rejects inconsistent totals/groups/lines/references and noncanonical stored amounts", () => {
  const original = example();
  for (const mutate of [
    (s) => {
      s.taxCents = "0";
    },
    (s) => {
      s.grossCents = "4181";
    },
    (s) => {
      s.netCents = null;
    },
    (s) => {
      s.groups[0].taxCents = "0";
    },
    (s) => {
      s.lines[0].taxCents = "0";
    },
    (s) => {
      s.lines[0].grossCents = "01440";
    },
    (s) => {
      s.lines[0].grossCents = 1440;
    },
    (s) => {
      s.lines[0].grossCents = "1e3";
    },
    (s) => {
      s.policyRevisionIds = [999];
    },
    (s) => {
      s.lines[0].context.policyRevisionId = 999;
    },
    (s) => {
      s.mode = "DEMO";
    },
    (s) => {
      s.active = true;
    },
    (s) => {
      s.lines = Array(1);
    },
  ]) {
    const damaged = clone(original);
    mutate(damaged);
    rejects(() => refundCommercialVat(damaged), "INVALID_COMMERCIAL_SNAPSHOT");
  }
  const non = finalizeCommercialVat(
    [unit(1n, context(null, [unregistered()]))],
    1n,
  );
  rejects(
    () => refundCommercialVat({ ...non, taxCents: "0" }),
    "INVALID_COMMERCIAL_SNAPSHOT",
  );
  assert.deepEqual(original, example());
});
