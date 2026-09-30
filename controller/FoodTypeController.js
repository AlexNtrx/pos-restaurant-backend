const { Prisma } = require("@prisma/client");
const prisma = require("../lib/prisma");
const { positiveInteger } = require("../lib/catalog-validation");

// Validates food-type fields before persistence.
const validateFields = (body) => {
  const name = typeof body?.name === "string" ? body.name.trim() : "";
  const remark = typeof body?.remark === "string" ? body.remark.trim() : "";
  if (!name || name.length > 100)
    return { error: "Name must be 1-100 characters" };
  if (remark.length > 500)
    return { error: "Remark must be at most 500 characters" };
  return { name, remark };
};

// Coordinates active name exists behavior for this module.
const activeNameExists = (client, name, excludeId) =>
  client.foodType.findFirst({
    where: {
      name,
      status: "use",
      ...(excludeId ? { id: { not: excludeId } } : {}),
    },
    select: { id: true },
  });

// Coordinates send known error behavior for this module.
const sendKnownError = (res, error) => {
  if (error?.code === "P2002") {
    res.status(409).send({ error: "Food category name is already in use" });
    return true;
  }
  if (error?.code === "P2034") {
    res.status(409).send({ error: "Category change conflicted; try again" });
    return true;
  }
  return false;
};

module.exports = {
  // Creates  with the current contract.
  create: async (req, res) => {
    const data = validateFields(req.body);
    if (data.error) return res.status(400).send({ error: data.error });
    try {
      if (await activeNameExists(prisma, data.name)) {
        return res
          .status(409)
          .send({ error: "Food category name is already in use" });
      }
      await prisma.foodType.create({ data: { ...data, status: "use" } });
      return res.status(201).send({ message: "success" });
    } catch (error) {
      if (sendKnownError(res, error)) return;
      return res.status(500).send({ error: "Unable to create food category" });
    }
  },

  // Coordinates list behavior for this module.
  list: async (_req, res) => {
    try {
      const rows = await prisma.foodType.findMany({
        where: { status: "use" },
        orderBy: { id: "desc" },
      });
      return res.send({ results: rows });
    } catch {
      return res.status(500).send({ error: "Unable to list food categories" });
    }
  },

  // Updates  without changing user-visible behavior.
  update: async (req, res) => {
    const id = positiveInteger(req.body?.id);
    const data = validateFields(req.body);
    if (!id || data.error)
      return res.status(400).send({
        error: !id ? "Valid food category id is required" : data.error,
      });
    try {
      const category = await prisma.foodType.findFirst({
        where: { id, status: "use" },
        select: { id: true },
      });
      if (!category)
        return res.status(404).send({ error: "Food category not found" });
      if (await activeNameExists(prisma, data.name, id)) {
        return res
          .status(409)
          .send({ error: "Food category name is already in use" });
      }
      await prisma.foodType.update({ where: { id }, data });
      return res.send({ message: "success" });
    } catch (error) {
      if (sendKnownError(res, error)) return;
      return res.status(500).send({ error: "Unable to update food category" });
    }
  },

  // Removes or clears  using the existing workflow.
  remove: async (req, res) => {
    const id = positiveInteger(req.params.id);
    if (!id)
      return res
        .status(400)
        .send({ error: "Valid food category id is required" });
    try {
      const result = await prisma.$transaction(
        async (tx) => {
          const category = await tx.foodType.findFirst({
            where: { id, status: "use" },
            select: { id: true },
          });
          if (!category)
            return { status: 404, error: "Food category not found" };
          const [foodCount, sizeCount, tasteCount] = await Promise.all([
            tx.food.count({ where: { foodTypeId: id, status: "use" } }),
            tx.foodSize.count({ where: { foodTypeId: id, status: "use" } }),
            tx.taste.count({ where: { foodTypeId: id, status: "use" } }),
          ]);
          if (foodCount || sizeCount || tasteCount) {
            return {
              status: 409,
              error:
                "Cannot remove a category with active foods, sizes, or tastes",
            };
          }
          await tx.foodType.update({
            where: { id },
            data: { status: "delete" },
          });
          return null;
        },
        { isolationLevel: Prisma.TransactionIsolationLevel.Serializable },
      );
      if (result)
        return res.status(result.status).send({ error: result.error });
      return res.send({ message: "success" });
    } catch (error) {
      if (sendKnownError(res, error)) return;
      return res.status(500).send({ error: "Unable to remove food category" });
    }
  },
};
