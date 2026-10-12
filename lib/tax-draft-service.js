const { Prisma } = require("@prisma/client");
const { CatalogWriteError } = require("./catalog-write-error");
const { validateTaxDraftRequest } = require("./tax-draft-validation");
const draftSelect = {
  id: true,
  taxSettingsDraft: true,
  taxSettingsVersion: true,
};
const verifyAdmin = async (client, userId) => {
  const user =
    Number.isSafeInteger(userId) &&
    userId > 0 &&
    (await client.user.findUnique({
      where: { id: userId },
      select: { status: true, level: true },
    }));
  if (!user || user.status !== "use" || user.level !== "admin")
    throw new CatalogWriteError(403, {
      error: "Active administrator is required",
    });
};
const conflict = () =>
  new CatalogWriteError(409, {
    code: "TAX_DRAFT_CONFLICT",
    error: "Tax draft changed; review the latest saved draft",
  });
const response = (organization) => ({
  organizationConfigured: Boolean(organization),
  draft: organization?.taxSettingsDraft ?? null,
  version: organization?.taxSettingsVersion ?? 0,
});
const readTaxDraft = async (client, userId) => {
  await verifyAdmin(client, userId);
  return response(
    await client.organization.findFirst({
      orderBy: { id: "asc" },
      select: draftSelect,
    }),
  );
};
const saveTaxDraft = async (client, userId, body) => {
  await verifyAdmin(client, userId);
  const { expectedVersion, draft } = validateTaxDraftRequest(body);
  try {
    return await client.$transaction(
      async (tx) => {
        await verifyAdmin(tx, userId);
        const organization = await tx.organization.findFirst({
          orderBy: { id: "asc" },
          select: draftSelect,
        });
        if (!organization)
          throw new CatalogWriteError(409, {
            code: "RESTAURANT_SETUP_REQUIRED",
            error: "Save restaurant settings before the tax draft",
          });
        const stored = {
          ...draft,
          schemaVersion: 1,
          savedByUserId: userId,
          savedAt: new Date().toISOString(),
        };
        // EN: Compare-and-set keeps competing tabs from overwriting a newer draft; this data has no financial consumer.
        // FI: Vertaa-ja-aseta estää kilpailevia välilehtiä korvaamasta uudempaa luonnosta; talouslogiikka ei lue näitä tietoja.
        const saved = await tx.organization.updateMany({
          where: { id: organization.id, taxSettingsVersion: expectedVersion },
          data: {
            taxSettingsDraft: stored,
            taxSettingsVersion: { increment: 1 },
          },
        });
        if (saved.count !== 1) throw conflict();
        return response({
          ...organization,
          taxSettingsDraft: stored,
          taxSettingsVersion: expectedVersion + 1,
        });
      },
      { isolationLevel: Prisma.TransactionIsolationLevel.Serializable },
    );
  } catch (error) {
    if (error?.code === "P2034") throw conflict();
    throw error;
  }
};
module.exports = { readTaxDraft, saveTaxDraft };
