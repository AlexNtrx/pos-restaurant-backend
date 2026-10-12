const { Prisma } = require("@prisma/client");
const { CatalogWriteError } = require("./catalog-write-error");
const {
  positiveId,
  validateControlQuery,
  validateControlState,
} = require("./tax-control-validation");
const verifyAdmin = async (client, userId) => {
  const user =
    positiveId(userId) &&
    (await client.user.findUnique({
      where: { id: userId },
      select: { level: true, status: true },
    }));
  if (!user || user.level !== "admin" || user.status !== "use")
    throw new CatalogWriteError(403, {
      code: "FORBIDDEN",
      error: "Active administrator is required",
    });
};
const readControlState = async (client, organizationId, lockedControl) => {
  const control =
    lockedControl ??
    (await client.organizationTaxControl.findUnique({
      where: { organizationId },
    }));
  const latestEvent = await client.taxControlEvent.findFirst({
    where: { organizationId },
    orderBy: { toGeneration: "desc" },
  });
  return validateControlState(control, organizationId, latestEvent);
};
// EN: Recheck Admin access inside one read snapshot; every capability stays false until later runtime work is approved.
// FI: Tarkista ylläpitäjän oikeus uudelleen samassa lukutilannekuvassa; kaikki toiminnot pysyvät suljettuina myöhemmän ajonaikaisen työn hyväksymiseen asti.
const readTaxControl = async (client, userId, query) => {
  await verifyAdmin(client, userId);
  validateControlQuery(query);
  return client.$transaction(
    async (tx) => {
      await verifyAdmin(tx, userId);
      const organization = await tx.organization.findFirst({
        orderBy: { id: "asc" },
        select: { id: true },
      });
      if (!organization)
        throw new CatalogWriteError(409, {
          code: "RESTAURANT_SETUP_REQUIRED",
          error: "Restaurant setup is required",
        });
      const control = await readControlState(tx, organization.id);
      return {
        organizationId: control.organizationId,
        mode: control.mode,
        taxGeneration: control.generation,
        version: control.version,
        updatedAt: control.updatedAt,
        transitionProtocolVersion: 1,
        canDrain: false,
        canResumeLegacy: false,
        canActivate: false,
        commercialReady: false,
      };
    },
    { isolationLevel: Prisma.TransactionIsolationLevel.RepeatableRead },
  );
};
module.exports = { readTaxControl, readControlState };
