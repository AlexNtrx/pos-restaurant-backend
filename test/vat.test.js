const { test } = require("node:test");
const assert = require("node:assert/strict");
const { finalizeBillVat, refundVat } = require("../lib/vat");
const { captureVat } = require("../lib/vat-policy");
const { normalizeOrderIntent } = require("../lib/order-pricing");
const { validateFood } = require("../lib/food-validation");

const context = (category = "FOOD_NON_ALCOHOLIC", rateBps = 1350) => ({
  profile: "FI_RESTAURANT_DEMO_V1",
  policy: "GROSS_GROUP_HALF_UP_V1",
  category,
  rateBps,
});
const line = (gross, vatSnapshot = context()) => ({
  price: gross,
  moneyAdded: 0n,
  vatSnapshot,
});

test("mixed bill retains gross and allocates final rounded tax to every unit", () => {
  const result = finalizeBillVat(
    [
      line(1440n),
      line(1440n),
      line(650n, context("ALCOHOL", 2550)),
      line(650n, context("ALCOHOL", 2550)),
    ],
    4180n,
  );
  assert.deepEqual(
    result.vatData.vatSnapshot.groups.map(
      ({ netCents, taxCents, grossCents }) => [netCents, taxCents, grossCents],
    ),
    [
      ["2537", "343", "2880"],
      ["1036", "264", "1300"],
    ],
  );
  assert.equal(result.vatData.vatSnapshot.netCents, "3573");
  assert.equal(result.vatData.vatSnapshot.taxCents, "607");
  assert.deepEqual(
    result.lines.map((unit) => unit.vatSnapshot.taxCents),
    ["172", "171", "132", "132"],
  );
});

test("final bill groups across Orders and has deterministic rounding for low prices", () => {
  const lines = [line(10n), line(10n), line(10n)];
  const result = finalizeBillVat(lines, 30n);
  assert.equal(result.vatData.vatSnapshot.taxCents, "4");
  assert.deepEqual(
    result.lines.map((unit) => unit.vatSnapshot.taxCents),
    ["2", "1", "1"],
  );
  assert.equal(
    finalizeBillVat([lines[0]], 10n).vatData.vatSnapshot.taxCents,
    "1",
  );
  assert.equal(lines[0].vatSnapshot.taxCents, undefined);
});

test("allocation reconciles for a range of prices and quantities, including zero and large cents", () => {
  for (const rateBps of [1350, 2550])
    for (const price of [0n, 1n, 5n, 10n, 1290n, 999999999n])
      for (const qty of [1, 3, 200]) {
        const result = finalizeBillVat(
          Array.from({ length: qty }, () =>
            line(
              price,
              context(
                rateBps === 1350 ? "FOOD_NON_ALCOHOLIC" : "ALCOHOL",
                rateBps,
              ),
            ),
          ),
          price * BigInt(qty),
        );
        const snapshot = result.vatData.vatSnapshot;
        assert.equal(
          result.lines.reduce(
            (sum, unit) => sum + BigInt(unit.vatSnapshot.taxCents),
            0n,
          ),
          BigInt(snapshot.taxCents),
        );
        for (const unit of result.lines)
          assert.equal(
            BigInt(unit.vatSnapshot.netCents) +
              BigInt(unit.vatSnapshot.taxCents),
            price,
          );
      }
});

test("unknown or mixed legacy tax is never represented as zero or a partial summary", () => {
  for (const lines of [
    [line(10n, null)],
    [line(10n), line(10n, null)],
    [line(10n, { ...context(), rateBps: NaN })],
  ]) {
    assert.deepEqual(
      finalizeBillVat(lines, 10n * BigInt(lines.length)).vatData,
      {},
    );
  }
  assert.throws(() => finalizeBillVat([line(10n)], 11n), /differ/);
});

test("full refund negates original snapshots and captured rates survive runtime changes", () => {
  const original = finalizeBillVat([line(1440n)], 1440n).vatData.vatSnapshot;
  const refund = refundVat(original).vatSnapshot;
  assert.equal(refund.grossCents, "-1440");
  assert.equal(refund.netCents, "-1269");
  assert.equal(refund.taxCents, "-171");
  assert.equal(refund.groups[0].taxCents, "-171");
  assert.equal(original.taxCents, "171");
  assert.deepEqual(refundVat(null), {});
  assert.equal(
    finalizeBillVat([line(1440n, context("FOOD_NON_ALCOHOLIC", 1400))], 1440n)
      .vatData.vatSnapshot.groups[0].rateBps,
    1400,
  );
});

test("demo is opt-in, missing category is blocked, and catalog omission remains compatible", () => {
  const prior = process.env.VAT_DEMO_ENABLED;
  try {
    delete process.env.VAT_DEMO_ENABLED;
    assert.equal(captureVat(null), undefined);
    process.env.VAT_DEMO_ENABLED = "true";
    assert.throws(
      () => captureVat(null),
      (error) => error.code === "VAT_CATEGORY_REQUIRED",
    );
    assert.equal(captureVat("ALCOHOL").rateBps, 2550);
  } finally {
    if (prior === undefined) delete process.env.VAT_DEMO_ENABLED;
    else process.env.VAT_DEMO_ENABLED = prior;
  }
  const food = { foodTypeId: 1, name: "Food", price: 12.9, foodType: "food" };
  assert.equal(validateFood(food).taxCategory, undefined);
  assert.equal(validateFood({ ...food, taxCategory: null }).taxCategory, null);
  assert.ok(validateFood({ ...food, taxCategory: "zero" }).error);
});

test("order intents reject client supplied VAT authority", () => {
  for (const field of [
    "vatSnapshot",
    "taxCategory",
    "rateBps",
    "taxCents",
    "netCents",
    "grossCents",
  ]) {
    assert.throws(
      () =>
        normalizeOrderIntent({
          channel: "COUNTER",
          tableNo: 1,
          items: [{ foodId: 1, quantity: 1, [field]: 0 }],
        }),
      (error) => error.code === "CLIENT_FINANCIAL_AUTHORITY_REJECTED",
    );
  }
});
