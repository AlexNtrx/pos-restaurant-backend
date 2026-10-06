const { createHash } = require("node:crypto");
// Coordinates positive integer behavior for this module.
const positiveInteger = (value) => {
  const parsed = Number(value);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : null;
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

class LegacyCartError extends Error {
  constructor(status, body) {
    super(body.error);
    this.status = status;
    this.body = body;
  }
}
module.exports = {
  positiveInteger,
  CheckoutError,
  LegacyCartError,
  loadCheckoutSnapshot,
  completedCheckoutResponse,
  checkoutFingerprint,
  CHECKOUT_KEY_PATTERN,
  PAYMENT_TYPES,
};
