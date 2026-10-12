const { createHash } = require("node:crypto");
const { CatalogWriteError } = require("./catalog-write-error");
const { positiveId } = require("./tax-policy-snapshots");
const { validateRevisionPage } = require("./tax-policy-validation");
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const attestationKeys = [
  "merchantIdentityConfirmed",
  "taxTreatmentConfirmed",
  "categoryMappingConfirmed",
  "roundingConfirmed",
];
const invalid = (field) => {
  throw new CatalogWriteError(400, {
    code: "INVALID_TAX_APPROVAL_REQUEST",
    error: "Review evidence is invalid",
    field,
  });
};
const exact = (value, keys, field) => {
  if (
    !value ||
    typeof value !== "object" ||
    Array.isArray(value) ||
    Object.keys(value).length !== keys.length ||
    keys.some((key) => !Object.hasOwn(value, key))
  )
    invalid(field);
};
const text = (value, max, field) => {
  if (typeof value !== "string" || value.length > max || !value.trim())
    invalid(field);
  return value.trim();
};
const validateReviewEvidence = (value) => {
  exact(
    value,
    [
      "schemaVersion",
      "reviewedByName",
      "reviewedOn",
      "evidenceReference",
      "attestations",
    ],
    "reviewEvidence",
  );
  if (value.schemaVersion !== 1) invalid("schemaVersion");
  const date = value.reviewedOn;
  if (
    typeof date !== "string" ||
    !/^(?!0000)\d{4}-\d{2}-\d{2}$/.test(date) ||
    !Number.isFinite(Date.parse(`${date}T00:00:00.000Z`)) ||
    new Date(`${date}T00:00:00.000Z`).toISOString().slice(0, 10) !== date
  )
    invalid("reviewedOn");
  exact(value.attestations, attestationKeys, "attestations");
  for (const key of attestationKeys)
    if (value.attestations[key] !== true) invalid(key);
  return {
    schemaVersion: 1,
    reviewedByName: text(value.reviewedByName, 150, "reviewedByName"),
    reviewedOn: date,
    evidenceReference: text(value.evidenceReference, 500, "evidenceReference"),
    attestations: Object.fromEntries(attestationKeys.map((key) => [key, true])),
  };
};
const validateApprovalRequest = (body) => {
  exact(
    body,
    [
      "sourceRevisionId",
      "expectedDraftVersion",
      "idempotencyKey",
      "reviewEvidence",
    ],
    "request",
  );
  for (const key of ["sourceRevisionId", "expectedDraftVersion"])
    if (!positiveId(body[key])) invalid(key);
  if (
    typeof body.idempotencyKey !== "string" ||
    !UUID.test(body.idempotencyKey)
  )
    invalid("idempotencyKey");
  return {
    sourceRevisionId: body.sourceRevisionId,
    expectedDraftVersion: body.expectedDraftVersion,
    idempotencyKey: body.idempotencyKey,
    reviewEvidence: validateReviewEvidence(body.reviewEvidence),
  };
};
const validateApprovalPage = (query) => {
  try {
    return validateRevisionPage(query);
  } catch {
    throw new CatalogWriteError(400, {
      code: "INVALID_TAX_APPROVAL_QUERY",
      error: "Approval history query is invalid",
    });
  }
};
const approvalFingerprint = ({
  sourceRevisionId,
  expectedDraftVersion,
  reviewEvidence,
}) =>
  createHash("sha256")
    .update(
      JSON.stringify({
        schemaVersion: 1,
        sourceRevisionId,
        expectedDraftVersion,
        reviewEvidence,
      }),
    )
    .digest("hex");
// EN: A first recording uses Helsinki's calendar day regardless of the host timezone; replay bypasses this clock check.
// FI: Ensimmäinen kirjaus käyttää Helsingin kalenteripäivää palvelimen aikavyöhykkeestä riippumatta; uusinta ohittaa kellotarkistuksen.
const helsinkiDay = (date) =>
  new Intl.DateTimeFormat("en-CA", {
    timeZone: "Europe/Helsinki",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(date);
module.exports = {
  UUID,
  validateReviewEvidence,
  validateApprovalRequest,
  validateApprovalPage,
  approvalFingerprint,
  helsinkiDay,
};
