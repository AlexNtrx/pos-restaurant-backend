const { ReceiptReadError } = require("./receipt-read-error");
const prisma = require("./prisma");
const { isReceiptIdentity } = require("./receipt-identity");
const {
  positiveInteger,
  loadCheckoutSnapshot,
} = require("./legacy-checkout-state");
async function printBillAfterPay(context) {
  // EN: Receipt copies are shared by active cashiers in this single restaurant; re-read the role instead of trusting ownership or JWT claims.
  // FI: Aktiiviset kassatyöntekijät jakavat kuittikopiot tässä yhdessä ravintolassa; tarkista rooli uudelleen omistajan tai JWT-väitteiden sijaan.
  const reader = await prisma.user.findUnique({
    where: { id: context.user.id },
    select: { status: true, level: true },
  });
  if (
    !reader ||
    reader.status !== "use" ||
    !["admin", "kassa"].includes(reader.level)
  )
    throw new ReceiptReadError(403, { error: "Active cashier is required" });
  const billId = positiveInteger(context.body.billId);
  if (!billId)
    throw new ReceiptReadError(400, {
      error: "billId must be a positive integer",
    });

  const billSale = await prisma.billSale.findFirst({
    where: {
      id: billId,
    },
    include: {
      BillSaleDetails: { orderBy: { id: "asc" } },
      Orders: { select: { id: true }, orderBy: { id: "asc" }, take: 1 },
      User: { select: { name: true } },
    },
  });
  if (!billSale) throw new ReceiptReadError(404, { error: "Bill not found" });

  const identity = billSale.receiptSnapshot;
  // EN: A malformed stored snapshot must not silently fall back to current seller data.
  // FI: Virheellinen tallennettu tilannekuva ei saa vaihtua huomaamatta nykyisiin myyjätietoihin.
  if (identity != null && !isReceiptIdentity(identity))
    throw new ReceiptReadError(409, {
      error: "Receipt identity snapshot is invalid",
    });
  const currentOrganization = await prisma.organization.findFirst({
    orderBy: { id: "asc" },
  });
  const organization = identity
    ? { ...identity.organization, logo: currentOrganization?.logo ?? "" }
    : currentOrganization;
  if (!organization)
    throw new ReceiptReadError(409, {
      error: "Organization is not configured",
    });

  return {
    organization: organization,
    receipt: {
      title: "Kuitti",
      // EN: Legacy identity uses current data with an explicit notice; never persist it as historical evidence.
      // FI: Vanhojen kuittien identiteetti käyttää nykyisiä tietoja erillisellä huomautuksella; älä tallenna niitä historialliseksi todisteeksi.
      identitySource: identity ? "SNAPSHOT" : "CURRENT_LEGACY",
      cashierName: identity ? identity.cashierName : billSale.User.name,
      billId: billSale.id,
      tableNo: billSale.tableNo,
      serviceType: billSale.serviceType,
      pickupNo:
        billSale.serviceType === "TAKEAWAY"
          ? (billSale.Orders[0]?.id ?? null)
          : null,
      date: billSale.payDate,
      lines: billSale.BillSaleDetails,
      amount: billSale.amount,
      inputMoney: billSale.inputMoney,
      returnMoney: billSale.returnMoney,
      payType: billSale.payType,
      vatSnapshot: billSale.vatSnapshot,
    },
    filename: `bill-${billSale.id}.pdf`,
  };
}
async function printBillBeforePay(context) {
  const tableNo = positiveInteger(context.body.tableNo);
  if (!tableNo)
    throw new ReceiptReadError(400, {
      error: "tableNo must be a positive integer",
    });

  const organization = await prisma.organization.findFirst();
  if (!organization)
    throw new ReceiptReadError(409, {
      error: "Organization is not configured",
    });
  const snapshot = await loadCheckoutSnapshot(prisma, context.user.id, tableNo);

  return {
    organization: organization,
    receipt: {
      title: "Esilasku",
      cashierName: context.user.name,
      tableNo,
      date: new Date(),
      lines: snapshot.lines,
      amount: snapshot.amount,
      inputMoney: null,
      returnMoney: null,
      payType: null,
    },
    filename: `bill-preview-table-${tableNo}.pdf`,
  };
}
module.exports = { printBillAfterPay, printBillBeforePay };
