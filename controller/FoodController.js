const prisma = require("../lib/prisma");
const {
  positiveInteger,
  activeCategoryExists,
} = require("../lib/catalog-validation");
const fs = require("node:fs/promises");
const path = require("node:path");
const { storeImage, validateImageFile } = require("../lib/image-upload");

const MAX_PRICE = 10_000_000;
const MAX_PAGE_SIZE = 100;
const validFoodTypes = new Set(["food", "drink"]);
const uploadDirectory = path.resolve("uploads");

// Coordinates non negative integer behavior for this module.
const nonNegativeInteger = (value) => {
  const parsed = Number(value);
  return Number.isInteger(parsed) && parsed >= 0 && parsed <= MAX_PRICE
    ? parsed
    : null;
};

// Coordinates normalize text behavior for this module.
const normalizeText = (value) =>
  typeof value === "string" ? value.trim() : "";

// Validates is safe image name before it is used.
const isSafeImageName = (value) =>
  typeof value === "string" &&
  value.length <= 160 &&
  (value === "" || (path.basename(value) === value && !value.includes("\0")));

// Validates food fields before persistence.
const validateFood = (body) => {
  const foodTypeId = positiveInteger(body?.foodTypeId);
  const name = normalizeText(body?.name);
  const remark = normalizeText(body?.remark);
  const price = nonNegativeInteger(body?.price);
  const foodType = body?.foodType;
  const img = body?.img ?? "";
  const detailImg = body?.detailImg;

  if (!foodTypeId) return { error: "foodTypeId must be a positive integer" };
  if (!name || name.length > 120)
    return { error: "Name must be 1-120 characters" };
  if (remark.length > 500)
    return { error: "Remark must be at most 500 characters" };
  if (price === null)
    return { error: "Price must be a whole number from 0 to 10000000" };
  if (!validFoodTypes.has(foodType))
    return { error: "foodType must be food or drink" };
  if (!isSafeImageName(img)) return { error: "Invalid image filename" };
  if (detailImg !== undefined && !isSafeImageName(detailImg))
    return { error: "Invalid detail image filename" };

  // EN: Omitting detailImg keeps older clients compatible and preserves an existing detail image on update.
  // FI: detailImg-kentän pois jättäminen säilyttää vanhojen asiakkaiden yhteensopivuuden ja olemassa olevan lisätietokuvan päivityksessä.
  return {
    foodTypeId,
    name,
    remark,
    price,
    foodType,
    img,
    ...(detailImg === undefined ? {} : { detailImg }),
  };
};

// Coordinates send known error behavior for this module.
const sendKnownError = (res, error) => {
  if (error?.code === "P2025") {
    res.status(404).send({ error: "Food not found" });
    return true;
  }
  return false;
};

// EN: Delete a replaced upload only when neither image field of any food still references it.
// FI: Korvattu kuva poistetaan vain, kun yksikään annos ei enää viittaa siihen kummassakaan kuvakentässä.
const removeUnreferencedImage = async (oldImage) => {
  if (!oldImage || !isSafeImageName(oldImage)) return;
  const referenceCount = await prisma.food.count({
    where: { OR: [{ img: oldImage }, { detailImg: oldImage }] },
  });
  if (referenceCount > 0) return;
  await fs.unlink(path.join(uploadDirectory, oldImage)).catch((error) => {
    if (error.code !== "ENOENT") throw error;
  });
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
      return res.status(500).send({ error: "Unable to upload image" });
    }
  },

  // Creates  with the current contract.
  create: async (req, res) => {
    const data = validateFood(req.body);
    if (data.error) return res.status(400).send({ error: data.error });

    try {
      if (!(await activeCategoryExists(prisma, data.foodTypeId))) {
        return res.status(404).send({ error: "Food category not found" });
      }
      await prisma.food.create({ data: { ...data, status: "use" } });
      return res.status(201).send({ message: "success" });
    } catch (error) {
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
    const id = positiveInteger(req.params.id);
    if (!id)
      return res.status(400).send({ error: "Valid food id is required" });

    try {
      const food = await prisma.food.findFirst({
        where: { id, status: "use" },
        select: { id: true },
      });
      if (!food) return res.status(404).send({ error: "Food not found" });
      await prisma.food.update({ where: { id }, data: { status: "delete" } });
      return res.send({ message: "success" });
    } catch (error) {
      if (sendKnownError(res, error)) return;
      return res.status(500).send({ error: "Unable to remove food" });
    }
  },

  // Updates  without changing user-visible behavior.
  update: async (req, res) => {
    const id = positiveInteger(req.body?.id);
    const data = validateFood(req.body);
    if (!id || data.error)
      return res
        .status(400)
        .send({ error: !id ? "Valid food id is required" : data.error });

    try {
      const food = await prisma.food.findFirst({
        where: { id, status: "use" },
      });
      if (!food) return res.status(404).send({ error: "Food not found" });
      if (!(await activeCategoryExists(prisma, data.foodTypeId))) {
        return res.status(404).send({ error: "Food category not found" });
      }

      await prisma.food.update({ where: { id }, data });
      for (const image of new Set([food.img, food.detailImg])) {
        await removeUnreferencedImage(image);
      }
      return res.send({ message: "success" });
    } catch (error) {
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
