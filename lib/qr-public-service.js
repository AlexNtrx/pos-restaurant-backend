const { OrderDomainError, assertPositiveInteger } = require("./order-domain");
const { rejectClientFinancialAuthority } = require("./order-pricing");
const { submitOrder } = require("./order-service");
const { resolveQrAccess } = require("./table-service");

const validAccess = async (prisma, token) => {
  const access = await resolveQrAccess(prisma, token);
  if (!access)
    throw new OrderDomainError(404, "QR_INVALID", "QR link is unavailable");
  return access;
};

const publicContext = async (prisma, token) => {
  const access = await validAccess(prisma, token);
  const organization = await prisma.organization.findFirst({
    select: { name: true },
  });
  return {
    state: access.state,
    tableNo: access.tableNo,
    restaurantName: organization?.name || "Ravintola",
  };
};

const publicMenu = async (prisma, token) => {
  const access = await validAccess(prisma, token);
  if (access.state === "CLOSED")
    throw new OrderDomainError(409, "QR_ORDERING_CLOSED", "QR menu is closed");
  const categories = await prisma.foodType.findMany({
    where: { status: "use", food: { some: { status: "use" } } },
    orderBy: { id: "asc" },
    select: {
      id: true,
      name: true,
      food: {
        where: { status: "use" },
        orderBy: { id: "asc" },
        select: {
          id: true,
          name: true,
          remark: true,
          price: true,
          img: true,
          detailImg: true,
          foodTypeId: true,
        },
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
  });
  return { state: access.state, tableNo: access.tableNo, categories };
};

// EN: The public body contains identifiers, quantity and a bounded note only; table, channel and money come from the server.
// FI: Julkinen pyyntö sisältää vain tunnisteet, määrän ja rajatun huomautuksen; pöytä, kanava ja rahasummat tulevat palvelimelta.
const normalizePublicBody = (body) => {
  if (!body || typeof body !== "object" || Array.isArray(body))
    throw new OrderDomainError(400, "INVALID_INPUT", "Invalid order body");
  const { idempotencyKey, expectedTotal, items, ...other } = body;
  rejectClientFinancialAuthority({ items, ...other });
  if (Object.keys(other).length)
    throw new OrderDomainError(400, "INVALID_INPUT", "Unexpected order field");
  if (!Array.isArray(items) || items.length === 0 || items.length > 200)
    throw new OrderDomainError(400, "INVALID_INPUT", "Invalid order items");
  let units = 0;
  for (const item of items) {
    if (!item || typeof item !== "object" || Array.isArray(item))
      throw new OrderDomainError(400, "INVALID_INPUT", "Invalid order item");
    const { foodId, foodSizeId, tasteId, quantity, note, ...extra } = item;
    rejectClientFinancialAuthority(extra);
    if (Object.keys(extra).length)
      throw new OrderDomainError(400, "INVALID_INPUT", "Unexpected item field");
    units += assertPositiveInteger(quantity, "quantity");
    if (units > 200)
      throw new OrderDomainError(
        400,
        "ORDER_TOO_LARGE",
        "Order supports at most 200 units",
      );
  }
  return { idempotencyKey, expectedTotal, items };
};

const publicSubmit = async (prisma, token, body) => {
  const access = await validAccess(prisma, token);
  const { idempotencyKey, expectedTotal, items } = normalizePublicBody(body);
  const order = await submitOrder(prisma, {
    actor: { type: "CUSTOMER" },
    qrToken: token,
    idempotencyKey,
    expectedTotal,
    intent: {
      channel: "QR",
      tableNo: access.tableNo,
      tableSessionId: access.tableSessionId,
      items,
    },
  });
  return { orderId: order.id, status: order.status, total: order.total };
};

const publicOrder = async (prisma, token, rawOrderId) => {
  const access = await validAccess(prisma, token);
  const orderId = Number(rawOrderId);
  if (!Number.isSafeInteger(orderId) || orderId <= 0)
    throw new OrderDomainError(404, "ORDER_NOT_FOUND", "Order was not found");
  const order = await prisma.order.findFirst({
    where: {
      id: orderId,
      channel: "QR",
      tableSessionId: access.tableSessionId,
    },
    select: {
      id: true,
      status: true,
      tableNo: true,
      total: true,
      submittedAt: true,
      Items: {
        orderBy: { id: "asc" },
        select: {
          foodName: true,
          quantity: true,
          note: true,
          lineTotal: true,
          Modifiers: { select: { type: true, name: true } },
        },
      },
      StatusHistory: {
        orderBy: { version: "asc" },
        select: { toStatus: true, createdAt: true },
      },
    },
  });
  if (!order)
    throw new OrderDomainError(404, "ORDER_NOT_FOUND", "Order was not found");
  return {
    id: order.id,
    status: order.status,
    tableNo: order.tableNo,
    total: order.total,
    submittedAt: order.submittedAt,
    items: order.Items.map((item) => ({
      name: item.foodName,
      quantity: item.quantity,
      note: item.note,
      lineTotal: item.lineTotal,
      modifiers: item.Modifiers,
    })),
    history: order.StatusHistory.map((entry) => ({
      status: entry.toStatus,
      at: entry.createdAt,
    })),
  };
};

module.exports = {
  publicContext,
  publicMenu,
  publicSubmit,
  publicOrder,
};
