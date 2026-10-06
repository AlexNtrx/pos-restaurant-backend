const { ReceiptReadError } = require("./receipt-read-error");
const prisma = require("./prisma");
const {
  counterOrderPrebill,
  draftBillLines,
  quoteCounterDraft,
} = require("./order-service");
const actorFor = (req) => ({
  type: "STAFF",
  userId: req.user.id,
  level: req.user.level,
});
async function options(context) {
  const foodId = Number(context.params.foodId);
  if (!Number.isSafeInteger(foodId) || foodId <= 0)
    throw new ReceiptReadError(400, { error: "Invalid foodId" });
  const food = await prisma.food.findFirst({
    where: { id: foodId, status: "use" },
    include: {
      FoodType: {
        include: {
          tastes: { where: { status: "use" } },
          foodSizes: { where: { status: "use" } },
        },
      },
    },
  });
  if (!food || food.FoodType.status !== "use")
    throw new ReceiptReadError(404, { error: "Food unavailable" });
  return {
    results: {
      tastes: food.FoodType.tastes.map(({ id, name }) => ({ id, name })),
      foodSizes: food.FoodType.foodSizes.map(({ id, name, moneyAdded }) => ({
        id,
        name,
        moneyAdded,
      })),
    },
  };
}
async function prebill(context) {
  const organization = await prisma.organization.findFirst();
  if (!organization)
    throw new ReceiptReadError(409, {
      error: "Organization is not configured",
    });
  const { snapshot } = await quoteCounterDraft(prisma, context.body);
  return {
    organization: organization,
    receipt: {
      title: "Esilasku",
      cashierName: context.user.name,
      tableNo: snapshot.tableNo,
      serviceType: snapshot.serviceType ?? "DINE_IN",
      date: new Date(),
      lines: draftBillLines(snapshot),
      amount: snapshot.total,
      inputMoney: null,
      returnMoney: null,
      payType: null,
    },
    filename:
      snapshot.serviceType === "TAKEAWAY"
        ? "bill-preview-takeaway.pdf"
        : `bill-preview-table-${snapshot.tableNo}.pdf`,
  };
}
async function sentPrebill(context) {
  const order = await counterOrderPrebill(prisma, {
    actor: actorFor(context),
    orderId: Number(context.params.id),
  });
  const organization = await prisma.organization.findFirst();
  if (!organization)
    throw new ReceiptReadError(409, {
      error: "Organization is not configured",
    });
  return {
    organization: organization,
    receipt: {
      title: "Esilasku",
      cashierName: context.user.name,
      tableNo: order.tableNo,
      serviceType: order.serviceType,
      pickupNo: order.serviceType === "TAKEAWAY" ? order.id : null,
      date: order.submittedAt,
      lines: order.lines,
      amount: order.total,
      inputMoney: null,
      returnMoney: null,
      payType: null,
    },
    filename: `bill-preview-order-${order.id}.pdf`,
  };
}
module.exports = { options, prebill, sentPrebill };
