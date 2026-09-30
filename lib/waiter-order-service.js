const { OrderDomainError, assertPositiveInteger } = require("./order-domain");
const { rejectClientFinancialAuthority } = require("./order-pricing");
const { submitOrder } = require("./order-service");
const { staffOrderDto } = require("./staff-order-service");

const waiterMenu = async (prisma) => ({
  categories: await prisma.foodType.findMany({
    where: { status: "use", food: { some: { status: "use" } } },
    orderBy: { id: "asc" },
    select: {
      id: true,
      name: true,
      food: {
        where: { status: "use" },
        orderBy: { id: "asc" },
        select: { id: true, name: true, price: true, foodTypeId: true },
      },
      foodSizes: {
        where: { status: "use" },
        orderBy: { id: "asc" },
        select: { id: true, name: true, moneyAdded: true },
      },
      tastes: {
        where: { status: "use" },
        orderBy: { id: "asc" },
        select: { id: true, name: true },
      },
    },
  }),
});

const normalizeBody = (body) => {
  if (!body || typeof body !== "object" || Array.isArray(body))
    throw new OrderDomainError(400, "INVALID_INPUT", "Invalid order body");
  rejectClientFinancialAuthority(body);
  const { tableSessionId, idempotencyKey, expectedTotal, items, ...extra } =
    body;
  if (Object.keys(extra).length || !Array.isArray(items) || !items.length)
    throw new OrderDomainError(400, "INVALID_INPUT", "Invalid order body");
  if (!Number.isSafeInteger(expectedTotal) || expectedTotal < 0)
    throw new OrderDomainError(400, "INVALID_INPUT", "Invalid quoted total");
  let units = 0;
  for (const item of items) {
    if (!item || typeof item !== "object" || Array.isArray(item))
      throw new OrderDomainError(400, "INVALID_INPUT", "Invalid order item");
    const { foodId, foodSizeId, tasteId, quantity, note, ...itemExtra } = item;
    if (Object.keys(itemExtra).length)
      throw new OrderDomainError(
        400,
        "INVALID_INPUT",
        "Unexpected order item field",
      );
    units += assertPositiveInteger(quantity, "quantity");
    if (units > 200)
      throw new OrderDomainError(
        400,
        "ORDER_TOO_LARGE",
        "Order supports at most 200 units",
      );
  }
  return {
    tableSessionId: assertPositiveInteger(tableSessionId, "tableSessionId"),
    idempotencyKey,
    expectedTotal,
    items,
  };
};

const submitWaiterOrder = async (prisma, { actor, body }) => {
  const { tableSessionId, idempotencyKey, expectedTotal, items } =
    normalizeBody(body);
  const session = await prisma.tableSession.findUnique({
    where: { id: tableSessionId },
    include: { RestaurantTable: true },
  });
  if (
    !session ||
    session.status !== "OPEN" ||
    session.RestaurantTable.status !== "use"
  )
    throw new OrderDomainError(
      409,
      "TABLE_SESSION_INACTIVE",
      "Table session is not open",
    );
  // EN: The table number comes from the active session; the waiter supplies item choices only.
  // FI: Pöydän numero saadaan aktiivisesta istunnosta; tarjoilija antaa vain tuotevalinnat.
  const order = await submitOrder(prisma, {
    actor,
    idempotencyKey,
    expectedTotal,
    confirmForKitchen: true,
    intent: {
      channel: "STAFF",
      tableNo: session.RestaurantTable.tableNo,
      tableSessionId,
      items,
    },
  });
  return staffOrderDto(order, { history: true });
};

module.exports = { waiterMenu, submitWaiterOrder };
