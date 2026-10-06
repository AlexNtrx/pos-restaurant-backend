const writes = require("../lib/organization-write-service");
const { CatalogWriteError } = require("../lib/catalog-write-error");
const prisma = require("../lib/prisma");
const path = require("node:path");
const { storeImage, validateImageFile } = require("../lib/image-upload");
const { ImageProcessingError } = require("../lib/image-variants");

const uploadDirectory = path.resolve("uploads");

module.exports = {
  // Creates  with the current contract.
  create: async (req, res) => {
    try {
      const result = await writes.create({
        body: req.body,
        params: req.params,
        user: req.user,
      });
      return res.send(result);
    } catch (error) {
      if (error instanceof CatalogWriteError)
        return res.status(error.status).send(error.body);
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
