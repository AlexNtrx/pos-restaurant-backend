const { test } = require("node:test");
const assert = require("node:assert/strict");
const { createHash } = require("node:crypto");
const {
  eurosToCents,
  centsToEuros,
  addCents,
  multiplyCents,
  MAX_CENTS,
} = require("../lib/money");
const { checkoutFingerprint } = require("../lib/legacy-checkout-state");
const { moneyDto } = require("../lib/money-dto");
const { assertMoneyStorage } = require("../lib/money-storage");

test("decimal EUR parses exactly and rejects lossy, invalid and extra precision values", () => {
  for (const [eur, cents] of [
    [0.1, 10n],
    [12.9, 1290n],
    ["0.50", 50n],
    [20, 2000n],
  ]) {
    assert.equal(eurosToCents(eur), cents);
    assert.equal(eurosToCents(centsToEuros(cents)), cents);
  }
  for (const value of [
    null,
    undefined,
    true,
    "",
    "12,90",
    0.001,
    0.1 + 0.2,
    -1,
    Infinity,
    "1e3",
  ])
    assert.equal(eurosToCents(value), null);
});
test("quantity, modifiers and cash change stay exact", () => {
  assert.equal(multiplyCents(eurosToCents(0.1), 3), 30n);
  const total = multiplyCents(
    addCents(eurosToCents(12.9), eurosToCents(0.5)),
    3,
  );
  assert.equal(total, 4020n);
  assert.equal(centsToEuros(eurosToCents(50) - total), 9.8);
});
test("signed totals, legacy INTEGER capacity and overflow are explicit", () => {
  assert.equal(centsToEuros(-1290n), -12.9);
  assert.equal(centsToEuros(214748364700n), 2147483647);
  assert.throws(() => centsToEuros(MAX_CENTS + 1n), RangeError);
  assert.throws(() => centsToEuros(9007199254740993n), RangeError);
  assert.throws(() => multiplyCents(100n, Number.MAX_SAFE_INTEGER), RangeError);
});
test("legacy checkout fingerprints keep the original EUR body and key semantics", () => {
  const body = { tableNo: 1, payType: "cash", inputMoney: 20 };
  const previous = createHash("sha256")
    .update(JSON.stringify(body))
    .digest("hex");
  assert.equal(checkoutFingerprint(body), previous);
  assert.equal(eurosToCents(body.inputMoney), 2000n);
  assert.equal(checkoutFingerprint(body), previous);
});

test("money DTO converts explicit fields without scaling IDs, counts, dates or versions", () => {
  const date = new Date();
  const result = moneyDto({
    id: 1290,
    version: 50,
    quantity: 3,
    unpaidCancelledCount: 5,
    total: 4020n,
    receipt: { inputMoney: 5000n, returnMoney: 980n, createdDate: date },
    Items: [{ unitBasePrice: 1290n, Modifiers: [{ priceAdjustment: 50n }] }],
    amount: -10n,
  });
  assert.equal(result.id, 1290);
  assert.equal(result.version, 50);
  assert.equal(result.quantity, 3);
  assert.equal(result.unpaidCancelledCount, 5);
  assert.equal(result.total, 40.2);
  assert.equal(result.receipt.returnMoney, 9.8);
  assert.equal(result.receipt.createdDate, date);
  assert.equal(result.Items[0].Modifiers[0].priceAdjustment, 0.5);
  assert.equal(result.amount, -0.1);
  assert.equal(moneyDto({ id: 12n }).id, 12n);
  assert.throws(() => moneyDto({ total: 9007199254740993n }), RangeError);
});

test("storage guard rejects legacy or unknown units before serving money routes", async () => {
  for (const rows of [
    [],
    [{ unit: "EUR", version: 1 }],
    [{ unit: "EUR_CENTS", version: 2 }],
  ])
    await assert.rejects(
      assertMoneyStorage({ $queryRawUnsafe: async () => rows }),
    );
  await assertMoneyStorage({
    $queryRawUnsafe: async () => [{ unit: "EUR_CENTS", version: 1 }],
  });
});
