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
    /Invalid time value/,
  );
});

test("long receipt snapshots fit on one narrow page without changing stored values", async () => {
  const line = Object.freeze({
    foodName:
      "Pitkään haudutettu suomalainen naudanlihapata perunoiden ja kauden kasvisten kera",
    foodSizeName: "Suuri annos kahdelle hengelle",
    tasteName: "Gluteeniton, ilman sipulia, kastike erillisessä astiassa",
    price: 20,
    moneyAdded: 3,
  });
  const lines = Object.freeze(
    Array.from({ length: 30 }, (_, index) =>
      Object.freeze({ ...line, foodId: index % 15 }),
    ),
  );
  for (const payType of ["cash", "bank"]) {
    const snapshot = Object.freeze({
      ...receipt,
      lines,
      payType,
      amount: 690,
      inputMoney: 700,
      returnMoney: 10,
    });
    const before = JSON.stringify(snapshot);
    const pdf = await renderReceiptPdf(organization, snapshot);
    const source = pdf.toString("latin1");
    assert.equal((source.match(/\/Type \/Page\b/g) ?? []).length, 1);
    assert.match(source, /\/MediaBox \[0 0 226\.77 /);
    assert.equal(JSON.stringify(snapshot), before);
  }
});
