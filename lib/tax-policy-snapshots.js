const { isDeepStrictEqual } = require("node:util");
const { CatalogWriteError } = require("./catalog-write-error");
const { validateTaxDraft } = require("./tax-draft-validation");
const { validateOrganization } = require("./organization-validation");
const positiveId = (value) =>
  Number.isSafeInteger(value) && value > 0 && value <= 2147483647;
const sellerKeys = [
  "name",
  "address",
  "phone",
  "email",
  "website",
  "bankNo",
  "taxCode",
];
const sellerText = (value) => {
  const validated = validateOrganization({ ...value, logo: "" });
  if (validated.error) return null;
  const { logo, ...text } = validated;
  return text;
};
// EN: Stored seller text must be canonical; a corrupt historical copy is never refreshed from current settings.
// FI: Tallennetun myyjätekstin on oltava kanoninen; virheellistä historiallista kopiota ei päivitetä nykyisistä asetuksista.
const readSellerSnapshot = (value) => {
  const validated = sellerText(value);
  if (
    !value ||
    Array.isArray(value) ||
    Object.keys(value).length !== sellerKeys.length ||
    sellerKeys.some((key) => typeof value[key] !== "string") ||
    !validated ||
    !isDeepStrictEqual(value, validated)
  )
    throw new Error("Invalid seller snapshot");
  return validated;
};
const readRevision = (revision) => {
  try {
    const configuration = validateTaxDraft(revision.configuration);
    if (
      !positiveId(revision.id) ||
      !positiveId(revision.sourceDraftVersion) ||
      revision.schemaVersion !== 1 ||
      !positiveId(revision.createdByUserId) ||
      typeof revision.createdByName !== "string" ||
      !revision.createdByName.trim() ||
      !(revision.createdAt instanceof Date) ||
      !Number.isFinite(revision.createdAt.getTime()) ||
      !isDeepStrictEqual(configuration, revision.configuration)
    )
      throw new Error("Invalid revision");
    return {
      id: revision.id,
      sourceDraftVersion: revision.sourceDraftVersion,
      configuration,
      sellerSnapshot: readSellerSnapshot(revision.sellerSnapshot),
      createdAt: revision.createdAt,
      createdByName: revision.createdByName,
    };
  } catch {
    throw new CatalogWriteError(409, {
      code: "TAX_POLICY_REVISION_INVALID",
      error: "Stored revision is invalid",
    });
  }
};
module.exports = { positiveId, sellerText, readSellerSnapshot, readRevision };
