const writes = require("../lib/food-write-service");
const { CatalogWriteError } = require("../lib/catalog-write-error");
const prisma = require("../lib/prisma");
const { positiveInteger } = require("../lib/catalog-validation");
const path = require("node:path");
const { storeImage, validateImageFile } = require("../lib/image-upload");
const { ImageProcessingError } = require("../lib/image-variants");

const MAX_PAGE_SIZE = 100;
const uploadDirectory = path.resolve("uploads");

// Coordinates send known error behavior for this module.
const sendKnownError = (res, error) => {
  if (error?.code === "P2025") {
    res.status(404).send({ error: "Food not found" });
    return true;
  }
  return false;
};

module.exports = {
  // Coordinates upload behavior for this module.
  upload: async (req, res) => {
    const uploadedFile = req.files?.file;
    const validated = validateImageFile(uploadedFile, {
      requiredMessage: "One image file is required",
      sizeMessage: "Image must be between 1 byte and 5 MB",
    });
    if (validated.error)
      return res.status(400).send({ error: validated.error });
    try {
      const fileName = await storeImage(uploadedFile, { uploadDirectory });
      return res.status(201).send({ message: "success", fileName });
    } catch (error) {
      if (error instanceof ImageProcessingError) {
        if (error.status === 429) res.set("Retry-After", "2");
        return res.status(error.status).send({ error: error.message });
      }
      return res.status(500).send({ error: "Unable to upload image" });
    }
  },

  // Creates  with the current contract.
  create: async (req, res) => {
    try {
      const result = await writes.create({
        body: req.body,
        params: req.params,
        user: req.user,
      });
      return res.status(201).send(result);
    } catch (error) {
      if (error instanceof CatalogWriteError)
        return res.status(error.status).send(error.body);
      return res.status(500).send({ error: "Unable to create food" });
    }
  },

  // Coordinates list behavior for this module.
  list: async (_req, res) => {
    try {
      const foods = await prisma.food.findMany({
        include: { FoodType: true },
        where: { status: "use" },
        orderBy: { id: "desc" },
      });
      return res.send({ results: foods });
    } catch {
      return res.status(500).send({ error: "Unable to list foods" });
    }
  },

  // Removes or clears  using the existing workflow.
  remove: async (req, res) => {
    try {
      const result = await writes.remove({
        body: req.body,
        params: req.params,
        user: req.user,
      });
      return res.send(result);
    } catch (error) {
      if (error instanceof CatalogWriteError)
        return res.status(error.status).send(error.body);
      if (sendKnownError(res, error)) return;
      return res.status(500).send({ error: "Unable to remove food" });
    }
  },

  // Updates  without changing user-visible behavior.
  update: async (req, res) => {
    try {
      const result = await writes.update({
        body: req.body,
        params: req.params,
        user: req.user,
      });
      return res.send(result);
    } catch (error) {
      if (error instanceof CatalogWriteError)
        return res.status(error.status).send(error.body);
      if (sendKnownError(res, error)) return;
      return res.status(500).send({ error: "Unable to update food" });
    }
  },

  // Coordinates filter behavior for this module.
  filter: async (req, res) => {
    try {
      const foodType = req.params.foodType;
      if (!["all", "food", "drink"].includes(foodType)) {
        return res
          .status(400)
          .send({ error: "foodType must be all, food, or drink" });
      }
      const foods = await prisma.food.findMany({
        where: { status: "use", ...(foodType === "all" ? {} : { foodType }) },
        include: { FoodType: true },
        orderBy: { id: "desc" },
      });
      return res.send({ results: foods });
    } catch {
      return res.status(500).send({ error: "Internal server error" });
    }
  },

  // Coordinates paginate behavior for this module.
  paginate: async (req, res) => {
    const page = positiveInteger(req.body?.page);
    const itemsPerPage = positiveInteger(req.body?.itemsPerPage);
    if (!page || !itemsPerPage || itemsPerPage > MAX_PAGE_SIZE) {
      return res.status(400).send({
        error: "page must be positive and itemsPerPage must be 1-100",
      });
    }

    try {
      const where = { status: "use" };
      const [foods, totalItems] = await prisma.$transaction([
        prisma.food.findMany({
          skip: (page - 1) * itemsPerPage,
          take: itemsPerPage,
          orderBy: { id: "desc" },
          where,
        }),
        prisma.food.count({ where }),
      ]);
      return res.send({
        results: foods,
        totalItems,
        totalPages: Math.ceil(totalItems / itemsPerPage),
      });
    } catch {
      return res.status(500).send({ error: "Unable to paginate foods" });
    }
  },
};
