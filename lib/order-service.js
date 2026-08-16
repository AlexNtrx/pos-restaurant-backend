const { createHash } = require("node:crypto");
const { Prisma } = require("@prisma/client");
const {
  OrderDomainError,
  STATUS_TIMESTAMP_FIELD,
  actorHistoryData,
  assertIdempotencyKey,
  assertPositiveInteger,
  assertStaffActor,
  authorizeTransition,
} = require("./order-domain");
const {
  buildOrderSnapshot,
  fingerprintOrderIntent,
  normalizeOrderIntent,
} = require("./order-pricing");

const ORDER_INCLUDE = Object.freeze({
  Items: { include: { Modifiers: true }, orderBy: { id: "asc" } },
  StatusHistory: { orderBy: { version: "asc" } },
});

const idempotencyConflict = () =>
  new OrderDomainError(
    409,
    "IDEMPOTENCY_CONFLICT",
    "Idempotency key was already used for a different intent",
  );

// EN: Service entry points reload the current user so caller-provided role data is never authoritative.
// FI: Palvelun rajapinnat lataavat nykyisen käyttäjän uudelleen, joten kutsujan antama roolitieto ei ole määräävä.
const verifyStaffActor = async (client, actor) => {
  assertStaffActor(actor);
  const user = await client.user.findUnique({
    where: { id: actor.userId },
    select: { id: true, level: true, status: true },
  });
  if (
    !user ||
    user.status !== "use" ||
    !["admin", "user"].includes(user.level)
  ) {
    throw new OrderDomainError(
      403,
      "FORBIDDEN",
      "Active staff capability is required",
    );
  }
  return { type: "STAFF", userId: user.id, level: user.level };
};

const getExistingOrder = async (client, scope, key, fingerprint) => {
  const existing = await client.order.findUnique({
    where: {
      idempotencyScope_idempotencyKey: {
        idempotencyScope: scope,
        idempotencyKey: key,
      },
    },
    include: ORDER_INCLUDE,
  });
  if (!existing) return null;
  if (existing.idempotencyFingerprint !== fingerprint) {
    throw idempotencyConflict();
  }
  return existing;
};

const submissionScope = (actor, normalizedIntent) => {
  if (actor?.type === "CUSTOMER") {
    if (
      normalizedIntent.channel !== "QR" ||
      normalizedIntent.tableSessionId == null
    ) {
      throw new OrderDomainError(
        403,
        "CUSTOMER_SUBMISSION_FORBIDDEN",
        "Customers may submit only QR orders",
      );
    }
    return `TABLE_SESSION:${normalizedIntent.tableSessionId}`;
  }
  assertStaffActor(actor);
  return `USER:${actor.userId}`;
};

// EN: Submission uniqueness is persisted before any public QR or Counter adapter is connected.
// FI: Lähetyksen yksilöllisyys tallennetaan ennen julkisen QR- tai kassasovittimen liittämistä.
const submitOrder = async (prisma, { actor, idempotencyKey, intent }) => {
  const key = assertIdempotencyKey(idempotencyKey);
  const normalizedIntent = normalizeOrderIntent(intent);
  const verifiedActor =
    actor?.type === "CUSTOMER" ? actor : await verifyStaffActor(prisma, actor);
  const scope = submissionScope(verifiedActor, normalizedIntent);
  const fingerprint = fingerprintOrderIntent(normalizedIntent);
  const replay = await getExistingOrder(prisma, scope, key, fingerprint);
  if (replay) return replay;

  for (let attempt = 0; attempt < 3; attempt += 1) {
    try {
      return await prisma.$transaction(
        async (tx) => {
          const transactionActor =
            verifiedActor.type === "CUSTOMER"
              ? verifiedActor
              : await verifyStaffActor(tx, verifiedActor);
          const existing = await getExistingOrder(tx, scope, key, fingerprint);
          if (existing) return existing;
          const snapshot = await buildOrderSnapshot(tx, normalizedIntent);
          const historyActor = actorHistoryData(transactionActor);
          return tx.order.create({
            data: {
              channel: snapshot.channel,
              status: "SUBMITTED",
              restaurantTableId: snapshot.restaurantTableId,
              tableSessionId: snapshot.tableSessionId,
              tableNo: snapshot.tableNo,
              createdByUserId:
                transactionActor.type === "STAFF"
                  ? transactionActor.userId
                  : null,
              subtotal: snapshot.subtotal,
              modifierTotal: snapshot.modifierTotal,
              total: snapshot.total,
              version: 1,
              idempotencyScope: scope,
              idempotencyKey: key,
              idempotencyFingerprint: fingerprint,
              Items: {
                create: snapshot.items.map(({ modifiers, ...item }) => ({
                  ...item,
                  Modifiers: { create: modifiers },
                })),
              },
              StatusHistory: {
                create: {
                  fromStatus: null,
                  toStatus: "SUBMITTED",
                  version: 1,
                  ...historyActor,
                },
              },
            },
            include: ORDER_INCLUDE,
          });
        },
        { isolationLevel: Prisma.TransactionIsolationLevel.Serializable },
      );
    } catch (error) {
      if (error instanceof OrderDomainError) throw error;
      if (error?.code === "P2034" && attempt < 2) continue;
      if (error?.code === "P2002") {
        const existing = await getExistingOrder(
          prisma,
          scope,
          key,
          fingerprint,
        );
        if (existing) return existing;
        throw idempotencyConflict();
      }
      throw error;
    }
  }
  throw new OrderDomainError(
    409,
    "SUBMIT_CONFLICT",
    "Order submission conflicted",
  );
};

// EN: The conditional update is the optimistic lock; history is committed in the same transaction.
// FI: Ehdollinen päivitys toimii optimistisena lukkona; historia vahvistetaan samassa transaktiossa.
const transitionOrder = async (
  prisma,
  { actor, orderId, expectedVersion, nextStatus, reason },
) => {
  assertPositiveInteger(orderId, "orderId");
  assertPositiveInteger(expectedVersion, "expectedVersion");
  const now = new Date();
  try {
    return await prisma.$transaction(
      async (tx) => {
        const verifiedActor = await verifyStaffActor(tx, actor);
        const current = await tx.order.findUnique({ where: { id: orderId } });
        if (!current) {
          throw new OrderDomainError(
            404,
            "ORDER_NOT_FOUND",
            "Order was not found",
          );
        }
        if (current.version !== expectedVersion) {
          throw new OrderDomainError(
            409,
            "STALE_VERSION",
            "Order version is stale",
          );
        }
        const normalizedReason = authorizeTransition({
          actor: verifiedActor,
          currentStatus: current.status,
          nextStatus,
          reason,
        });
        const timestampField = STATUS_TIMESTAMP_FIELD[nextStatus];
        const nextVersion = expectedVersion + 1;
        const data = {
          status: nextStatus,
          version: nextVersion,
          ...(timestampField ? { [timestampField]: now } : {}),
          ...(nextStatus === "REJECTED"
            ? { rejectionReason: normalizedReason }
            : {}),
          ...(nextStatus === "CANCELLED"
            ? { cancellationReason: normalizedReason }
            : {}),
        };
        const updated = await tx.order.updateMany({
          where: {
            id: orderId,
            status: current.status,
            version: expectedVersion,
          },
          data,
        });
        if (updated.count !== 1) {
          throw new OrderDomainError(
            409,
            "STALE_VERSION",
            "Order version is stale",
          );
        }
        await tx.orderStatusHistory.create({
          data: {
            orderId,
            fromStatus: current.status,
            toStatus: nextStatus,
            version: nextVersion,
            reason: normalizedReason,
            ...actorHistoryData(verifiedActor),
          },
        });
        return tx.order.findUnique({
          where: { id: orderId },
          include: ORDER_INCLUDE,
        });
      },
      { isolationLevel: Prisma.TransactionIsolationLevel.Serializable },
    );
  } catch (error) {
    if (error?.code === "P2034") {
      throw new OrderDomainError(
        409,
        "STALE_VERSION",
        "Order version is stale",
      );
    }
    throw error;
  }
};

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
      }),
    )
    .digest("hex");

const existingSettlement = async (client, userId, key, fingerprint) => {
  const bill = await client.billSale.findUnique({
    where: { userId_idempotencyKey: { userId, idempotencyKey: key } },
    include: { BillSaleDetails: true, Orders: true },
  });
  if (!bill) return null;
  if (bill.checkoutFingerprint !== fingerprint) throw idempotencyConflict();
  return bill;
};

const expandBillDetails = (orders) =>
  orders.flatMap((order) =>
    order.Items.flatMap((item) => {
      const size = item.Modifiers.find((modifier) => modifier.type === "SIZE");
      const taste = item.Modifiers.find(
        (modifier) => modifier.type === "TASTE",
      );
      return Array.from({ length: item.quantity }, () => ({
        foodId: item.foodId,
        foodSizeId: size?.foodSizeId ?? null,
        tastedId: taste?.tasteId ?? null,
        moneyAdded: size?.priceAdjustment ?? 0,
        price: item.unitBasePrice,
        foodName: item.foodName,
        foodSizeName: size?.name ?? null,
        tasteName: taste?.name ?? null,
      }));
    }),
  );

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

// EN: The Counter bridge shares authoritative pricing while retaining the legacy bill detail order.
// FI: Kassasovitin käyttää samaa luotettavaa hinnoittelua ja säilyttää vanhan laskurivien järjestyksen.
const createAndSettleCounterOrder = async (
  tx,
  {
    actor,
    idempotencyKey,
    tableNo,
    lines,
    amount,
    payType,
    inputMoney,
    checkoutFingerprint,
  },
) => {
  const verifiedActor = await verifyStaffActor(tx, actor);
  const key = assertIdempotencyKey(idempotencyKey);
  if (!Array.isArray(lines) || lines.length === 0) {
    throw new OrderDomainError(409, "EMPTY_ORDER", "Order requires items");
  }
  // EN: The legacy cart has no 200-line limit; group equal selections before Order validation.
  // FI: Vanhassa ostoskorissa ei ole 200 rivin rajaa; samat valinnat ryhmitellään ennen tilauksen tarkistusta.
  const grouped = new Map();
  for (const line of lines) {
    const key = JSON.stringify([line.foodId, line.foodSizeId, line.tastedId]);
    const item = grouped.get(key);
    if (item) {
      item.quantity += 1;
    } else {
      grouped.set(key, {
        foodId: line.foodId,
        quantity: 1,
        foodSizeId: line.foodSizeId,
        tasteId: line.tastedId,
      });
    }
  }
  const intent = normalizeOrderIntent(
    { channel: "COUNTER", tableNo, items: [...grouped.values()] },
    { maxItems: Number.MAX_SAFE_INTEGER },
  );
  const snapshot = await buildOrderSnapshot(tx, intent);
  if (snapshot.total !== amount) {
    throw new OrderDomainError(
      409,
      "CHECKOUT_TOTAL_MISMATCH",
      "Cart and Order totals differ",
    );
  }
  const received = payType === "bank" ? snapshot.total : inputMoney;
  if (
    !["cash", "bank"].includes(payType) ||
    !Number.isSafeInteger(received) ||
    received < snapshot.total
  ) {
    throw new OrderDomainError(400, "INVALID_PAYMENT", "Payment is invalid");
  }
  const order = await tx.order.create({
    data: {
      channel: "COUNTER",
      status: "SUBMITTED",
      restaurantTableId: snapshot.restaurantTableId,
      tableSessionId: null,
      tableNo: snapshot.tableNo,
      createdByUserId: verifiedActor.userId,
      subtotal: snapshot.subtotal,
      modifierTotal: snapshot.modifierTotal,
      total: snapshot.total,
      version: 1,
      idempotencyScope: "USER:" + verifiedActor.userId,
      idempotencyKey: key,
      idempotencyFingerprint: fingerprintOrderIntent(intent),
      Items: {
        create: snapshot.items.map(({ modifiers, ...item }) => ({
          ...item,
          Modifiers: { create: modifiers },
        })),
      },
      StatusHistory: {
        create: {
          fromStatus: null,
          toStatus: "SUBMITTED",
          version: 1,
          ...actorHistoryData(verifiedActor),
        },
      },
    },
  });
  const bill = await tx.billSale.create({
    data: {
      amount: snapshot.total,
      inputMoney: received,
      returnMoney: payType === "bank" ? 0 : received - snapshot.total,
      payType,
      tableNo: snapshot.tableNo,
      userId: verifiedActor.userId,
      idempotencyKey,
      checkoutFingerprint,
      BillSaleDetails: { create: lines },
    },
  });
  await completePaidOrder(tx, order, bill.id, new Date());
  return bill;
};

const settleOrders = async (prisma, request, retryCount = 0) => {
  const normalized = normalizeSettlementRequest(request);
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
          where: { id: { in: normalized.orders.map((order) => order.id) } },
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
          if (
            orders[index].status !== "SERVED" ||
            orders[index].billSaleId != null
          ) {
            throw new OrderDomainError(
              409,
              "ORDER_NOT_PAYABLE",
              "Only unsettled SERVED orders can be paid",
            );
          }
        }

        const sessionIds = [
          ...new Set(
            orders.map((order) => order.tableSessionId).filter(Boolean),
          ),
        ];
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
        if (orders.some((order) => order.tableNo !== tableNo)) {
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
            status: "use",
            idempotencyKey: normalized.idempotencyKey,
            checkoutFingerprint: fingerprint,
            tableSessionId: sessionIds[0] ?? null,
            BillSaleDetails: { create: expandBillDetails(orders) },
          },
        });

        for (const order of orders) {
          await completePaidOrder(tx, order, bill.id, now);
        }
        if (sessionIds.length === 1) {
          const closed = await tx.tableSession.updateMany({
            where: { id: sessionIds[0], status: "OPEN", closedAt: null },
            data: { status: "CLOSED", closedAt: now },
          });
          if (closed.count !== 1) {
            throw new OrderDomainError(
              409,
              "TABLE_SESSION_INACTIVE",
              "Table session is not open",
            );
          }
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
      if (retryCount < 2) return settleOrders(prisma, request, retryCount + 1);
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

module.exports = {
  submitOrder,
  transitionOrder,
  settleOrders,
  createAndSettleCounterOrder,
};
