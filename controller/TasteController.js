const { Prisma } = require("@prisma/client");
const prisma = require("../lib/prisma");

// Coordinates positive integer behavior for this module.
const positiveInteger = (value) => {
  const parsed = Number(value);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : null;
};

// Validates taste fields before persistence.
const validateTaste = (body) => {
  const foodTypeId = positiveInteger(body?.foodTypeId);
  const name = typeof body?.name === "string" ? body.name.trim() : "";
  const remark = typeof body?.remark === "string" ? body.remark.trim() : "";
  if (!foodTypeId) return { error: "foodTypeId must be a positive integer" };
  if (!name || name.length > 100)
    return { error: "Name must be 1-100 characters" };
  if (remark.length > 500)
    return { error: "Remark must be at most 500 characters" };
  return { foodTypeId, name, remark };
};

// Coordinates active category exists behavior for this module.
const activeCategoryExists = (client, id) =>
  client.foodType.findFirst({
    where: { id, status: "use" },
    select: { id: true },
  });
// Coordinates active name exists behavior for this module.
const activeNameExists = (client, foodTypeId, name, excludeId) =>
  client.taste.findFirst({
    where: {
      foodTypeId,
      name,
      status: "use",
      ...(excludeId ? { id: { not: excludeId } } : {}),
    },
    select: { id: true },
  });
// Prevents removing a taste that is still referenced by a cart.
const selectedInCart = (client, id) =>
  client.saleTempDetail.count({ where: { tasteId: id } });

// Coordinates send known error behavior for this module.
const sendKnownError = (res, error) => {
  if (error?.code === "P2002") {
    res
      .status(409)
      .send({ error: "Taste name is already in use for this category" });
    return true;
  }
  if (error?.code === "P2034") {
    res.status(409).send({ error: "Taste change conflicted; try again" });
    return true;
  }
  return false;
};

module.exports = {
  // Creates  with the current contract.
  create: async (req, res) => {
    const data = validateTaste(req.body);
    if (data.error) return res.status(400).send({ error: data.error });
    try {
      if (!(await activeCategoryExists(prisma, data.foodTypeId)))
        return res.status(404).send({ error: "Food category not found" });
      if (await activeNameExists(prisma, data.foodTypeId, data.name))
        return res
          .status(409)
          .send({ error: "Taste name is already in use for this category" });
      await prisma.taste.create({ data: { ...data, status: "use" } });
      return res.status(201).send({ message: "success" });
    } catch (error) {
      if (sendKnownError(res, error)) return;
      return res.status(500).send({ error: "Unable to create taste" });
    }
  },

  // Coordinates list behavior for this module.
  list: async (_req, res) => {
    try {
      return res.send({
        results: await prisma.taste.findMany({
          include: { FoodType: true },
          where: { status: "use" },
          orderBy: { id: "desc" },
        }),
      });
    } catch {
      return res.status(500).send({ error: "Unable to list tastes" });
    }
  },

  // Removes or clears  using the existing workflow.
  remove: async (req, res) => {
    const id = positiveInteger(req.params.id);
    if (!id)
      return res.status(400).send({ error: "Valid taste id is required" });
    try {
      const result = await prisma.$transaction(
        async (tx) => {
          const taste = await tx.taste.findFirst({
            where: { id, status: "use" },
            select: { id: true },
          });
          if (!taste) return { status: 404, error: "Taste not found" };
          if (await selectedInCart(tx, id))
            return {
              status: 409,
              error: "Cannot remove a taste selected in an active cart",
            };
          await tx.taste.update({ where: { id }, data: { status: "delete" } });
          return null;
        },
        { isolationLevel: Prisma.TransactionIsolationLevel.Serializable },
      );
      if (result)
        return res.status(result.status).send({ error: result.error });
      return res.send({ message: "success" });
    } catch (error) {
      if (sendKnownError(res, error)) return;
      return res.status(500).send({ error: "Unable to remove taste" });
    }
  },

  // Updates  without changing user-visible behavior.
  update: async (req, res) => {
    const id = positiveInteger(req.body?.id);
    const data = validateTaste(req.body);
    if (!id || data.error)
      return res
        .status(400)
        .send({ error: !id ? "Valid taste id is required" : data.error });
    try {
      const result = await prisma.$transaction(
        async (tx) => {
          const taste = await tx.taste.findFirst({
            where: { id, status: "use" },
          });
          if (!taste) return { status: 404, error: "Taste not found" };
          if (!(await activeCategoryExists(tx, data.foodTypeId)))
            return { status: 404, error: "Food category not found" };
          if (await activeNameExists(tx, data.foodTypeId, data.name, id))
            return {
              status: 409,
              error: "Taste name is already in use for this category",
            };
          if (
            taste.foodTypeId !== data.foodTypeId &&
            (await selectedInCart(tx, id))
          )
            return {
              status: 409,
              error:
                "Cannot change category for a taste selected in an active cart",
            };
          await tx.taste.update({ where: { id }, data });
          return null;
        },
        { isolationLevel: Prisma.TransactionIsolationLevel.Serializable },
      );
      if (result)
        return res.status(result.status).send({ error: result.error });
      return res.send({ message: "success" });
    } catch (error) {
      if (sendKnownError(res, error)) return;
      return res.status(500).send({ error: "Unable to update taste" });
    }
  },
};
