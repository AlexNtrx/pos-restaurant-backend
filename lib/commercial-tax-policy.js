const ROUNDING_POLICY = "GROSS_GROUP_HALF_UP_V1";
const CATEGORIES = Object.freeze(["FOOD_NON_ALCOHOLIC", "ALCOHOL"]);
const MAX_POLICY_VERSIONS = 1000;
class CommercialTaxError extends Error {
  constructor(code, field) {
    super(`${code}: ${field}`);
    this.name = "CommercialTaxError";
    this.code = code;
    this.field = field;
  }
}
const invalid = (code, field) => {
  throw new CommercialTaxError(code, field);
};
const exactKeys = (value, keys, code, field) => {
  if (
    !value ||
    typeof value !== "object" ||
    Array.isArray(value) ||
    Object.keys(value).length !== keys.length ||
    keys.some((key) => !Object.hasOwn(value, key))
  )
    invalid(code, field);
};
const policyKeys = [
  "id",
  "effectiveFrom",
  "countryCode",
  "pricingMode",
  "currency",
  "vatStatus",
  "rates",
  "nonRegistrationReason",
  "roundingPolicy",
];
const contextKeys = [
  "schemaVersion",
  "mode",
  "policyRevisionId",
  "effectiveFrom",
  "countryCode",
  "pricingMode",
  "currency",
  "vatStatus",
  "roundingPolicy",
  "category",
  "rateBps",
  "nonRegistrationReason",
  "taxPoint",
];
const positiveId = (id, code, field) => {
  if (!Number.isSafeInteger(id) || id < 1 || id > 2147483647)
    invalid(code, field);
};
const rateValid = (rate) =>
  Number.isSafeInteger(rate) && rate > 0 && rate <= 10000;
const normalizeInstant = (value, code, field) => {
  if (typeof value !== "string") invalid(code, field);
  const match =
    /^(?!0000)(\d{4}-\d{2}-\d{2})T(\d{2}:\d{2}:\d{2})(\.\d{3})?(Z|[+-]\d{2}:\d{2})$/.exec(
      value,
    );
  if (!match || value.endsWith("-00:00")) invalid(code, field);
  const local = `${match[1]}T${match[2]}${match[3] ?? ".000"}Z`;
  const localDate = new Date(local),
    instant = new Date(value);
  // EN: Validate the wall-clock calendar before applying its explicit offset; Date parsing alone normalizes impossible dates.
  // FI: Tarkista paikallinen kalenteriaika ennen annetun siirtymän käyttöä; Date-jäsennys yksin normalisoi mahdottomia päivämääriä.
  if (
    !Number.isFinite(localDate.getTime()) ||
    localDate.toISOString() !== local ||
    !Number.isFinite(instant.getTime()) ||
    !/^(?!0000)\d{4}-/.test(instant.toISOString())
  )
    invalid(code, field);
  return instant.toISOString();
};
const terms = (value, code) => {
  if (
    value.countryCode !== "FI" ||
    value.pricingMode !== "FINAL_PRICE" ||
    value.currency !== "EUR" ||
    value.roundingPolicy !== ROUNDING_POLICY
  )
    invalid(code, "terms");
  if (!["REGISTERED", "NOT_REGISTERED"].includes(value.vatStatus))
    invalid(code, "vatStatus");
  const reason = value.nonRegistrationReason;
  if (reason !== null && (typeof reason !== "string" || reason.length > 500))
    invalid(code, "nonRegistrationReason");
  if (value.vatStatus === "NOT_REGISTERED" && !reason?.trim())
    invalid(code, "nonRegistrationReason");
  return {
    countryCode: "FI",
    pricingMode: "FINAL_PRICE",
    currency: "EUR",
    vatStatus: value.vatStatus,
    roundingPolicy: ROUNDING_POLICY,
    nonRegistrationReason: reason?.trim() || null,
  };
};
const validateCommercialPolicy = (value) => {
  const code = "INVALID_COMMERCIAL_POLICY";
  exactKeys(value, policyKeys, code, "policy");
  positiveId(value.id, code, "id");
  const validated = terms(value, code);
  exactKeys(value.rates, CATEGORIES, code, "rates");
  for (const category of CATEGORIES) {
    if (
      validated.vatStatus === "REGISTERED"
        ? !rateValid(value.rates[category])
        : value.rates[category] !== null
    )
      invalid(code, `rates.${category}`);
  }
  return {
    id: value.id,
    effectiveFrom: normalizeInstant(value.effectiveFrom, code, "effectiveFrom"),
    ...validated,
    rates: { ...value.rates },
  };
};
const validateCommercialTimeline = (values) => {
  const code = "INVALID_COMMERCIAL_TIMELINE";
  if (
    !Array.isArray(values) ||
    !values.length ||
    values.length > MAX_POLICY_VERSIONS
  )
    invalid(code, "policies");
  const ids = new Set();
  const policies = Array.from(values, validateCommercialPolicy);
  for (let i = 0; i < policies.length; i++) {
    if (
      ids.has(policies[i].id) ||
      (i > 0 && policies[i - 1].effectiveFrom >= policies[i].effectiveFrom)
    )
      invalid(code, "policies");
    ids.add(policies[i].id);
  }
  return policies;
};
const validateTaxPoint = (value) => {
  const code = "INVALID_COMMERCIAL_TAX_POINT";
  exactKeys(value, ["kind", "occurredAt"], code, "taxPoint");
  if (!["RECEIVED_FULL_ADVANCE", "SUPPLY_COMPLETED"].includes(value.kind))
    invalid(code, "kind");
  return {
    kind: value.kind,
    occurredAt: normalizeInstant(value.occurredAt, code, "occurredAt"),
  };
};
const validateCommercialContext = (value) => {
  const code = "INVALID_COMMERCIAL_CONTEXT";
  exactKeys(value, contextKeys, code, "context");
  if (value.schemaVersion !== 1 || value.mode !== "COMMERCIAL")
    invalid(code, "schemaVersion/mode");
  positiveId(value.policyRevisionId, code, "policyRevisionId");
  const validated = terms(value, code);
  const effectiveFrom = normalizeInstant(
    value.effectiveFrom,
    code,
    "effectiveFrom",
  );
  const taxPoint = validateTaxPoint(value.taxPoint);
  if (taxPoint.occurredAt < effectiveFrom) invalid(code, "taxPoint");
  if (
    validated.vatStatus === "REGISTERED"
      ? !CATEGORIES.includes(value.category) || !rateValid(value.rateBps)
      : (value.category !== null && !CATEGORIES.includes(value.category)) ||
        value.rateBps !== null
  )
    invalid(code, "category/rateBps");
  return {
    schemaVersion: 1,
    mode: "COMMERCIAL",
    policyRevisionId: value.policyRevisionId,
    effectiveFrom,
    ...validated,
    category: value.category,
    rateBps: value.rateBps,
    taxPoint,
  };
};
// EN: This detached resolver consumes explicit caller data; it neither publishes a policy nor proves payment/supply or administrator approval.
// FI: Tämä erillinen ratkaisija käyttää kutsujan antamia tietoja; se ei julkaise käytäntöä eikä todista maksua, toimitusta tai ylläpitäjän hyväksyntää.
const resolveCommercialTaxContext = (values, input) => {
  exactKeys(
    input,
    ["category", "taxPoint"],
    "INVALID_COMMERCIAL_CONTEXT",
    "input",
  );
  if (input.category !== null && !CATEGORIES.includes(input.category))
    invalid("INVALID_COMMERCIAL_CONTEXT", "category");
  const policies = validateCommercialTimeline(values);
  const taxPoint = validateTaxPoint(input.taxPoint);
  // EN: Choose the interval [effectiveFrom, nextEffectiveFrom); the final supplied revision remains open-ended.
  // FI: Valitse aikaväli [effectiveFrom, nextEffectiveFrom); viimeinen annettu versio jää avoimeksi tulevaisuuteen.
  const policy = policies.findLast(
    (value) => value.effectiveFrom <= taxPoint.occurredAt,
  );
  if (!policy) invalid("COMMERCIAL_POLICY_NOT_FOUND", "taxPoint.occurredAt");
  return validateCommercialContext({
    schemaVersion: 1,
    mode: "COMMERCIAL",
    policyRevisionId: policy.id,
    effectiveFrom: policy.effectiveFrom,
    countryCode: policy.countryCode,
    pricingMode: policy.pricingMode,
    currency: policy.currency,
    vatStatus: policy.vatStatus,
    roundingPolicy: policy.roundingPolicy,
    nonRegistrationReason: policy.nonRegistrationReason,
    category: input.category,
    rateBps:
      policy.vatStatus === "REGISTERED" ? policy.rates[input.category] : null,
    taxPoint,
  });
};
module.exports = {
  CommercialTaxError,
  ROUNDING_POLICY,
  validateCommercialPolicy,
  validateCommercialTimeline,
  validateTaxPoint,
  validateCommercialContext,
  resolveCommercialTaxContext,
};
