const { test } = require("node:test");
const assert = require("node:assert/strict");
const { renderReceiptPdf } = require("../lib/receipt-pdf");

const organization = {
  name: "Test Organization",
  address: "Test address",
  phone: "123",
  taxCode: "TEST",
};

const receipt = {
  title: "Bill",
  billId: 1,
  tableNo: 1,
  date: new Date("2026-01-01T00:00:00.000Z"),
  lines: [
    {
      foodName: "Test food",
      foodSizeName: null,
      tasteName: null,
      price: 20,
      moneyAdded: 0,
    },
  ],
  amount: 20,
  inputMoney: 20,
  returnMoney: 0,
  payType: "cash",
};

test("receipt renderer creates PDFs when the logo is missing or an unsafe path", async () => {
  for (const logo of ["missing-logo.png", "../outside-logo.png"]) {
    const pdf = await renderReceiptPdf({ ...organization, logo }, receipt);
    assert.equal(pdf.subarray(0, 4).toString(), "%PDF");
    assert.ok(pdf.length > 500);
  }
});

test("receipt renderer propagates rendering failures", async () => {
  await assert.rejects(
    renderReceiptPdf({ ...organization, logo: "" }, { ...receipt, date: {} }),
    /toISOString/,
  );
});
