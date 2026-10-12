const { CatalogWriteError } = require("./catalog-write-error");
const draftKeys = [
  "countryCode",
  "vatStatus",
  "pricingMode",
  "rates",
  "requestedEffectiveDate",
  "reviewerName",
  "nonRegistrationReason",
];
const rateKeys = ["FOOD_NON_ALCOHOLIC", "ALCOHOL"];
const invalid = (field) => {
  throw new CatalogWriteError(400, {
    code: "INVALID_TAX_DRAFT",
    error: "Tax draft is invalid",
    field,
  });
};
const exactKeys = (value, keys, field) => {
  if (
    !value ||
    typeof value !== "object" ||
    Array.isArray(value) ||
    Object.keys(value).length !== keys.length ||
    keys.some((key) => !Object.hasOwn(value, key))
  )
    invalid(field);
};
const optionalText = (value, max, field) => {
  if (value === null) return null;
  if (typeof value !== "string" || value.length > max) invalid(field);
  return value.trim() || null;
};
const validateTaxDraft = (value) => {
  exactKeys(value, draftKeys, "draft");
  if (value.countryCode !== null && value.countryCode !== "FI")
    invalid("countryCode");
  if (
    !["UNCONFIRMED", "REGISTERED", "NOT_REGISTERED"].includes(value.vatStatus)
  )
    invalid("vatStatus");
  if (value.pricingMode !== "FINAL_PRICE") invalid("pricingMode");
  exactKeys(value.rates, rateKeys, "rates");
  for (const field of rateKeys) {
    const rate = value.rates[field];
    if (
      rate !== null &&
      (!Number.isSafeInteger(rate) || rate <= 0 || rate > 10000)
    )
      invalid(`rates.${field}`);
  }
  const date = value.requestedEffectiveDate;
  if (
    date !== null &&
    (typeof date !== "string" ||
      !/^(?!0000)\d{4}-\d{2}-\d{2}$/.test(date) ||
      !Number.isFinite(Date.parse(`${date}T00:00:00.000Z`)) ||
      new Date(`${date}T00:00:00.000Z`).toISOString().slice(0, 10) !== date)
  )
    invalid("requestedEffectiveDate");
  // EN: Incomplete drafts are valid settings; they never establish registration or an active tax policy.
  // FI: Keskeneräiset luonnokset ovat kelvollisia asetuksia; ne eivät vahvista rekisteröintiä tai aktiivista verokäytäntöä.
  return {
    countryCode: value.countryCode,
    vatStatus: value.vatStatus,
    pricingMode: "FINAL_PRICE",
    rates: { ...value.rates },
    requestedEffectiveDate: date,
    reviewerName: optionalText(value.reviewerName, 120, "reviewerName"),
    nonRegistrationReason: optionalText(
      value.nonRegistrationReason,
      500,
      "nonRegistrationReason",
    ),
  };
};
const validateTaxDraftRequest = (body) => {
  exactKeys(body, ["expectedVersion", "draft"], "request");
  if (
    !Number.isSafeInteger(body.expectedVersion) ||
    body.expectedVersion < 0 ||
    body.expectedVersion >= 2147483647
  )
    invalid("expectedVersion");
  return {
    expectedVersion: body.expectedVersion,
    draft: validateTaxDraft(body.draft),
  };
};
module.exports = { validateTaxDraft, validateTaxDraftRequest };
