const { CatalogWriteError } = require("./catalog-write-error");
const { Prisma } = require("@prisma/client");
const prisma = require("./prisma");
const { cleanupAfterSave } = require("./post-save-cleanup");
const {
  validateOrganization,
  safeLogoName,
} = require("./organization-validation");
const { removeImageArtifacts } = require("./image-variants");
const path = require("node:path");
const removeOldLogo = async (oldLogo, newLogo) => {
  if (!oldLogo || oldLogo === newLogo || !safeLogoName(oldLogo)) return;
  await removeImageArtifacts(uploadDirectory, oldLogo);
};
const uploadDirectory = path.resolve("uploads");
async function create(context) {
  const data = validateOrganization(context.body);
  if (data.error) throw new CatalogWriteError(400, { error: data.error });

  const oldLogo = await prisma.$transaction(
    async (tx) => {
      const existing = await tx.organization.findFirst({
        orderBy: { id: "asc" },
      });
      if (!existing) {
        await tx.organization.create({ data });
        return "";
      }
      await tx.organization.update({ where: { id: existing.id }, data });
      return existing.logo;
    },
    { isolationLevel: Prisma.TransactionIsolationLevel.Serializable },
  );
  await cleanupAfterSave("organization", () =>
    removeOldLogo(oldLogo, data.logo),
  );
  return { message: "success" };
}
module.exports = { create };
