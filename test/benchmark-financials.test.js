const { test } = require("node:test");
const assert = require("node:assert/strict");
const {
  restaurantMonth,
  expectedReportCents,
} = require("./benchmark-financials");

const bill = (id, iso, amount, status = "use") => ({
  id,
  payDate: new Date(iso),
  amount,
  status,
});

test("benchmark calendar uses Helsinki at year rollover and DST month boundaries", () => {
  assert.deepEqual(restaurantMonth(new Date("2026-12-31T22:30:00Z")), {
    year: 2027,
    month: 1,
  });
  const bills = [
    bill(1, "2026-03-31T20:59:59Z", 1234n),
    bill(2, "2026-03-31T21:00:00Z", 5678n),
    bill(3, "2026-10-31T21:59:59Z", 10n),
    bill(4, "2026-10-31T22:00:00Z", 20n),
  ];
  assert.equal(expectedReportCents(bills, [], 2026, 3), 1234n);
  assert.equal(expectedReportCents(bills, [], 2026, 4), 5678n);
  assert.equal(expectedReportCents(bills, [], 2026, 10), 10n);
  assert.equal(expectedReportCents(bills, [], 2026, 11), 20n);
});

test("exact cents and completed refunds stay in original sale month without counting cancelled bills", () => {
  const bills = [
    bill(1, "2026-09-30T21:30:00Z", 10n),
    bill(2, "2026-10-01T09:00:00Z", 20n),
    bill(3, "2026-10-01T09:00:00Z", 10000n, "cancelled"),
  ];
  const refunds = [
    {
      billSaleId: 1,
      amount: 10n,
      status: "COMPLETED",
      completedAt: new Date("2026-11-01T12:00:00Z"),
    },
    { billSaleId: 2, amount: 20n, status: "PENDING" },
    { billSaleId: 2, amount: 20n, status: "FAILED" },
  ];
  assert.equal(expectedReportCents(bills, refunds, 2026, 10), 20n);
  assert.equal(expectedReportCents(bills, refunds, 2026, 11), 0n);
  assert.equal(expectedReportCents(bills, refunds, 2026, 9), 0n);
});
