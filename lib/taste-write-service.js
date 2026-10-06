const { CatalogWriteError } = require("./catalog-write-error");
const { Prisma } = require("@prisma/client");
const prisma = require("./prisma");
const {
  positiveInteger,
  activeCategoryExists,
} = require("./catalog-validation");
const { validateTaste } = require("./catalog-input");
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
const selectedInCart = (client, id) =>
  client.saleTempDetail.count({ where: { tasteId: id } });
async function create(context) {
  const data = validateTaste(context.body);
  if (data.error) throw new CatalogWriteError(400, { error: data.error });

  if (!(await activeCategoryExists(prisma, data.foodTypeId)))
    throw new CatalogWriteError(404, { error: "Food category not found" });
  if (await activeNameExists(prisma, data.foodTypeId, data.name))
    throw new CatalogWriteError(409, {
      error: "Taste name is already in use for this category",
    });
  await prisma.taste.create({ data: { ...data, status: "use" } });
  return { message: "success" };
}
async function remove(context) {
  const id = positiveInteger(context.params.id);
  if (!id)
    throw new CatalogWriteError(400, { error: "Valid taste id is required" });

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
    throw new CatalogWriteError(result.status, { error: result.error });
  return { message: "success" };
}
async function update(context) {
  const id = positiveInteger(context.body?.id);
  const data = validateTaste(context.body);
  if (!id || data.error)
    throw new CatalogWriteError(400, {
      error: !id ? "Valid taste id is required" : data.error,
    });

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
    throw new CatalogWriteError(result.status, { error: result.error });
  return { message: "success" };
}
module.exports = { create, update, remove };
