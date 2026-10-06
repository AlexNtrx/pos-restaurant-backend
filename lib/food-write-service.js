const { CatalogWriteError } = require("./catalog-write-error");
const prisma = require("./prisma");
const { cleanupAfterSave } = require("./post-save-cleanup");
const {
  positiveInteger,
  activeCategoryExists,
} = require("./catalog-validation");
const { validateFood, isSafeImageName } = require("./food-validation");
const { removeImageArtifacts } = require("./image-variants");
const path = require("node:path");
// EN: Delete a replaced upload only when neither image field of any food still references it.
// FI: Korvattu kuva poistetaan vain, kun yksikään annos ei enää viittaa siihen kummassakaan kuvakentässä.
const removeUnreferencedImage = async (oldImage) => {
  if (!oldImage || !isSafeImageName(oldImage)) return;
  const referenceCount = await prisma.food.count({
    where: { OR: [{ img: oldImage }, { detailImg: oldImage }] },
  });
  if (referenceCount > 0) return;
  await removeImageArtifacts(uploadDirectory, oldImage);
};
const uploadDirectory = path.resolve("uploads");
async function create(context) {
  const data = validateFood(context.body);
  if (data.error) throw new CatalogWriteError(400, { error: data.error });

  if (!(await activeCategoryExists(prisma, data.foodTypeId))) {
    throw new CatalogWriteError(404, { error: "Food category not found" });
  }
  await prisma.food.create({ data: { ...data, status: "use" } });
  return { message: "success" };
}
async function remove(context) {
  const id = positiveInteger(context.params.id);
  if (!id)
    throw new CatalogWriteError(400, { error: "Valid food id is required" });

  const food = await prisma.food.findFirst({
    where: { id, status: "use" },
    select: { id: true },
  });
  if (!food) throw new CatalogWriteError(404, { error: "Food not found" });
  await prisma.food.update({ where: { id }, data: { status: "delete" } });
  return { message: "success" };
}
async function update(context) {
  const id = positiveInteger(context.body?.id);
  const data = validateFood(context.body);
  if (!id || data.error)
    throw new CatalogWriteError(400, {
      error: !id ? "Valid food id is required" : data.error,
    });

  const food = await prisma.food.findFirst({
    where: { id, status: "use" },
  });
  if (!food) throw new CatalogWriteError(404, { error: "Food not found" });
  if (!(await activeCategoryExists(prisma, data.foodTypeId))) {
    throw new CatalogWriteError(404, { error: "Food category not found" });
  }

  await prisma.food.update({ where: { id }, data });
  for (const image of new Set([food.img, food.detailImg])) {
    await cleanupAfterSave("food", () => removeUnreferencedImage(image));
  }
  return { message: "success" };
}
module.exports = { create, update, remove };
