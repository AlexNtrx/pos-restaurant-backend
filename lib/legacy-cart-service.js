const prisma = require("./prisma");
const { positiveInteger, LegacyCartError } = require("./legacy-checkout-state");
// Coordinates find owned cart behavior for this module.
const findOwnedCart = (client, userId, id, include) =>
  client.saleTemp.findFirst({
    where: { id, userId },
    ...(include ? { include } : {}),
  });

// Coordinates find owned detail behavior for this module.
const findOwnedDetail = (client, userId, id) =>
  client.saleTempDetail.findFirst({
    where: { id, SaleTemp: { userId } },
    include: { SaleTemp: { include: { Food: true } } },
  });

// Coordinates sync cart details behavior for this module.
const syncCartDetails = async (tx, cart, qty) => {
  const details = await tx.saleTempDetail.findMany({
    where: { saleTempId: cart.id },
    orderBy: { id: "desc" },
    select: { id: true },
  });

  if (details.length < qty) {
    await tx.saleTempDetail.createMany({
      data: Array.from({ length: qty - details.length }, () => ({
        saleTempId: cart.id,
        foodId: cart.foodId,
      })),
    });
  } else if (details.length > qty) {
    await tx.saleTempDetail.deleteMany({
      where: {
        id: { in: details.slice(0, details.length - qty).map(({ id }) => id) },
      },
    });
  }

  await tx.saleTemp.update({ where: { id: cart.id }, data: { qty } });
};

const cartInclude = {
  saleTempDetails: {
    include: { Food: true, Taste: true, FoodSize: true },
    orderBy: { id: "asc" },
  },
  Food: true,
};

// Coordinates add pricing behavior for this module.
const addPricing = (saleTemps) => {
  let baseAmount = 0;
  let addedAmount = 0;

  const results = saleTemps.map((item) => {
    const lineBaseAmount = item.Food.price * item.qty;
    const lineAddedAmount = item.saleTempDetails.reduce((sum, detail) => {
      const size = detail.FoodSize;
      const isValidSize =
        size?.status === "use" && size.foodTypeId === item.Food.foodTypeId;
      return sum + (isValidSize ? size.moneyAdded : 0);
    }, 0);

    baseAmount += lineBaseAmount;
    addedAmount += lineAddedAmount;
    return {
      ...item,
      pricing: {
        baseAmount: lineBaseAmount,
        addedAmount: lineAddedAmount,
        total: lineBaseAmount + lineAddedAmount,
      },
    };
  });

  return {
    results,
    summary: { baseAmount, addedAmount, total: baseAmount + addedAmount },
  };
};

const create = async (request) => {
  const tableNo = positiveInteger(request.body.tableNo);
  const foodId = positiveInteger(request.body.foodId);
  if (!tableNo || !foodId) {
    throw new LegacyCartError(400, {
      error: "tableNo and foodId must be positive integers",
    });
  }

  const food = await prisma.food.findFirst({
    where: { id: foodId, status: "use" },
  });
  if (!food) throw new LegacyCartError(404, { error: "Food not found" });

  await prisma.$transaction(async (tx) => {
    const cart = await tx.saleTemp.upsert({
      where: {
        userId_tableNo_foodId: { userId: request.user.id, tableNo, foodId },
      },
      create: { userId: request.user.id, tableNo, foodId, qty: 1 },
      update: { qty: { increment: 1 } },
    });
    await syncCartDetails(tx, cart, cart.qty);
  });
  return { message: "success" };
};
const list = async (request) => {
  const tableNo = positiveInteger(request.query.tableNo);
  if (!tableNo)
    throw new LegacyCartError(400, {
      error: "tableNo must be a positive integer",
    });
  const saleTemps = await prisma.saleTemp.findMany({
    where: { userId: request.user.id, tableNo },
    include: cartInclude,
    orderBy: {
      id: "desc",
    },
  });
  return addPricing(saleTemps);
};
const remove = async (request) => {
  const saleTempId = positiveInteger(request.params.id);
  if (!saleTempId)
    throw new LegacyCartError(400, {
      error: "id must be a positive integer",
    });
  const cart = await findOwnedCart(prisma, request.user.id, saleTempId);
  if (!cart) throw new LegacyCartError(404, { error: "Cart item not found" });
  await prisma.$transaction(async (tx) => {
    await tx.saleTempDetail.deleteMany({ where: { saleTempId } });
    await tx.saleTemp.delete({ where: { id: saleTempId } });
  });
  return { message: "success" };
};
const removeAll = async (request) => {
  const tableNo = positiveInteger(request.body.tableNo);
  if (!tableNo)
    throw new LegacyCartError(400, {
      error: "tableNo must be a positive integer",
    });
  await prisma.$transaction(async (tx) => {
    await tx.saleTempDetail.deleteMany({
      where: { SaleTemp: { userId: request.user.id, tableNo } },
    });
    await tx.saleTemp.deleteMany({
      where: { userId: request.user.id, tableNo },
    });
  });
  return { message: "success" };
};
const updateQty = async (request) => {
  const qty = positiveInteger(request.body.qty);
  const id = positiveInteger(request.body.id);
  if (!qty || !id)
    throw new LegacyCartError(400, {
      error: "id and qty must be positive integers",
    });
  const cart = await findOwnedCart(prisma, request.user.id, id);
  if (!cart) throw new LegacyCartError(404, { error: "Cart item not found" });
  await prisma.$transaction((tx) => syncCartDetails(tx, cart, qty));
  return { message: "success" };
};
const generateSaleTempDetail = async (request) => {
  const id = positiveInteger(request.body.saleTempId);
  if (!id)
    throw new LegacyCartError(400, {
      error: "saleTempId must be a positive integer",
    });
  const saleTemp = await findOwnedCart(prisma, request.user.id, id);
  if (!saleTemp)
    throw new LegacyCartError(404, { error: "Cart item not found" });
  await prisma.$transaction((tx) =>
    syncCartDetails(tx, saleTemp, saleTemp.qty),
  );
  return { message: "success" };
};
const info = async (request) => {
  const id = positiveInteger(request.params.id);
  if (!id)
    throw new LegacyCartError(400, {
      error: "id must be a positive integer",
    });
  const saleTemp = await findOwnedCart(prisma, request.user.id, id, {
    Food: {
      include: {
        FoodType: {
          include: {
            tastes: {
              where: { status: "use" },
            },
            foodSizes: {
              where: { status: "use" },
              orderBy: { moneyAdded: "asc" },
            },
          },
        },
      },
    },
    saleTempDetails: {
      include: { Food: true, FoodSize: true },
      orderBy: { id: "asc" },
    },
  });

  if (!saleTemp) {
    throw new LegacyCartError(404, { error: "Cart item not found" });
  }

  return { results: saleTemp };
};
const selectTaste = async (request) => {
  const detailId = positiveInteger(request.body.saleTempDetailId);
  const tasteId = positiveInteger(request.body.tasteId);
  if (!detailId || !tasteId)
    throw new LegacyCartError(400, {
      error: "saleTempDetailId and tasteId must be positive integers",
    });
  const detail = await findOwnedDetail(prisma, request.user.id, detailId);
  if (!detail)
    throw new LegacyCartError(404, { error: "Cart detail not found" });
  const taste = await prisma.taste.findFirst({
    where: {
      id: tasteId,
      status: "use",
      foodTypeId: detail.SaleTemp.Food.foodTypeId,
    },
  });
  if (!taste)
    throw new LegacyCartError(400, {
      error: "Taste is not available for this food",
    });
  await prisma.saleTempDetail.update({
    where: { id: detailId },
    data: { tasteId },
  });
  return { message: "success" };
};
const unSelectTaste = async (request) => {
  const detailId = positiveInteger(request.body.saleTempDetailId);
  if (!detailId)
    throw new LegacyCartError(400, {
      error: "saleTempDetailId must be a positive integer",
    });
  const detail = await findOwnedDetail(prisma, request.user.id, detailId);
  if (!detail)
    throw new LegacyCartError(404, { error: "Cart detail not found" });
  await prisma.saleTempDetail.update({
    where: { id: detailId },
    data: { tasteId: null },
  });
  return { message: "success" };
};
const selectSize = async (request) => {
  const detailId = positiveInteger(request.body.saleTempDetailId);
  const sizeId =
    request.body.sizeId == null ? null : positiveInteger(request.body.sizeId);
  if (!detailId || (request.body.sizeId != null && !sizeId))
    throw new LegacyCartError(400, {
      error: "Invalid saleTempDetailId or sizeId",
    });
  const detail = await findOwnedDetail(prisma, request.user.id, detailId);
  if (!detail)
    throw new LegacyCartError(404, { error: "Cart detail not found" });
  if (sizeId) {
    const size = await prisma.foodSize.findFirst({
      where: {
        id: sizeId,
        status: "use",
        foodTypeId: detail.SaleTemp.Food.foodTypeId,
      },
    });
    if (!size)
      throw new LegacyCartError(400, {
        error: "Size is not available for this food",
      });
  }
  await prisma.saleTempDetail.update({
    where: { id: detailId },
    data: { foodSizeId: sizeId },
  });
  return { message: "success" };
};
const createSaleTempDetail = async (request) => {
  const saleTempId = positiveInteger(request.body.saleTempId);
  if (!saleTempId)
    throw new LegacyCartError(400, {
      error: "saleTempId must be a positive integer",
    });
  const cart = await findOwnedCart(prisma, request.user.id, saleTempId);
  if (!cart) throw new LegacyCartError(404, { error: "Cart item not found" });
  await prisma.$transaction((tx) => syncCartDetails(tx, cart, cart.qty + 1));
  return { message: "success" };
};
const removeSaleTempDetailModal = async (request) => {
  const detailId = positiveInteger(request.body.saleTempDetailId);
  if (!detailId)
    throw new LegacyCartError(400, {
      error: "saleTempDetailId must be a positive integer",
    });
  const detail = await findOwnedDetail(prisma, request.user.id, detailId);
  if (!detail)
    throw new LegacyCartError(404, { error: "Cart detail not found" });
  await prisma.$transaction(async (tx) => {
    await tx.saleTempDetail.delete({ where: { id: detailId } });
    const remaining = await tx.saleTempDetail.count({
      where: { saleTempId: detail.saleTempId },
    });
    if (remaining === 0) {
      await tx.saleTemp.delete({ where: { id: detail.saleTempId } });
    } else {
      await tx.saleTemp.update({
        where: { id: detail.saleTempId },
        data: { qty: remaining },
      });
    }
  });
  return { message: "success" };
};
module.exports = {
  create,
  list,
  remove,
  removeAll,
  updateQty,
  generateSaleTempDetail,
  info,
  selectTaste,
  unSelectTaste,
  selectSize,
  createSaleTempDetail,
  removeSaleTempDetailModal,
};
