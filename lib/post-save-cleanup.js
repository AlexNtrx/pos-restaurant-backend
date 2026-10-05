// EN: Filesystem cleanup cannot undo a committed save; report its failure separately.
// FI: Tiedostosiivous ei voi perua tallennusta; ilmoita sen virhe erikseen.
async function cleanupAfterSave(resource, cleanup) {
  try {
    await cleanup();
  } catch (error) {
    console.error("Post-save image cleanup failed", {
      resource,
      code:
        typeof error?.code === "string" && /^[A-Z0-9_]{1,32}$/.test(error.code)
          ? error.code
          : "UNKNOWN",
    });
  }
}

module.exports = { cleanupAfterSave };
