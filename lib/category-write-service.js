const { CatalogWriteError } = require("./catalog-write-error");
const { Prisma } = require("@prisma/client");
const prisma = require("./prisma");
const { positiveInteger } = require("./catalog-validation");
const { validateCategory } = require("./catalog-input");
const activeNameExists = (client, name, excludeId) =>
  client.foodType.findFirst({
    where: {
      name,
      status: "use",
      ...(excludeId ? { id: { not: excludeId } } : {}),
    },
    select: { id: true },
  });
async function create(context) {
  const data = validateCategory(context.body);
  if (data.error) throw new CatalogWriteError(400, { error: data.error });

  if (await activeNameExists(prisma, data.name)) {
    throw new CatalogWriteError(409, {
      error: "Food category name is already in use",
    });
  }
  await prisma.foodType.create({ data: { ...data, status: "use" } });
  return { message: "success" };
}
async function update(context) {
  const id = positiveInteger(context.body?.id);
  const data = validateCategory(context.body);
  if (!id || data.error)
    throw new CatalogWriteError(400, {
      error: !id ? "Valid food category id is required" : data.error,
    });

  const category = await prisma.foodType.findFirst({
    where: { id, status: "use" },
    select: { id: true },
  });
  if (!category)
    throw new CatalogWriteError(404, { error: "Food category not found" });
  if (await activeNameExists(prisma, data.name, id)) {
    throw new CatalogWriteError(409, {
      error: "Food category name is already in use",
    });
  }
  await prisma.foodType.update({ where: { id }, data });
  return { message: "success" };
}
async function remove(context) {
  const id = positiveInteger(context.params.id);
  if (!id)
    throw new CatalogWriteError(400, {
      error: "Valid food category id is required",
    });

  const result = await prisma.$transaction(
    async (tx) => {
      const category = await tx.foodType.findFirst({
        where: { id, status: "use" },
        select: { id: true },
      });
      if (!category) return { status: 404, error: "Food category not found" };
      const [foodCount, sizeCount, tasteCount] = await Promise.all([
        tx.food.count({ where: { foodTypeId: id, status: "use" } }),
        tx.foodSize.count({ where: { foodTypeId: id, status: "use" } }),
        tx.taste.count({ where: { foodTypeId: id, status: "use" } }),
      ]);
      if (foodCount || sizeCount || tasteCount) {
        return {
          status: 409,
          error: "Cannot remove a category with active foods, sizes, or tastes",
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
    throw new CatalogWriteError(result.status, { error: result.error });
  return { message: "success" };
}
module.exports = { create, update, remove };
