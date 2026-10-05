const { Prisma } = require("@prisma/client");
const prisma = require("../lib/prisma");
const { cleanupAfterSave } = require("../lib/post-save-cleanup");
const path = require("node:path");
const { storeImage, validateImageFile } = require("../lib/image-upload");
const {
  removeImageArtifacts,
  ImageProcessingError,
} = require("../lib/image-variants");

const uploadDirectory = path.resolve("uploads");
// Coordinates text behavior for this module.
const text = (value) => (typeof value === "string" ? value.trim() : "");
// Coordinates safe logo name behavior for this module.
const safeLogoName = (value) =>
  typeof value === "string" &&
  value.length <= 160 &&
  (value === "" || (path.basename(value) === value && !value.includes("\0")));
// Coordinates valid url behavior for this module.
const validUrl = (value) => {
  if (!value) return true;
  if (/\s/.test(value)) return false;
  try {
    const url = new URL(
      /^https?:\/\//i.test(value) ? value : `https://${value}`,
    );
    return Boolean(url.hostname);
  } catch {
    return false;
  }
};
// Validates organization fields before persistence.
const validateOrganization = (body) => {
  const data = {
    name: text(body?.name),
    address: text(body?.address),
    phone: text(body?.phone),
    email: text(body?.email),
    website: text(body?.website),
    bankNo: text(body?.bankNo),
    logo: body?.logo ?? "",
    taxCode: text(body?.taxCode),
  };
  if (!data.name || data.name.length > 150)
    return { error: "Name must be 1-150 characters" };
  if (!data.address || data.address.length > 500)
    return { error: "Address must be 1-500 characters" };
  if (!data.phone || data.phone.length > 50)
    return { error: "Phone must be 1-50 characters" };
  if (
    data.email.length > 254 ||
    (data.email && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(data.email))
  )
    return { error: "Email is invalid" };
  if (data.website.length > 250 || !validUrl(data.website))
    return { error: "Website must be an http or https URL" };
  if (data.bankNo.length > 100)
    return { error: "Bank number must be at most 100 characters" };
  if (!data.taxCode || data.taxCode.length > 50)
    return { error: "Tax code must be 1-50 characters" };
  if (!safeLogoName(data.logo)) return { error: "Invalid logo filename" };
  return data;
};
// Removes or clears old logo using the existing workflow.
const removeOldLogo = async (oldLogo, newLogo) => {
  if (!oldLogo || oldLogo === newLogo || !safeLogoName(oldLogo)) return;
  await removeImageArtifacts(uploadDirectory, oldLogo);
};

module.exports = {
  // Creates  with the current contract.
  create: async (req, res) => {
    const data = validateOrganization(req.body);
    if (data.error) return res.status(400).send({ error: data.error });
    try {
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
      return res.send({ message: "success" });
    } catch (error) {
      if (error?.code === "P2002" || error?.code === "P2034")
        return res
          .status(409)
          .send({ error: "Organization update conflicted; try again" });
      return res.status(500).send({ error: "Unable to save organization" });
    }
  },
  // Coordinates info behavior for this module.
  info: async (_req, res) => {
    try {
      return res.send({
        result: await prisma.organization.findFirst({ orderBy: { id: "asc" } }),
      });
    } catch {
      return res.status(500).send({ error: "Unable to load organization" });
    }
  },
  // Coordinates upload behavior for this module.
  upload: async (req, res) => {
    const file = req.files?.file;
    const validated = validateImageFile(file, {
      requiredMessage: "One logo image is required",
      sizeMessage: "Logo must be between 1 byte and 5 MB",
    });
    if (validated.error)
      return res.status(400).send({ error: validated.error });
    try {
      const fileName = await storeImage(file, {
        uploadDirectory,
        prefix: "logo_",
      });
      return res.status(201).send({ message: "success", fileName });
    } catch (error) {
      if (error instanceof ImageProcessingError) {
        if (error.status === 429) res.set("Retry-After", "2");
        return res.status(error.status).send({ error: error.message });
      }
      return res.status(500).send({ error: "Unable to upload logo" });
    }
  },
};
