const {
  OrderDomainError,
  assertPositiveInteger,
  assertStaffActor,
} = require("./order-domain");
const { transitionOrder } = require("./order-service");

const STATUSES = new Set([
  "SUBMITTED",
  "CONFIRMED",
  "REJECTED",
  "PREPARING",
  "READY",
  "SERVED",
  "PAID",
  "COMPLETED",
  "CANCELLED",
]);
const CHANNELS = new Set(["COUNTER", "QR"]);
const INBOX_TARGETS = new Set(["CONFIRMED", "REJECTED", "CANCELLED"]);
const MAX_PAGE_SIZE = 100;
const ORDER_INCLUDE = {
  Items: {
    orderBy: { id: "asc" },
    include: { Modifiers: { orderBy: { id: "asc" } } },
  },
  StatusHistory: { orderBy: { version: "asc" } },
};
const ORDER_LIST_INCLUDE = { Items: ORDER_INCLUDE.Items };

// EN: Staff list/detail calls re-read the active account; route guards alone are not the service authority.
// FI: Henkilökunnan lista- ja tarkennekutsut lataavat aktiivisen käyttäjän uudelleen; pelkkä reittisuoja ei anna palveluoikeutta.
const verifyReader = async (prisma, actor) => {
  assertStaffActor(actor);
  const user = await prisma.user.findUnique({
    where: { id: actor.userId },
    select: { status: true, level: true },
  });
  if (!user || user.status !== "use" || !["admin", "user"].includes(user.level))
    throw new OrderDomainError(
      403,
      "FORBIDDEN",
      "Active staff capability is required",
    );
};

const optionalEnum = (value, choices, field) => {
  if (value == null || value === "") return null;
  if (typeof value !== "string" || !choices.has(value))
    throw new OrderDomainError(
      400,
      "INVALID_FILTER",
      `Invalid ${field} filter`,
    );
  return value;
};

const optionalPositiveId = (value, field) => {
  if (value == null || value === "") return null;
  if (typeof value !== "string" || !/^[1-9]\d*$/.test(value))
    throw new OrderDomainError(
      400,
      "INVALID_FILTER",
      `Invalid ${field} filter`,
    );
  const id = Number(value);
  if (!Number.isSafeInteger(id))
    throw new OrderDomainError(
      400,
      "INVALID_FILTER",
      `Invalid ${field} filter`,
    );
  return id;
};

const optionalTime = (value) => {
  if (value == null || value === "") return null;
  if (
    typeof value !== "string" ||
    !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(value) ||
    Number.isNaN(Date.parse(value))
  )
    throw new OrderDomainError(
      400,
      "INVALID_FILTER",
      "Invalid updatedAfter filter",
    );
  return new Date(value);
};

const pageSize = (value) => {
  if (value == null || value === "") return MAX_PAGE_SIZE;
  if (typeof value !== "string" || !/^[1-9]\d*$/.test(value))
    throw new OrderDomainError(400, "INVALID_FILTER", "Invalid limit filter");
  const limit = Number(value);
  if (!Number.isSafeInteger(limit) || limit > MAX_PAGE_SIZE)
    throw new OrderDomainError(400, "INVALID_FILTER", "Invalid limit filter");
  return limit;
};

const decodeCursor = (value) => {
  if (value == null || value === "") return null;
  if (
    typeof value !== "string" ||
    value.length > 256 ||
    !/^[A-Za-z0-9_-]+$/.test(value)
  )
    throw new OrderDomainError(400, "INVALID_CURSOR", "Invalid order cursor");
  try {
    const parsed = JSON.parse(Buffer.from(value, "base64url").toString("utf8"));
    if (
      !parsed ||
      typeof parsed.at !== "string" ||
      !Number.isSafeInteger(parsed.id) ||
      parsed.id <= 0
    )
      throw new Error("Invalid cursor");
    const at = optionalTime(parsed.at);
    if (!at) throw new Error("Invalid cursor");
    return { at, id: parsed.id };
  } catch {
    throw new OrderDomainError(400, "INVALID_CURSOR", "Invalid order cursor");
  }
};

const encodeCursor = (order) =>
  Buffer.from(
    JSON.stringify({ at: order.updatedAt.toISOString(), id: order.id }),
  ).toString("base64url");

const staffOrderDto = (order, { history = false } = {}) => ({
  id: order.id,
  channel: order.channel,
  status: order.status,
  version: order.version,
  tableNo: order.tableNo,
  tableSessionId: order.tableSessionId,
  total: order.total,
  submittedAt: order.submittedAt,
  updatedAt: order.updatedAt,
  rejectionReason: order.rejectionReason,
  cancellationReason: order.cancellationReason,
  items: order.Items.map((item) => ({
    name: item.foodName,
    quantity: item.quantity,
    note: item.note,
    lineTotal: item.lineTotal,
    modifiers: item.Modifiers.map((modifier) => ({
      type: modifier.type,
      name: modifier.name,
      priceAdjustment: modifier.priceAdjustment,
    })),
  })),
  ...(history
    ? {
        history: order.StatusHistory.map((event) => ({
          fromStatus: event.fromStatus,
          toStatus: event.toStatus,
          version: event.version,
          reason: event.reason,
          actorType: event.actorType,
          at: event.createdAt,
        })),
      }
    : {}),
});

const listStaffOrders = async (prisma, { actor, filters = {} }) => {
  await verifyReader(prisma, actor);
  const status = optionalEnum(filters.status, STATUSES, "status");
  const channel = optionalEnum(filters.channel, CHANNELS, "channel");
  const tableSessionId = optionalPositiveId(
    filters.tableSessionId,
    "tableSessionId",
  );
  const updatedAfter = optionalTime(filters.updatedAfter);
  const cursor = decodeCursor(filters.cursor);
  const limit = pageSize(filters.limit);
  const serverTime = new Date().toISOString();
  const where = {
    ...(status ? { status } : {}),
    ...(channel ? { channel } : {}),
    ...(tableSessionId ? { tableSessionId } : {}),
    ...(updatedAfter ? { updatedAt: { gte: updatedAfter } } : {}),
    ...(cursor
      ? {
          OR: [
            { updatedAt: { gt: cursor.at } },
            { updatedAt: cursor.at, id: { gt: cursor.id } },
          ],
        }
      : {}),
  };
  const rows = await prisma.order.findMany({
    where,
    orderBy: [{ updatedAt: "asc" }, { id: "asc" }],
    take: limit + 1,
    include: ORDER_LIST_INCLUDE,
  });
  const page = rows.slice(0, limit);
  return {
    results: page.map((order) => staffOrderDto(order)),
    nextCursor: rows.length > limit ? encodeCursor(page.at(-1)) : null,
    serverTime,
  };
};

const getStaffOrder = async (prisma, { actor, orderId }) => {
  await verifyReader(prisma, actor);
  const id = assertPositiveInteger(Number(orderId), "orderId");
  const order = await prisma.order.findUnique({
    where: { id },
    include: ORDER_INCLUDE,
  });
  if (!order)
    throw new OrderDomainError(404, "ORDER_NOT_FOUND", "Order was not found");
  return staffOrderDto(order, { history: true });
};

const changeIncomingStatus = async (prisma, { actor, orderId, body }) => {
  if (!body || typeof body !== "object" || Array.isArray(body))
    throw new OrderDomainError(400, "INVALID_INPUT", "Invalid status body");
  const { expectedVersion, nextStatus, reason, ...extra } = body;
  if (Object.keys(extra).length || !INBOX_TARGETS.has(nextStatus))
    throw new OrderDomainError(
      400,
      "INVALID_INPUT",
      "Invalid incoming status action",
    );
  const order = await transitionOrder(prisma, {
    actor,
    orderId: assertPositiveInteger(Number(orderId), "orderId"),
    expectedVersion,
    nextStatus,
    reason,
  });
  return staffOrderDto(order, { history: true });
};

const serveStaffOrder = async (prisma, { actor, orderId, body }) => {
  if (
    !body ||
    typeof body !== "object" ||
    Array.isArray(body) ||
    Object.keys(body).length !== 1 ||
    !Object.hasOwn(body, "expectedVersion")
  )
    throw new OrderDomainError(400, "INVALID_INPUT", "Invalid serving action");
  // EN: The shared state engine accepts only READY to SERVED and records a versioned staff event.
  // FI: Yhteinen tilakone hyväksyy vain siirtymän READY-tilasta SERVED-tilaan ja kirjaa versioidun henkilökuntatapahtuman.
  const order = await transitionOrder(prisma, {
    actor,
    orderId: assertPositiveInteger(Number(orderId), "orderId"),
    expectedVersion: body.expectedVersion,
    nextStatus: "SERVED",
  });
  return staffOrderDto(order, { history: true });
};

module.exports = {
  listStaffOrders,
  getStaffOrder,
  changeIncomingStatus,
  serveStaffOrder,
  staffOrderDto,
};
