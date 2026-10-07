const {
  ORDER_INCLUDE,
  ORDER_LIST_INCLUDE,
  staffOrderDto,
} = require("./staff-order-read-model");
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
const CHANNELS = new Set(["COUNTER", "QR", "STAFF"]);
const SORTS = new Set(["submitted_desc"]);
const INBOX_TARGETS = new Set(["CONFIRMED", "REJECTED", "CANCELLED"]);
const MAX_PAGE_SIZE = 100;
// EN: Staff list/detail calls re-read the active account; route guards alone are not the service authority.
// FI: Henkilökunnan lista- ja tarkennekutsut lataavat aktiivisen käyttäjän uudelleen; pelkkä reittisuoja ei anna palveluoikeutta.
const verifyReader = async (prisma, actor) => {
  assertStaffActor(actor);
  const user = await prisma.user.findUnique({
    where: { id: actor.userId },
    select: { status: true, level: true },
  });
  if (
    !user ||
    user.status !== "use" ||
    !["admin", "kassa", "waiter", "kitchen"].includes(user.level)
  )
    throw new OrderDomainError(
      403,
      "FORBIDDEN",
      "Active staff capability is required",
    );
  return user.level;
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
      parsed.id <= 0 ||
      (parsed.sort !== undefined && parsed.sort !== "submitted_desc")
    )
      throw new Error("Invalid cursor");
    const at = optionalTime(parsed.at);
    if (!at) throw new Error("Invalid cursor");
    return { at, id: parsed.id, sort: parsed.sort };
  } catch {
    throw new OrderDomainError(400, "INVALID_CURSOR", "Invalid order cursor");
  }
};

const encodeCursor = (order, sort) =>
  Buffer.from(
    JSON.stringify({
      at: (sort === "submitted_desc"
        ? order.submittedAt
        : order.updatedAt
      ).toISOString(),
      id: order.id,
      ...(sort ? { sort } : {}),
    }),
  ).toString("base64url");

const listStaffOrders = async (prisma, { actor, filters = {} }) => {
  await verifyReader(prisma, actor);
  const status = optionalEnum(filters.status, STATUSES, "status");
  const channel = optionalEnum(filters.channel, CHANNELS, "channel");
  const tableSessionId = optionalPositiveId(
    filters.tableSessionId,
    "tableSessionId",
  );
  const updatedAfter = optionalTime(filters.updatedAfter);
  const submittedFrom = optionalTime(filters.submittedFrom);
  const submittedBefore = optionalTime(filters.submittedBefore);
  if (submittedFrom && submittedBefore && submittedFrom >= submittedBefore)
    throw new OrderDomainError(
      400,
      "INVALID_FILTER",
      "Invalid submitted date range",
    );
  const cursor = decodeCursor(filters.cursor);
  const sort = optionalEnum(filters.sort, SORTS, "sort");
  if (cursor && (cursor.sort ?? null) !== sort)
    throw new OrderDomainError(
      400,
      "INVALID_CURSOR",
      "Cursor sort does not match the request",
    );
  // EN: History pages use immutable submission time; operational polling retains its existing updatedAt cursor.
  // FI: Historiasivut käyttävät muuttumatonta lähetysaikaa; toiminnallinen kysely säilyttää nykyisen updatedAt-kohdistimen.
  const history = sort === "submitted_desc";
  const limit = pageSize(filters.limit);
  const serverTime = new Date().toISOString();
  const where = {
    ...(status ? { status } : {}),
    ...(channel ? { channel } : {}),
    ...(tableSessionId ? { tableSessionId } : {}),
    ...(updatedAfter ? { updatedAt: { gte: updatedAfter } } : {}),
    ...(submittedFrom || submittedBefore
      ? {
          submittedAt: {
            ...(submittedFrom ? { gte: submittedFrom } : {}),
            ...(submittedBefore ? { lt: submittedBefore } : {}),
          },
        }
      : {}),
    ...(cursor
      ? {
          OR: history
            ? [
                { submittedAt: { lt: cursor.at } },
                { submittedAt: cursor.at, id: { lt: cursor.id } },
              ]
            : [
                { updatedAt: { gt: cursor.at } },
                { updatedAt: cursor.at, id: { gt: cursor.id } },
              ],
        }
      : {}),
  };
  const rows = await prisma.order.findMany({
    where,
    orderBy: history
      ? [{ submittedAt: "desc" }, { id: "desc" }]
      : [{ updatedAt: "asc" }, { id: "asc" }],
    take: limit + 1,
    include: ORDER_LIST_INCLUDE,
  });
  const page = rows.slice(0, limit);
  return {
    results: page.map((order) => staffOrderDto(order)),
    nextCursor: rows.length > limit ? encodeCursor(page.at(-1), sort) : null,
    serverTime,
    ...(history ? { sort } : {}),
  };
};

const getStaffOrder = async (prisma, { actor, orderId }) => {
  const level = await verifyReader(prisma, actor);
  const receipt = ["admin", "kassa"].includes(level);
  const id = assertPositiveInteger(Number(orderId), "orderId");
  const order = await prisma.order.findUnique({
    where: { id },
    include: {
      ...ORDER_INCLUDE,
      // EN: Only cashiers load payment metadata; count linked Orders without loading every Order or receipt line.
      // FI: Vain kassatyöntekijät lataavat maksutiedot; laske liittyvät tilaukset lataamatta kaikkia tilauksia tai kuittirivejä.
      ...(receipt
        ? {
            BillSale: {
              select: {
                id: true,
                amount: true,
                status: true,
                _count: { select: { Orders: true } },
              },
            },
          }
        : {}),
    },
  });
  if (!order)
    throw new OrderDomainError(404, "ORDER_NOT_FOUND", "Order was not found");
  return staffOrderDto(order, { history: true, receipt });
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
