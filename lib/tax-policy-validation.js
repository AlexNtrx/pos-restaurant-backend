const { CatalogWriteError } = require("./catalog-write-error");
const { validateTaxDraft } = require("./tax-draft-validation");
const invalid = () => {
  throw new CatalogWriteError(400, {
    code: "INVALID_TAX_POLICY_REQUEST",
    error: "Tax policy request is invalid",
  });
};
const validateRevisionRequest = (body) => {
  if (
    !body ||
    typeof body !== "object" ||
    Array.isArray(body) ||
    Object.keys(body).length !== 1 ||
    !Object.hasOwn(body, "expectedDraftVersion") ||
    !Number.isSafeInteger(body.expectedDraftVersion) ||
    body.expectedDraftVersion < 1 ||
    body.expectedDraftVersion > 2147483647
  )
    invalid();
  return body.expectedDraftVersion;
};
const validateRevisionPage = (query) => {
  if (Object.keys(query).some((key) => !["page", "limit"].includes(key)))
    invalid();
  const number = (value, fallback, max) => {
    if (value === undefined) return fallback;
    if (typeof value !== "string" || !/^[1-9]\d{0,9}$/.test(value)) invalid();
    const parsed = Number(value);
    if (parsed > max) invalid();
    return parsed;
  };
  const page = number(query.page, 1, 2147483647);
  const pageSize = number(query.limit, 10, 50);
  const skip = (page - 1) * pageSize;
  if (skip > 2147483647) invalid();
  return { page, pageSize, skip };
};
const readStoredConfiguration = (stored, version) => {
  if (stored === null && version === 0) return null;
  try {
    if (
      !stored ||
      typeof stored !== "object" ||
      Array.isArray(stored) ||
      Object.keys(stored).length !== 10 ||
      stored.schemaVersion !== 1 ||
      !Number.isSafeInteger(version) ||
      version < 1 ||
      !Number.isSafeInteger(stored.savedByUserId) ||
      stored.savedByUserId < 1 ||
      typeof stored.savedAt !== "string" ||
      !Number.isFinite(Date.parse(stored.savedAt))
    )
      throw new Error("Invalid metadata");
    const { schemaVersion, savedByUserId, savedAt, ...configuration } = stored;
    return validateTaxDraft(configuration);
  } catch {
    throw new CatalogWriteError(409, {
      code: "TAX_POLICY_DRAFT_INVALID",
      error: "Stored tax draft is invalid; save a valid draft before review",
    });
  }
};
module.exports = {
  validateRevisionRequest,
  validateRevisionPage,
  readStoredConfiguration,
};
