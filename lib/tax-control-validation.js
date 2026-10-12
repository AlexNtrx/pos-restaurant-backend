const { createHash } = require("node:crypto");
const { CatalogWriteError } = require("./catalog-write-error");
const MAX_GENERATION = 2147483646;
const positiveId = (value) =>
  Number.isSafeInteger(value) && value > 0 && value <= 2147483647;
const generation = (value) =>
  Number.isSafeInteger(value) && value >= 0 && value <= MAX_GENERATION;
const validDate = (value) =>
  value instanceof Date && Number.isFinite(value.getTime());
const unavailable = () => {
  throw new CatalogWriteError(503, {
    code: "TAX_CONTROL_UNAVAILABLE",
    error: "Tax control metadata is unavailable",
  });
};
const validateControlQuery = (query) => {
  if (
    !query ||
    typeof query !== "object" ||
    Array.isArray(query) ||
    Object.keys(query).length
  )
    throw new CatalogWriteError(400, {
      code: "INVALID_TAX_CONTROL_QUERY",
      error: "Tax control does not accept query parameters",
    });
};

// EN: Versioned fingerprints describe transition intent only; this module performs no transition writes.
// FI: Versioidut tiivisteet kuvaavat vain siirtymäaikomusta; tämä moduuli ei kirjoita siirtymiä.
const eventFingerprint = (event) =>
  createHash("sha256")
    .update(
      JSON.stringify({
        schemaVersion: 1,
        action: event.action,
        expectedVersion: event.fromVersion,
        expectedGeneration: event.fromGeneration,
        reason: event.reason,
      }),
    )
    .digest("hex");
const validEvent = (event, organizationId) =>
  event &&
  positiveId(event.id) &&
  event.organizationId === organizationId &&
  event.schemaVersion === 1 &&
  ((event.action === "DRAIN" &&
    event.fromMode === "LEGACY" &&
    event.toMode === "DRAINING") ||
    (event.action === "RESUME_LEGACY" &&
      event.fromMode === "DRAINING" &&
      event.toMode === "LEGACY")) &&
  generation(event.fromGeneration) &&
  generation(event.toGeneration) &&
  event.toGeneration === event.fromGeneration + 1 &&
  event.fromVersion === event.fromGeneration + 1 &&
  event.toVersion === event.toGeneration + 1 &&
  typeof event.reason === "string" &&
  event.reason === event.reason.trim() &&
  [...event.reason].length >= 3 &&
  [...event.reason].length <= 500 &&
  typeof event.idempotencyKey === "string" &&
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(
    event.idempotencyKey,
  ) &&
  event.requestFingerprint === eventFingerprint(event) &&
  positiveId(event.recordedByUserId) &&
  typeof event.recordedByName === "string" &&
  Boolean(event.recordedByName.trim()) &&
  event.recordedByName === event.recordedByName.trim() &&
  validDate(event.recordedAt);

// EN: Validate the baseline or latest event, never fabricate a usable legacy state for missing/corrupt data.
// FI: Tarkista lähtötila tai viimeisin tapahtuma; älä luo käyttökelpoista vanhaa tilaa puuttuville tai virheellisille tiedoille.
const validateControlState = (control, organizationId, latestEvent) => {
  if (
    !positiveId(organizationId) ||
    !control ||
    control.organizationId !== organizationId ||
    !["LEGACY", "DRAINING"].includes(control.mode) ||
    !generation(control.generation) ||
    control.version !== control.generation + 1 ||
    !validDate(control.updatedAt)
  )
    unavailable();
  if (control.generation === 0) {
    if (control.mode !== "LEGACY" || latestEvent) unavailable();
  } else if (
    !validEvent(latestEvent, organizationId) ||
    latestEvent.toMode !== control.mode ||
    latestEvent.toGeneration !== control.generation ||
    latestEvent.toVersion !== control.version
  )
    unavailable();
  return control;
};
module.exports = {
  positiveId,
  validateControlQuery,
  validateControlState,
  eventFingerprint,
  unavailable,
};
