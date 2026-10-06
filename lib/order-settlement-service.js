const { createHash } = require("node:crypto");
const { Prisma } = require("@prisma/client");
const {
  OrderDomainError,
  assertIdempotencyKey,
  assertPositiveInteger,
  assertStaffActor,
} = require("./order-domain");
const {
  verifyStaffActor,
  existingSettlement,
  expandBillDetails,
  recordEarlyCounterPayment,
} = require("./order-service-shared");

const normalizeSettlementRequest = (request) => {
  assertStaffActor(request.actor);
  const idempotencyKey = assertIdempotencyKey(request.idempotencyKey);
  if (!Array.isArray(request.orders) || request.orders.length === 0) {
    throw new OrderDomainError(
      400,
      "EMPTY_SETTLEMENT",
      "Settlement requires orders",
    );
  }
  const orders = request.orders
    .map((order) => ({
      id: assertPositiveInteger(order?.id, "orderId"),
      version: assertPositiveInteger(order?.version, "expectedVersion"),
    }))
    .sort((left, right) => left.id - right.id);
  if (new Set(orders.map((order) => order.id)).size !== orders.length) {
    throw new OrderDomainError(
      400,
      "DUPLICATE_ORDER",
      "Settlement order IDs must be unique",
    );
  }
  if (!["cash", "bank"].includes(request.payType)) {
    throw new OrderDomainError(
      400,
      "INVALID_PAY_TYPE",
      "payType must be cash or bank",
    );
  }
  if (
    request.inputMoney != null &&
    (!Number.isSafeInteger(request.inputMoney) || request.inputMoney < 0)
  ) {
    throw new OrderDomainError(
      400,
      "INVALID_INPUT_MONEY",
      "inputMoney must be a non-negative integer",
    );
  }
  return {
    actor: request.actor,
    idempotencyKey,
    orders,
    payType: request.payType,
    inputMoney: request.inputMoney ?? null,
  };
};

const settlementFingerprint = (request) =>
  createHash("sha256")
    .update(
      JSON.stringify({
        orders: request.orders,
        payType: request.payType,
        inputMoney: request.inputMoney,
        ...(request.counterOnly ? { scope: "OWN_COUNTER" } : {}),
        ...(request.requiredSessionId != null
          ? {
              scope: "TABLE_SESSION",
              tableSessionId: request.requiredSessionId,
            }
          : {}),
      }),
    )
    .digest("hex");

// EN: Both settlement paths advance a paid order and its audit history in the caller's transaction.
// FI: Molemmat maksupolut päivittävät maksetun tilauksen ja sen lokihistorian kutsujan transaktiossa.
const completePaidOrder = async (tx, order, billId, now) => {
  if (
    order.status !== "SERVED" &&
    !(order.channel === "COUNTER" && order.status === "SUBMITTED")
  ) {
    throw new OrderDomainError(
      409,
      "ORDER_NOT_PAYABLE",
      "Order is not payable",
    );
  }
  const paidVersion = order.version + 1;
  const paid = await tx.order.updateMany({
    where: {
      id: order.id,
      status: order.status,
      version: order.version,
      billSaleId: null,
    },
    data: {
      status: "PAID",
      version: paidVersion,
      paidAt: now,
      billSaleId: billId,
    },
  });
  if (paid.count !== 1) {
    throw new OrderDomainError(409, "STALE_VERSION", "Order version is stale");
  }
  await tx.orderStatusHistory.create({
    data: {
      orderId: order.id,
      fromStatus: order.status,
      toStatus: "PAID",
      version: paidVersion,
      actorType: "SYSTEM",
    },
  });
  const completedVersion = paidVersion + 1;
  const completed = await tx.order.updateMany({
    where: {
      id: order.id,
      status: "PAID",
      version: paidVersion,
      billSaleId: billId,
    },
    data: {
      status: "COMPLETED",
      version: completedVersion,
      completedAt: now,
    },
  });
  if (completed.count !== 1) {
    throw new OrderDomainError(409, "STALE_VERSION", "Order version is stale");
  }
  await tx.orderStatusHistory.create({
    data: {
      orderId: order.id,
      fromStatus: "PAID",
      toStatus: "COMPLETED",
      version: completedVersion,
      actorType: "SYSTEM",
    },
  });
};

const settleOrders = async (prisma, request, retryCount = 0, scope = null) => {
  const normalized = normalizeSettlementRequest(request);
  normalized.counterOnly = scope === "OWN_COUNTER";
  normalized.requiredSessionId =
    scope && typeof scope === "object" ? scope.tableSessionId : null;
  normalized.actor = await verifyStaffActor(prisma, normalized.actor);
  const fingerprint = settlementFingerprint(normalized);
  const replay = await existingSettlement(
    prisma,
    normalized.actor.userId,
    normalized.idempotencyKey,
    fingerprint,
  );
  if (replay) return replay;

  try {
    return await prisma.$transaction(
      async (tx) => {
        normalized.actor = await verifyStaffActor(tx, normalized.actor);
        // EN: Sorted advisory locks serialize overlapping settlements without touching SaleTemp locks.
        // FI: Järjestetyt advisory-lukot sarjallistavat päällekkäiset tilitykset koskematta SaleTemp-lukkoihin.
        for (const order of normalized.orders) {
          await tx.$executeRaw`SELECT pg_advisory_xact_lock(71001, ${order.id}::int)`;
        }
        const existing = await existingSettlement(
          tx,
          normalized.actor.userId,
          normalized.idempotencyKey,
          fingerprint,
        );
        if (existing) return existing;

        const orders = await tx.order.findMany({
          // EN: The public Counter adapter may settle only the cashier's standalone Counter Orders.
          // FI: Julkinen kassasovitin saa maksaa vain kassatyöntekijän omat erilliset kassatilaukset.
          where: {
            id: { in: normalized.orders.map((order) => order.id) },
            ...(normalized.counterOnly
              ? {
                  channel: "COUNTER",
                  createdByUserId: normalized.actor.userId,
                  tableSessionId: null,
                }
              : {}),
          },
          include: {
            Items: { include: { Modifiers: true } },
            TableSession: true,
          },
          orderBy: { id: "asc" },
        });
        if (orders.length !== normalized.orders.length) {
          throw new OrderDomainError(
            404,
            "ORDER_NOT_FOUND",
            "Order was not found",
          );
        }
        for (let index = 0; index < orders.length; index += 1) {
          if (orders[index].version !== normalized.orders[index].version) {
            throw new OrderDomainError(
              409,
              "STALE_VERSION",
              "Order version is stale",
            );
          }
          const payableStatus = normalized.counterOnly
            ? [
                "SUBMITTED",
                "CONFIRMED",
                "PREPARING",
                "READY",
                "SERVED",
              ].includes(orders[index].status)
            : orders[index].status === "SERVED";
          if (!payableStatus || orders[index].billSaleId != null) {
            throw new OrderDomainError(
              409,
              "ORDER_NOT_PAYABLE",
              "Order is not payable",
            );
          }
        }

        const sessionIds = [
          ...new Set(
            orders.map((order) => order.tableSessionId).filter(Boolean),
          ),
        ];
        // EN: A table checkout may settle only the session named by its staff route, even if all supplied IDs form another valid session.
        // FI: Pöydän maksu saa käsitellä vain henkilökunnan reitin nimeämän istunnon, vaikka annetut tunnisteet kuuluisivat toiseen kelvolliseen istuntoon.
        if (
          normalized.requiredSessionId != null &&
          (sessionIds.length !== 1 ||
            sessionIds[0] !== normalized.requiredSessionId ||
            orders.some(
              (order) => order.tableSessionId !== normalized.requiredSessionId,
            ))
        ) {
          throw new OrderDomainError(
            404,
            "SESSION_ORDERS_NOT_FOUND",
            "Orders do not belong to this table session",
          );
        }
        if (
          sessionIds.length > 1 ||
          (sessionIds.length === 0 && orders.length > 1)
        ) {
          throw new OrderDomainError(
            409,
            "SETTLEMENT_SCOPE_MISMATCH",
            "Orders must belong to one table session",
          );
        }
        if (sessionIds.length === 1) {
          if (orders.some((order) => order.tableSessionId !== sessionIds[0])) {
            throw new OrderDomainError(
              409,
              "SETTLEMENT_SCOPE_MISMATCH",
              "Orders cannot mix session and standalone scopes",
            );
          }
          // EN: Comparing the complete payable set prevents partial or split settlement in this phase.
          // FI: Koko maksettavan joukon vertailu estää tässä vaiheessa osittaisen tai jaetun tilityksen.
          const unsettled = await tx.order.findMany({
            where: {
              tableSessionId: sessionIds[0],
              billSaleId: null,
              status: { notIn: ["REJECTED", "CANCELLED"] },
            },
            select: { id: true },
          });
          const submittedIds = new Set(orders.map((order) => order.id));
          if (
            unsettled.length !== submittedIds.size ||
            unsettled.some((order) => !submittedIds.has(order.id))
          ) {
            throw new OrderDomainError(
              409,
              "PARTIAL_SETTLEMENT_FORBIDDEN",
              "All payable table-session orders must settle together",
            );
          }
        }

        const tableNo = orders[0].tableNo;
        const serviceType = orders[0].serviceType;
        if (
          orders.some(
            (order) =>
              order.tableNo !== tableNo || order.serviceType !== serviceType,
          )
        ) {
          throw new OrderDomainError(
            409,
            "TABLE_MISMATCH",
            "Orders have different table numbers",
          );
        }
        const total = orders.reduce((sum, order) => sum + order.total, 0);
        if (!Number.isSafeInteger(total) || total < 0) {
          throw new OrderDomainError(
            409,
            "TOTAL_OUT_OF_RANGE",
            "Settlement total is out of range",
          );
        }
        const inputMoney =
          normalized.payType === "bank" ? total : normalized.inputMoney;
        if (
          normalized.payType === "cash" &&
          (inputMoney == null || inputMoney < total)
        ) {
          throw new OrderDomainError(
            409,
            "INSUFFICIENT_CASH",
            "Cash received is insufficient",
          );
        }
        const returnMoney =
          normalized.payType === "cash" ? inputMoney - total : 0;
        const now = new Date();
        const bill = await tx.billSale.create({
          data: {
            amount: total,
            payType: normalized.payType,
            userId: normalized.actor.userId,
            inputMoney,
            returnMoney,
            tableNo,
            serviceType,
            status: "use",
            idempotencyKey: normalized.idempotencyKey,
            checkoutFingerprint: fingerprint,
            tableSessionId: sessionIds[0] ?? null,
            BillSaleDetails: { create: expandBillDetails(orders) },
          },
        });

        for (const order of orders) {
          if (normalized.counterOnly && order.status !== "SERVED")
            await recordEarlyCounterPayment(
              tx,
              order,
              bill.id,
              now,
              normalized.actor,
            );
          else await completePaidOrder(tx, order, bill.id, now);
        }
        if (sessionIds.length === 1) {
          const closed = await tx.tableSession.updateMany({
            where: { id: sessionIds[0], status: "OPEN", closedAt: null },
            // EN: Settlement invalidates QR access in the same transaction as payment and bill creation.
            // FI: Maksu mitätöi QR-pääsyn samassa transaktiossa laskun luonnin kanssa.
            data: {
              status: "CLOSED",
              closedAt: now,
              qrTokenHash: null,
              qrTokenNonce: null,
              qrTokenExpiresAt: null,
              tokenVersion: { increment: 1 },
            },
          });
          if (closed.count !== 1) {
            throw new OrderDomainError(
              409,
              "TABLE_SESSION_INACTIVE",
              "Table session is not open",
            );
          }
          // EN: Settlement removes unresolved service calls from the live staff queue atomically.
          // FI: Maksu poistaa keskeneräiset palvelukutsut henkilökunnan aktiivisesta jonosta atomisesti.
          await tx.serviceCall.updateMany({
            where: {
              tableSessionId: sessionIds[0],
              status: { in: ["REQUESTED", "ACKNOWLEDGED"] },
            },
            data: {
              status: "RESOLVED",
              resolvedAt: now,
              version: { increment: 1 },
            },
          });
        }
        return tx.billSale.findUnique({
          where: { id: bill.id },
          include: { BillSaleDetails: true, Orders: true },
        });
      },
      { isolationLevel: Prisma.TransactionIsolationLevel.Serializable },
    );
  } catch (error) {
    if (error instanceof OrderDomainError) throw error;
    if (error?.code === "P2034") {
      const existing = await existingSettlement(
        prisma,
        normalized.actor.userId,
        normalized.idempotencyKey,
        fingerprint,
      );
      if (existing) return existing;
      if (retryCount < 2)
        return settleOrders(prisma, request, retryCount + 1, scope);
      throw new OrderDomainError(
        409,
        "SETTLEMENT_CONFLICT",
        "Settlement conflicted; try again",
      );
    }
    if (error?.code === "P2002") {
      const existing = await existingSettlement(
        prisma,
        normalized.actor.userId,
        normalized.idempotencyKey,
        fingerprint,
      );
      if (existing) return existing;
      throw new OrderDomainError(
        409,
        "SETTLEMENT_CONFLICT",
        "Order is already settled",
      );
    }
    throw error;
  }
};

// EN: Scope is selected by server code; client fields cannot widen settlement authority.
// FI: Palvelinkoodi valitsee rajauksen; asiakkaan kentät eivät voi laajentaa maksuvaltuuksia.
const settleCounterOrder = (
  prisma,
  { actor, orderId, expectedVersion, idempotencyKey, payType, inputMoney },
) =>
  settleOrders(
    prisma,
    {
      actor,
      orders: [{ id: orderId, version: expectedVersion }],
      idempotencyKey,
      payType,
      inputMoney: payType === "bank" ? null : inputMoney,
    },
    0,
    "OWN_COUNTER",
  );

const settleTableSession = (prisma, { actor, sessionId, ...payment }) =>
  settleOrders(prisma, { actor, ...payment }, 0, {
    tableSessionId: assertPositiveInteger(Number(sessionId), "sessionId"),
  });

module.exports = {
  normalizeSettlementRequest,
  settlementFingerprint,
  completePaidOrder,
  settleOrders,
  settleCounterOrder,
  settleTableSession,
};
