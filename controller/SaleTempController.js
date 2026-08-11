const prisma = require("../lib/prisma");
const { createHash } = require("node:crypto");
const { sendReceiptPdf } = require("../lib/receipt-pdf");

// Coordinates positive integer behavior for this module.
const positiveInteger = (value) => {
  const parsed = Number(value);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : null;
};

// Coordinates send unexpected error behavior for this module.
const sendUnexpectedError = (res, error) => {
  console.error(error);
  return res.status(500).send({ error: "Internal server error" });
};

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

class CheckoutError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

const CHECKOUT_KEY_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const PAYMENT_TYPES = new Set(["cash", "bank"]);

// Coordinates checkout fingerprint while preserving transaction behavior.
const checkoutFingerprint = ({ tableNo, payType, inputMoney }) =>
  createHash("sha256")
    .update(
      JSON.stringify({ tableNo, payType, inputMoney: inputMoney ?? null }),
    )
    .digest("hex");

// Coordinates load checkout snapshot while preserving transaction behavior.
const loadCheckoutSnapshot = async (client, userId, tableNo) => {
  const carts = await client.saleTemp.findMany({
    where: { userId, tableNo },
    include: {
      Food: true,
      saleTempDetails: {
        include: { FoodSize: true, Taste: true },
        orderBy: { id: "asc" },
      },
    },
    orderBy: { id: "asc" },
  });

  if (carts.length === 0) throw new CheckoutError(409, "Cart is empty");

  const lines = [];
  for (const cart of carts) {
    if (
      cart.Food.status !== "use" ||
      cart.saleTempDetails.length !== cart.qty
    ) {
      throw new CheckoutError(409, "Cart changed; refresh before checkout");
    }

    for (const detail of cart.saleTempDetails) {
      const size = detail.FoodSize;
      const taste = detail.Taste;
      if (
        (size &&
          (size.status !== "use" ||
            size.foodTypeId !== cart.Food.foodTypeId)) ||
        (taste &&
          (taste.status !== "use" || taste.foodTypeId !== cart.Food.foodTypeId))
      ) {
        throw new CheckoutError(
          409,
          "Cart options changed; refresh before checkout",
        );
      }

      lines.push({
        foodId: cart.Food.id,
        foodSizeId: size?.id ?? null,
        tastedId: taste?.id ?? null,
        foodName: cart.Food.name,
        foodSizeName: size?.name ?? null,
        tasteName: taste?.name ?? null,
        price: cart.Food.price,
        moneyAdded: size?.moneyAdded ?? 0,
      });
    }
  }

  const amount = lines.reduce(
    (sum, line) => sum + line.price + line.moneyAdded,
    0,
  );
  if (!Number.isSafeInteger(amount) || amount < 0) {
    throw new CheckoutError(409, "Cart total is invalid");
  }

  return { carts, lines, amount };
};

// Coordinates completed checkout response while preserving transaction behavior.
const completedCheckoutResponse = (bill, replayed = false) => ({
  message: "success",
  billId: bill.id,
  amount: bill.amount,
  inputMoney: bill.inputMoney,
  returnMoney: bill.returnMoney,
  replayed,
});

module.exports = {
  // Creates  with the current contract.
  create: async (req, res) => {
    try {
      const tableNo = positiveInteger(req.body.tableNo);
      const foodId = positiveInteger(req.body.foodId);
      if (!tableNo || !foodId) {
        return res
          .status(400)
          .send({ error: "tableNo and foodId must be positive integers" });
      }

      const food = await prisma.food.findFirst({
        where: { id: foodId, status: "use" },
      });
      if (!food) return res.status(404).send({ error: "Food not found" });

      await prisma.$transaction(async (tx) => {
        const cart = await tx.saleTemp.upsert({
          where: {
            userId_tableNo_foodId: { userId: req.user.id, tableNo, foodId },
          },
          create: { userId: req.user.id, tableNo, foodId, qty: 1 },
          update: { qty: { increment: 1 } },
        });
        await syncCartDetails(tx, cart, cart.qty);
      });
      return res.send({ message: "success" });
    } catch (e) {
      return sendUnexpectedError(res, e);
    }
  },
  // Coordinates list behavior for this module.
  list: async (req, res) => {
    try {
      const tableNo = positiveInteger(req.query.tableNo);
      if (!tableNo)
        return res
          .status(400)
          .send({ error: "tableNo must be a positive integer" });
      const saleTemps = await prisma.saleTemp.findMany({
        where: { userId: req.user.id, tableNo },
        include: cartInclude,
        orderBy: {
          id: "desc",
        },
      });
      return res.send(addPricing(saleTemps));
    } catch (e) {
      return sendUnexpectedError(res, e);
    }
  },
  // Removes or clears  using the existing workflow.
  remove: async (req, res) => {
    try {
      const saleTempId = positiveInteger(req.params.id);
      if (!saleTempId)
        return res.status(400).send({ error: "id must be a positive integer" });
      const cart = await findOwnedCart(prisma, req.user.id, saleTempId);
      if (!cart) return res.status(404).send({ error: "Cart item not found" });
      await prisma.$transaction(async (tx) => {
        await tx.saleTempDetail.deleteMany({ where: { saleTempId } });
        await tx.saleTemp.delete({ where: { id: saleTempId } });
      });
      return res.send({ message: "success" });
    } catch (e) {
      return sendUnexpectedError(res, e);
    }
  },
  // Removes or clears all using the existing workflow.
  removeAll: async (req, res) => {
    try {
      const tableNo = positiveInteger(req.body.tableNo);
      if (!tableNo)
        return res
          .status(400)
          .send({ error: "tableNo must be a positive integer" });
      await prisma.$transaction(async (tx) => {
        await tx.saleTempDetail.deleteMany({
          where: { SaleTemp: { userId: req.user.id, tableNo } },
        });
        await tx.saleTemp.deleteMany({
          where: { userId: req.user.id, tableNo },
        });
      });
      return res.send({ message: "success" });
    } catch (e) {
      return sendUnexpectedError(res, e);
    }
  },
  // Updates qty without changing user-visible behavior.
  updateQty: async (req, res) => {
    try {
      const qty = positiveInteger(req.body.qty);
      const id = positiveInteger(req.body.id);
      if (!qty || !id)
        return res
          .status(400)
          .send({ error: "id and qty must be positive integers" });
      const cart = await findOwnedCart(prisma, req.user.id, id);
      if (!cart) return res.status(404).send({ error: "Cart item not found" });
      await prisma.$transaction((tx) => syncCartDetails(tx, cart, qty));
      return res.send({ message: "success" });
    } catch (e) {
      return sendUnexpectedError(res, e);
    }
  },
  // Coordinates generate sale temp detail behavior for this module.
  generateSaleTempDetail: async (req, res) => {
    try {
      const id = positiveInteger(req.body.saleTempId);
      if (!id)
        return res
          .status(400)
          .send({ error: "saleTempId must be a positive integer" });
      const saleTemp = await findOwnedCart(prisma, req.user.id, id);
      if (!saleTemp)
        return res.status(404).send({ error: "Cart item not found" });
      await prisma.$transaction((tx) =>
        syncCartDetails(tx, saleTemp, saleTemp.qty),
      );
      return res.send({ message: "success" });
    } catch (e) {
      return sendUnexpectedError(res, e);
    }
  },
  // Coordinates info behavior for this module.
  info: async (req, res) => {
    try {
      const id = positiveInteger(req.params.id);
      if (!id)
        return res.status(400).send({ error: "id must be a positive integer" });
      const saleTemp = await findOwnedCart(prisma, req.user.id, id, {
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
        return res.status(404).send({ error: "Cart item not found" });
      }

      return res.send({ results: saleTemp });
    } catch (e) {
      return sendUnexpectedError(res, e);
    }
  },
  // Updates taste without changing user-visible behavior.
  selectTaste: async (req, res) => {
    try {
      const detailId = positiveInteger(req.body.saleTempDetailId);
      const tasteId = positiveInteger(req.body.tasteId);
      if (!detailId || !tasteId)
        return res.status(400).send({
          error: "saleTempDetailId and tasteId must be positive integers",
        });
      const detail = await findOwnedDetail(prisma, req.user.id, detailId);
      if (!detail)
        return res.status(404).send({ error: "Cart detail not found" });
      const taste = await prisma.taste.findFirst({
        where: {
          id: tasteId,
          status: "use",
          foodTypeId: detail.SaleTemp.Food.foodTypeId,
        },
      });
      if (!taste)
        return res
          .status(400)
          .send({ error: "Taste is not available for this food" });
      await prisma.saleTempDetail.update({
        where: { id: detailId },
        data: { tasteId },
      });
      return res.send({ message: "success" });
    } catch (e) {
      return sendUnexpectedError(res, e);
    }
  },
  // Coordinates un select taste behavior for this module.
  unSelectTaste: async (req, res) => {
    try {
      const detailId = positiveInteger(req.body.saleTempDetailId);
      if (!detailId)
        return res
          .status(400)
          .send({ error: "saleTempDetailId must be a positive integer" });
      const detail = await findOwnedDetail(prisma, req.user.id, detailId);
      if (!detail)
        return res.status(404).send({ error: "Cart detail not found" });
      await prisma.saleTempDetail.update({
        where: { id: detailId },
        data: { tasteId: null },
      });
      return res.send({ message: "success" });
    } catch (e) {
      return sendUnexpectedError(res, e);
    }
  },
  // Updates size without changing user-visible behavior.
  selectSize: async (req, res) => {
    try {
      const detailId = positiveInteger(req.body.saleTempDetailId);
      const sizeId =
        req.body.sizeId == null ? null : positiveInteger(req.body.sizeId);
      if (!detailId || (req.body.sizeId != null && !sizeId))
        return res
          .status(400)
          .send({ error: "Invalid saleTempDetailId or sizeId" });
      const detail = await findOwnedDetail(prisma, req.user.id, detailId);
      if (!detail)
        return res.status(404).send({ error: "Cart detail not found" });
      if (sizeId) {
        const size = await prisma.foodSize.findFirst({
          where: {
            id: sizeId,
            status: "use",
            foodTypeId: detail.SaleTemp.Food.foodTypeId,
          },
        });
        if (!size)
          return res
            .status(400)
            .send({ error: "Size is not available for this food" });
      }
      await prisma.saleTempDetail.update({
        where: { id: detailId },
        data: { foodSizeId: sizeId },
      });
      return res.send({ message: "success" });
    } catch (e) {
      return sendUnexpectedError(res, e);
    }
  },
  // Creates sale temp detail with the current contract.
  createSaleTempDetail: async (req, res) => {
    try {
      const saleTempId = positiveInteger(req.body.saleTempId);
      if (!saleTempId)
        return res
          .status(400)
          .send({ error: "saleTempId must be a positive integer" });
      const cart = await findOwnedCart(prisma, req.user.id, saleTempId);
      if (!cart) return res.status(404).send({ error: "Cart item not found" });
      await prisma.$transaction((tx) =>
        syncCartDetails(tx, cart, cart.qty + 1),
      );
      return res.send({ message: "success" });
    } catch (e) {
      return sendUnexpectedError(res, e);
    }
  },
  // Removes or clears sale temp detail modal using the existing workflow.
  removeSaleTempDetailModal: async (req, res) => {
    try {
      const detailId = positiveInteger(req.body.saleTempDetailId);
      if (!detailId)
        return res
          .status(400)
          .send({ error: "saleTempDetailId must be a positive integer" });
      const detail = await findOwnedDetail(prisma, req.user.id, detailId);
      if (!detail)
        return res.status(404).send({ error: "Cart detail not found" });
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
      return res.send({ message: "success" });
    } catch (e) {
      return sendUnexpectedError(res, e);
    }
  },
  // Coordinates print bill after pay behavior for this module.
  printBillAfterPay: async (req, res) => {
    try {
      const billId = positiveInteger(req.body.billId);
      if (!billId)
        return res
          .status(400)
          .send({ error: "billId must be a positive integer" });

      const organization = await prisma.organization.findFirst();
      if (!organization)
        return res
          .status(409)
          .send({ error: "Organization is not configured" });

      const billSale = await prisma.billSale.findFirst({
        where: {
          id: billId,
          ...(req.user.level === "admin" ? {} : { userId: req.user.id }),
        },
        include: {
          BillSaleDetails: { orderBy: { id: "asc" } },
        },
      });
      if (!billSale) return res.status(404).send({ error: "Bill not found" });

      return await sendReceiptPdf(
        res,
        organization,
        {
          title: "Bill",
          billId: billSale.id,
          tableNo: billSale.tableNo,
          date: billSale.payDate,
          lines: billSale.BillSaleDetails,
          amount: billSale.amount,
          inputMoney: billSale.inputMoney,
          returnMoney: billSale.returnMoney,
          payType: billSale.payType,
        },
        `bill-${billSale.id}.pdf`,
      );
    } catch (e) {
      return sendUnexpectedError(res, e);
    }
  },
  // Coordinates print bill before pay behavior for this module.
  printBillBeforePay: async (req, res) => {
    try {
      const tableNo = positiveInteger(req.body.tableNo);
      if (!tableNo)
        return res
          .status(400)
          .send({ error: "tableNo must be a positive integer" });

      const organization = await prisma.organization.findFirst();
      if (!organization)
        return res
          .status(409)
          .send({ error: "Organization is not configured" });
      const snapshot = await loadCheckoutSnapshot(prisma, req.user.id, tableNo);

      return await sendReceiptPdf(
        res,
        organization,
        {
          title: "Bill Preview",
          tableNo,
          date: new Date(),
          lines: snapshot.lines,
          amount: snapshot.amount,
          inputMoney: null,
          returnMoney: null,
          payType: null,
        },
        `bill-preview-table-${tableNo}.pdf`,
      );
    } catch (e) {
      if (e instanceof CheckoutError)
        return res.status(e.status).send({ error: e.message });
      return sendUnexpectedError(res, e);
    }
  },
  // Coordinates end sale behavior for this module.
  endSale: async (req, res) => {
    try {
      const tableNo = positiveInteger(req.body.tableNo);
      const payType = req.body.payType;
      const idempotencyKey = req.body.idempotencyKey;
      if (!tableNo)
        return res
          .status(400)
          .send({ error: "tableNo must be a positive integer" });
      if (!PAYMENT_TYPES.has(payType))
        return res.status(400).send({ error: "payType must be cash or bank" });
      if (
        typeof idempotencyKey !== "string" ||
        !CHECKOUT_KEY_PATTERN.test(idempotencyKey)
      ) {
        return res.status(400).send({ error: "idempotencyKey must be a UUID" });
      }

      let requestedInputMoney = null;
      if (payType === "cash") {
        requestedInputMoney = Number(req.body.inputMoney);
        if (
          !Number.isSafeInteger(requestedInputMoney) ||
          requestedInputMoney < 0
        ) {
          return res
            .status(400)
            .send({ error: "inputMoney must be a non-negative integer" });
        }
      }

      const fingerprint = checkoutFingerprint({
        tableNo,
        payType,
        inputMoney: requestedInputMoney,
      });

      // Coordinates execute checkout while preserving transaction behavior.
      const executeCheckout = () =>
        prisma.$transaction(
          async (tx) => {
            await tx.$executeRaw`SELECT pg_advisory_xact_lock(${req.user.id}::int, ${tableNo}::int)`;
            const existing = await tx.billSale.findFirst({
              where: { userId: req.user.id, idempotencyKey },
            });
            if (existing) {
              if (existing.checkoutFingerprint !== fingerprint) {
                throw new CheckoutError(
                  409,
                  "Idempotency key was already used for another checkout",
                );
              }
              return completedCheckoutResponse(existing, true);
            }

            const snapshot = await loadCheckoutSnapshot(
              tx,
              req.user.id,
              tableNo,
            );
            const inputMoney =
              payType === "bank" ? snapshot.amount : requestedInputMoney;
            if (inputMoney < snapshot.amount) {
              throw new CheckoutError(
                400,
                "Received amount is less than the total",
              );
            }
            const returnMoney =
              payType === "bank" ? 0 : inputMoney - snapshot.amount;

            const bill = await tx.billSale.create({
              data: {
                amount: snapshot.amount,
                inputMoney,
                returnMoney,
                payType,
                tableNo,
                userId: req.user.id,
                idempotencyKey,
                checkoutFingerprint: fingerprint,
                BillSaleDetails: { create: snapshot.lines },
              },
            });

            const cartIds = snapshot.carts.map(({ id }) => id);
            await tx.saleTempDetail.deleteMany({
              where: { saleTempId: { in: cartIds } },
            });
            await tx.saleTemp.deleteMany({
              where: { id: { in: cartIds }, userId: req.user.id, tableNo },
            });
            return completedCheckoutResponse(bill);
          },
          { isolationLevel: "Serializable" },
        );

      for (let attempt = 0; attempt < 3; attempt += 1) {
        try {
          return res.send(await executeCheckout());
        } catch (error) {
          if (error?.code === "P2034" && attempt < 2) continue;
          if (error?.code === "P2002") {
            const existing = await prisma.billSale.findFirst({
              where: { userId: req.user.id, idempotencyKey },
            });
            if (existing?.checkoutFingerprint === fingerprint) {
              return res.send(completedCheckoutResponse(existing, true));
            }
            return res.status(409).send({ error: "Idempotency key conflict" });
          }
          throw error;
        }
      }
    } catch (e) {
      if (e instanceof CheckoutError)
        return res.status(e.status).send({ error: e.message });
      return sendUnexpectedError(res, e);
    }
  },
};
