const { Prisma } = require("@prisma/client");
const { OrderDomainError } = require("./order-domain");
const { resolveQrAccess } = require("./table-service");

const ACTIVE_STATUSES = ["REQUESTED", "ACKNOWLEDGED"];
const CALL_COOLDOWN_MS = 60_000;

const invalidQr = () =>
  new OrderDomainError(404, "QR_INVALID", "QR link is unavailable");
const conflict = () =>
  new OrderDomainError(409, "SERVICE_CALL_CONFLICT", "Service call changed");

const validAccess = async (prisma, token) => {
  const access = await resolveQrAccess(prisma, token);
  if (!access) throw invalidQr();
  return access;
};

const publicDto = (call, tableNo) =>
  call
    ? {
        id: call.id,
        tableNo,
        status: call.status,
        createdAt: call.createdAt,
        acknowledgedAt: call.acknowledgedAt,
        resolvedAt: call.resolvedAt,
      }
    : null;

const staffDto = (call) => ({
  ...publicDto(call, call.TableSession.RestaurantTable.tableNo),
  version: call.version,
});

const callInclude = {
  TableSession: { select: { RestaurantTable: { select: { tableNo: true } } } },
};

const getCurrentCall = async (prisma, token) => {
  const access = await validAccess(prisma, token);
  const call = await prisma.serviceCall.findFirst({
    where: { tableSessionId: access.tableSessionId },
    orderBy: { id: "desc" },
  });
  return publicDto(call, access.tableNo);
};

// EN: Lock the active table session before creating a call so session closure and QR calls cannot cross in flight.
// FI: Lukitse avoin pöytäistunto ennen kutsun luontia, jotta istunnon sulkeminen ja QR-kutsu eivät mene ristiin.
const createCall = async (prisma, token, body) => {
  if (
    body !== undefined &&
    (body === null ||
      typeof body !== "object" ||
      Array.isArray(body) ||
      Object.keys(body).length > 0)
  )
    throw new OrderDomainError(
      400,
      "INVALID_INPUT",
      "Invalid service call body",
    );
  const initial = await validAccess(prisma, token);
  if (initial.state === "CLOSED")
    throw new OrderDomainError(
      409,
      "SERVICE_UNAVAILABLE",
      "Service calls are unavailable",
    );

  for (let attempt = 0; attempt < 3; attempt += 1) {
    try {
      return await prisma.$transaction(
        async (tx) => {
          const locked = await tx.$queryRaw`
            SELECT "id" FROM "TableSession"
            WHERE "id" = ${initial.tableSessionId} AND "status" = 'OPEN'
            FOR UPDATE
          `;
          if (locked.length !== 1) throw invalidQr();
          const access = await validAccess(tx, token);
          if (access.state === "CLOSED")
            throw new OrderDomainError(
              409,
              "SERVICE_UNAVAILABLE",
              "Service calls are unavailable",
            );
          const active = await tx.serviceCall.findFirst({
            where: {
              tableSessionId: access.tableSessionId,
              status: { in: ACTIVE_STATUSES },
            },
          });
          if (active) return publicDto(active, access.tableNo);

          const latest = await tx.serviceCall.findFirst({
            where: { tableSessionId: access.tableSessionId },
            orderBy: { id: "desc" },
            select: { resolvedAt: true },
          });
          if (
            latest?.resolvedAt &&
            Date.now() - latest.resolvedAt.getTime() < CALL_COOLDOWN_MS
          )
            throw new OrderDomainError(
              429,
              "SERVICE_CALL_COOLDOWN",
              "Please wait before calling again",
            );
          const created = await tx.serviceCall.create({
            data: { tableSessionId: access.tableSessionId },
          });
          return publicDto(created, access.tableNo);
        },
        { isolationLevel: Prisma.TransactionIsolationLevel.Serializable },
      );
    } catch (error) {
      if (error?.code === "P2034" && attempt < 2) continue;
      if (error?.code === "P2002") {
        const active = await prisma.serviceCall.findFirst({
          where: {
            tableSessionId: initial.tableSessionId,
            status: { in: ACTIVE_STATUSES },
          },
        });
        if (active) return publicDto(active, initial.tableNo);
      }
      if (error?.code === "P2034" || error?.code === "P2002") throw conflict();
      throw error;
    }
  }
  throw conflict();
};

const listActiveCalls = async (prisma) => {
  const calls = await prisma.serviceCall.findMany({
    where: {
      status: { in: ACTIVE_STATUSES },
      TableSession: { status: "OPEN" },
    },
    include: callInclude,
    orderBy: [{ createdAt: "asc" }, { id: "asc" }],
    take: 100,
  });
  return { results: calls.map(staffDto) };
};

// EN: Versioned transitions ensure two staff devices cannot both acknowledge or resolve the same call.
// FI: Versioidut siirtymät estävät kahta henkilökunnan laitetta kuittaamasta tai ratkaisemasta samaa kutsua.
const changeCallStatus = async (prisma, rawId, body, actorId) => {
  const id = Number(rawId);
  if (!Number.isSafeInteger(id) || id <= 0)
    throw new OrderDomainError(400, "INVALID_INPUT", "Invalid service call id");
  if (
    !body ||
    typeof body !== "object" ||
    Array.isArray(body) ||
    Object.keys(body).some(
      (key) => !["expectedVersion", "nextStatus"].includes(key),
    ) ||
    !Number.isSafeInteger(body.expectedVersion) ||
    body.expectedVersion <= 0 ||
    !["ACKNOWLEDGED", "RESOLVED"].includes(body.nextStatus)
  )
    throw new OrderDomainError(
      400,
      "INVALID_INPUT",
      "Invalid service call action",
    );

  try {
    return await prisma.$transaction(
      async (tx) => {
        const current = await tx.serviceCall.findUnique({
          where: { id },
          include: { TableSession: { select: { status: true } } },
        });
        if (!current)
          throw new OrderDomainError(
            404,
            "SERVICE_CALL_NOT_FOUND",
            "Service call was not found",
          );
        if (current.TableSession.status !== "OPEN") throw conflict();
        const expectedStatus =
          body.nextStatus === "ACKNOWLEDGED" ? "REQUESTED" : "ACKNOWLEDGED";
        if (
          current.status !== expectedStatus ||
          current.version !== body.expectedVersion
        )
          throw conflict();
        const now = new Date();
        const changed = await tx.serviceCall.updateMany({
          where: { id, status: expectedStatus, version: body.expectedVersion },
          data:
            body.nextStatus === "ACKNOWLEDGED"
              ? {
                  status: "ACKNOWLEDGED",
                  version: { increment: 1 },
                  acknowledgedAt: now,
                  acknowledgedByUserId: actorId,
                }
              : {
                  status: "RESOLVED",
                  version: { increment: 1 },
                  resolvedAt: now,
                  resolvedByUserId: actorId,
                },
        });
        if (changed.count !== 1) throw conflict();
        const call = await tx.serviceCall.findUnique({
          where: { id },
          include: callInclude,
        });
        return staffDto(call);
      },
      { isolationLevel: Prisma.TransactionIsolationLevel.Serializable },
    );
  } catch (error) {
    if (error?.code === "P2034") throw conflict();
    throw error;
  }
};

module.exports = {
  getCurrentCall,
  createCall,
  listActiveCalls,
  changeCallStatus,
};
