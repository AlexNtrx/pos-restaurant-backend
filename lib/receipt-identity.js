const { validateOrganization } = require("./organization-validation");
const { OrderDomainError } = require("./order-domain");

// EN: Capture receipt text inside the payment transaction, after committed replay checks; logos remain presentation assets.
// FI: Tallenna kuitin tekstit maksutransaktiossa vahvistettujen uusintojen tarkistuksen jälkeen; logot jäävät esitysaineistoksi.
const captureReceiptIdentity = async (tx, userId) => {
  const organization = await tx.organization.findFirst({
    orderBy: { id: "asc" },
  });
  const seller =
    organization && validateOrganization({ ...organization, logo: "" });
  if (!seller || seller.error)
    throw new OrderDomainError(
      409,
      "RECEIPT_SETUP_REQUIRED",
      "Receipt setup is incomplete; ask an administrator to check restaurant settings before payment",
    );
  const cashier = await tx.user.findUnique({
    where: { id: userId },
    select: { name: true, status: true, level: true },
  });
  if (
    !cashier ||
    cashier.status !== "use" ||
    !["admin", "kassa"].includes(cashier.level)
  )
    throw new OrderDomainError(403, "FORBIDDEN", "Active cashier is required");
  if (!cashier.name.trim())
    throw new OrderDomainError(
      409,
      "RECEIPT_SETUP_REQUIRED",
      "Receipt setup is incomplete; ask an administrator to check restaurant settings before payment",
    );
  const { logo, ...text } = seller;
  return { version: 1, organization: text, cashierName: cashier.name };
};

const isReceiptIdentity = (value) =>
  value?.version === 1 &&
  typeof value.cashierName === "string" &&
  value.cashierName.trim().length > 0 &&
  ["name", "address", "phone", "email", "website", "bankNo", "taxCode"].every(
    (field) => typeof value.organization?.[field] === "string",
  ) &&
  ["name", "address", "phone", "taxCode"].every(
    (field) => value.organization[field].trim().length > 0,
  );

module.exports = { captureReceiptIdentity, isReceiptIdentity };
