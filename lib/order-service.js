const { createHash } = require("node:crypto");
const { Prisma } = require("@prisma/client");
const { resolveQrAccess } = require("./table-service");
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
  rejectClientFinancialAuthority,
} = require("./order-pricing");

const ORDER_INCLUDE = Object.freeze({
  Items: { include: { Modifiers: true }, orderBy: { id: "asc" } },
  StatusHistory: { orderBy: { version: "asc" } },
});

// EN: A cashier's send action records submission and confirmation together so Kitchen can read the Order immediately.
// FI: Kassatyöntekijän lähetys kirjaa lähetyksen ja vahvistuksen yhdessä, jotta keittiö voi lukea tilauksen heti.
const submissionState = (actor, confirmForKitchen) => {
  const confirmedAt = confirmForKitchen ? new Date() : null;
  const historyActor = actorHistoryData(actor);
  return {
    status: confirmForKitchen ? "CONFIRMED" : "SUBMITTED",
    version: confirmForKitchen ? 2 : 1,
    ...(confirmedAt ? { confirmedAt } : {}),
    StatusHistory: {
      create: [
        {
          fromStatus: null,
          toStatus: "SUBMITTED",
          version: 1,
          ...historyActor,
        },
        ...(confirmedAt
          ? [
              {
                fromStatus: "SUBMITTED",
                toStatus: "CONFIRMED",
                version: 2,
                createdAt: confirmedAt,
                ...historyActor,
              },
            ]
          : []),
      ],
    },
  };
};

const idempotencyConflict = () =>
  new OrderDomainError(
    409,
    "IDEMPOTENCY_CONFLICT",
    "Idempotency key was already used for a different intent",
  );

const MAX_COUNTER_DRAFT_UNITS = 200;
// EN: Bill details expand to one row per unit; bound Counter drafts before any PDF or payment allocation.
// FI: Laskurivit laajenevat yhdeksi riviksi annosta kohti; rajaa kassaluonnokset ennen PDF- tai maksunvarausta.
const normalizeCounterDraftIntent = (rawIntent) => {
  rejectClientFinancialAuthority(rawIntent);
  const intent = normalizeOrderIntent({
    channel: "COUNTER",
    tableNo: rawIntent?.tableNo,
    serviceType: rawIntent?.serviceType,
    items: rawIntent?.items,
  });
  let units = 0;
  for (const item of intent.items) {
    units += item.quantity;
    if (units > MAX_COUNTER_DRAFT_UNITS) {
      throw new OrderDomainError(
        400,
        "ORDER_TOO_LARGE",
        "Counter draft supports at most 200 units",
      );
    }
  }
  return intent;
};

// EN: The retired unpaid Counter submission endpoint may replay an existing Order, but cannot create another one.
// FI: Poistettu maksamattoman kassatilauksen lähetys voi palauttaa aiemman tilauksen, mutta ei luoda uutta.
const replayCounterKitchenSubmission = async (
  prisma,
  { actor, idempotencyKey, intent },
) => {
  const verifiedActor = await verifyStaffActor(prisma, actor);
  const key = assertIdempotencyKey(idempotencyKey);
  const normalizedIntent = normalizeCounterDraftIntent(intent);
  const order = await getExistingOrder(
    prisma,
    `USER:${verifiedActor.userId}`,
    key,
    fingerprintOrderIntent(normalizedIntent),
  );
  if (!order || order.channel !== "COUNTER")
    throw new OrderDomainError(
      409,
      "PAYMENT_REQUIRED",
      "Payment is required before sending a Counter Order to Kitchen",
    );
  return order;
};

// EN: Service entry points reload the current user so caller-provided role data is never authoritative.
// FI: Palvelun rajapinnat lataavat nykyisen käyttäjän uudelleen, joten kutsujan antama roolitieto ei ole määräävä.
const verifyStaffActor = async (
  client,
  actor,
  { allowWaiter = false, allowKitchen = false } = {},
) => {
  assertStaffActor(actor);
  const user = await client.user.findUnique({
    where: { id: actor.userId },
    select: { id: true, level: true, status: true },
  });
  if (
    !user ||
    user.status !== "use" ||
    ![
      "admin",
      "user",
      ...(allowWaiter ? ["waiter"] : []),
      ...(allowKitchen ? ["kitchen"] : []),
    ].includes(user.level)
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
const submitOrder = async (
  prisma,
  {
    actor,
    idempotencyKey,
    intent,
    expectedTotal = null,
    qrToken = null,
    confirmForKitchen = false,
  },
) => {
  const key = assertIdempotencyKey(idempotencyKey);
  if (
    expectedTotal !== null &&
    (!Number.isSafeInteger(expectedTotal) || expectedTotal < 0)
  ) {
    throw new OrderDomainError(
      400,
      "INVALID_EXPECTED_TOTAL",
      "Invalid quoted total",
    );
  }
  const normalizedIntent = normalizeOrderIntent(intent);
  const verifiedActor =
    actor?.type === "CUSTOMER"
      ? actor
      : await verifyStaffActor(prisma, actor, {
          allowWaiter: normalizedIntent.channel === "STAFF",
        });
  if (
    confirmForKitchen &&
    (verifiedActor.type !== "STAFF" ||
      !["COUNTER", "STAFF"].includes(normalizedIntent.channel))
  )
    throw new OrderDomainError(403, "FORBIDDEN", "Staff order is required");
  const scope = submissionScope(verifiedActor, normalizedIntent);
  const fingerprint = fingerprintOrderIntent(normalizedIntent);
  if (qrToken !== null) {
    if (verifiedActor.type !== "CUSTOMER")
      throw new OrderDomainError(
        403,
        "FORBIDDEN",
        "QR token requires customer actor",
      );
    const access = await resolveQrAccess(prisma, qrToken);
    if (
      !access ||
      access.tableSessionId !== normalizedIntent.tableSessionId ||
      access.tableNo !== normalizedIntent.tableNo
    )
      throw new OrderDomainError(404, "QR_INVALID", "QR link is unavailable");
  }
  const replay = await getExistingOrder(prisma, scope, key, fingerprint);
  if (replay) return replay;

  for (let attempt = 0; attempt < 3; attempt += 1) {
    try {
      return await prisma.$transaction(
        async (tx) => {
          const transactionActor =
            verifiedActor.type === "CUSTOMER"
              ? verifiedActor
              : await verifyStaffActor(tx, verifiedActor, {
                  allowWaiter: normalizedIntent.channel === "STAFF",
                });
          const existing = await getExistingOrder(tx, scope, key, fingerprint);
          if (existing) return existing;
          if (normalizedIntent.channel === "STAFF") {
            // EN: Hold the table session while a waiter submits so closing it cannot race the order snapshot.
            // FI: Lukitse pöytäistunto tarjoilijan lähetyksen ajaksi, jotta sulkeminen ei kilpaile tilannekuvan kanssa.
            await tx.$queryRaw`SELECT id FROM "TableSession" WHERE id = ${normalizedIntent.tableSessionId} FOR UPDATE`;
          }
          if (qrToken !== null) {
            // EN: Lock the session row so rotation/close cannot race a public submission after token validation.
            // FI: Lukitse istunnon rivi, jotta tunnisteen vaihto tai sulkeminen ei voi kilpailla julkisen tilauksen kanssa tarkistuksen jälkeen.
            await tx.$queryRaw`SELECT id FROM "TableSession" WHERE id = ${normalizedIntent.tableSessionId} FOR UPDATE`;
            // EN: Hold a shared policy lock so an admin disabling ordering is ordered before or after this submit, never midway through it.
            // FI: Pidä käytäntörivin jaettu lukko, jotta tilaamisen sulkeminen tapahtuu ennen lähetystä tai sen jälkeen, ei sen aikana.
            await tx.$queryRaw`SELECT id FROM "QrPolicy" WHERE id = 1 FOR SHARE`;
            const access = await resolveQrAccess(tx, qrToken);
            if (
              !access ||
              access.tableSessionId !== normalizedIntent.tableSessionId ||
              access.tableNo !== normalizedIntent.tableNo
            )
              throw new OrderDomainError(
                404,
                "QR_INVALID",
                "QR link is unavailable",
              );
            if (access.state !== "ORDERING")
              throw new OrderDomainError(
                409,
                "QR_ORDERING_CLOSED",
                "QR ordering is closed",
              );
            const recentCount = await tx.order.count({
              where: {
                channel: "QR",
                tableSessionId: access.tableSessionId,
                submittedAt: { gte: new Date(Date.now() - 60_000) },
              },
            });
            if (recentCount >= 30)
              throw new OrderDomainError(
                429,
                "QR_RATE_LIMITED",
                "Try again later",
              );
          }
          const snapshot = await buildOrderSnapshot(tx, normalizedIntent);
          // EN: Compare the cashier's confirmed quote inside the same transaction that persists the Order.
          // FI: Vertaa kassatyöntekijän vahvistamaa hinta-arviota samassa transaktiossa, joka tallentaa tilauksen.
          if (expectedTotal !== null && snapshot.total !== expectedTotal) {
            throw new OrderDomainError(
              409,
              "QUOTE_CHANGED",
              "Order total changed; review the new quote",
            );
          }
          return tx.order.create({
            data: {
              channel: snapshot.channel,
              serviceType: normalizedIntent.serviceType ?? "DINE_IN",
              ...submissionState(transactionActor, confirmForKitchen),
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
              idempotencyScope: scope,
              idempotencyKey: key,
              idempotencyFingerprint: fingerprint,
              Items: {
                create: snapshot.items.map(({ modifiers, ...item }) => ({
                  ...item,
                  Modifiers: { create: modifiers },
                })),
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
        const verifiedActor = await verifyStaffActor(tx, actor, {
          allowWaiter: true,
          allowKitchen: true,
        });
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
        if (nextStatus === "CANCELLED" && current.preparingAt != null) {
          throw new OrderDomainError(
            409,
            "ORDER_NOT_CANCELLABLE",
            "Preparation has already started",
          );
        }
        // EN: A paid Counter Order remains in Kitchen, but it cannot be rejected or cancelled after a receipt exists.
        // FI: Maksettu kassatilaus pysyy keittiössä, mutta sitä ei voi hylätä tai perua kuitin synnyttyä.
        if (
          current.billSaleId != null &&
          ["REJECTED", "CANCELLED"].includes(nextStatus)
        ) {
          throw new OrderDomainError(
            409,
            "ORDER_ALREADY_PAID",
            "Paid Order cannot be rejected or cancelled",
          );
        }
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
        // EN: Serving a prepaid standalone Counter Order completes fulfillment without charging it again.
        // FI: Ennakkoon maksetun erillisen kassatilauksen tarjoilu päättää toimituksen veloittamatta sitä uudelleen.
        if (
          nextStatus === "SERVED" &&
          current.channel === "COUNTER" &&
          current.tableSessionId == null &&
          current.billSaleId != null
        ) {
          const completedVersion = nextVersion + 1;
          const completed = await tx.order.updateMany({
            where: {
              id: orderId,
              status: "SERVED",
              version: nextVersion,
              billSaleId: current.billSaleId,
            },
            data: {
              status: "COMPLETED",
              version: completedVersion,
              completedAt: now,
            },
          });
          if (completed.count !== 1)
            throw new OrderDomainError(
              409,
              "STALE_VERSION",
              "Order version is stale",
            );
          await tx.orderStatusHistory.create({
            data: {
              orderId,
              fromStatus: "SERVED",
              toStatus: "COMPLETED",
              version: completedVersion,
              actorType: "SYSTEM",
            },
          });
        }
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

// EN: A sent Counter Order prints from its immutable snapshot and only for its cashier while unpaid.
// FI: Lähetetty kassatilaus tulostetaan muuttumattomasta tilannekuvasta vain sen kassatyöntekijälle ennen maksua.
const counterOrderPrebill = async (prisma, { actor, orderId }) => {
  const verifiedActor = await verifyStaffActor(prisma, actor);
  const id = assertPositiveInteger(orderId, "orderId");
  const order = await prisma.order.findFirst({
    where: {
      id,
      channel: "COUNTER",
      createdByUserId: verifiedActor.userId,
      tableSessionId: null,
      billSaleId: null,
      status: { notIn: ["REJECTED", "CANCELLED"] },
    },
    include: { Items: { include: { Modifiers: true } } },
  });
  if (!order)
    throw new OrderDomainError(404, "ORDER_NOT_FOUND", "Order was not found");
  return {
    id: order.id,
    serviceType: order.serviceType,
    tableNo: order.tableNo,
    submittedAt: order.submittedAt,
    total: order.total,
    lines: expandBillDetails([order]),
  };
};

// EN: Sent-order history includes this cashier's kitchen submissions and prepaid dine-in or takeaway Orders.
// FI: Lähetettyjen tilausten historia sisältää tämän kassatyöntekijän keittiötilaukset sekä ennakkoon maksetut pöytä- ja noutotilaukset.
const sentCounterWhere = (userId) => ({
  channel: "COUNTER",
  createdByUserId: userId,
  tableSessionId: null,
  OR: [
    { confirmedAt: { not: null } },
    { idempotencyScope: `COUNTER_KITCHEN_USER:${userId}` },
    // EN: Older browser drafts used USER scope before confirmation; direct checkout is identified by its immediate PAID transition.
    // FI: Vanhat selainluonnokset käyttivät USER-rajausta ennen vahvistusta; suora maksu tunnistetaan välittömästä PAID-siirtymästä.
    {
      idempotencyScope: `USER:${userId}`,
      StatusHistory: {
        none: { fromStatus: "SUBMITTED", toStatus: "PAID" },
      },
    },
  ],
});

const listSentCounterOrders = async (
  prisma,
  { actor, tableNo, serviceType = "DINE_IN", view = "all" },
) => {
  const verifiedActor = await verifyStaffActor(prisma, actor);
  if (!["DINE_IN", "TAKEAWAY"].includes(serviceType))
    throw new OrderDomainError(
      400,
      "INVALID_SERVICE_TYPE",
      "Invalid service type",
    );
  if (!["all", "active", "history"].includes(view))
    throw new OrderDomainError(400, "INVALID_VIEW", "Invalid sent-order view");
  const selectedTable =
    serviceType === "TAKEAWAY"
      ? null
      : assertPositiveInteger(tableNo, "tableNo");
  if (serviceType === "TAKEAWAY" && tableNo != null)
    throw new OrderDomainError(
      400,
      "INVALID_TABLE_NO",
      "Takeaway has no table",
    );
  const activeStatuses = [
    "SUBMITTED",
    "CONFIRMED",
    "PREPARING",
    "READY",
    "SERVED",
  ];
  return prisma.order.findMany({
    where: {
      ...sentCounterWhere(verifiedActor.userId),
      tableNo: selectedTable,
      serviceType,
      // EN: Filter in the database before the 100-row cap so finished Orders cannot displace active work.
      // FI: Suodata tietokannassa ennen 100 rivin rajaa, jotta päättyneet tilaukset eivät syrjäytä keskeneräisiä.
      ...(view === "active"
        ? { status: { in: activeStatuses } }
        : view === "history"
          ? { status: { notIn: activeStatuses } }
          : {}),
    },
    orderBy: { id: "desc" },
    take: 100,
    select: {
      id: true,
      serviceType: true,
      status: true,
      total: true,
      version: true,
      submittedAt: true,
      billSaleId: true,
      Items: {
        select: { foodName: true, quantity: true },
        orderBy: { id: "asc" },
      },
    },
  });
};

const getSentCounterOrder = async (prisma, { actor, orderId }) => {
  const verifiedActor = await verifyStaffActor(prisma, actor);
  const id = assertPositiveInteger(orderId, "orderId");
  const order = await prisma.order.findFirst({
    where: { ...sentCounterWhere(verifiedActor.userId), id },
    include: ORDER_INCLUDE,
  });
  if (!order)
    throw new OrderDomainError(404, "ORDER_NOT_FOUND", "Order was not found");
  return order;
};

// EN: The shared transition performs the final version and payment checks after the owned, unstarted stage is verified.
// FI: Yhteinen siirtymä tarkistaa lopullisen version ja maksun omistajuuden sekä aloittamattoman vaiheen tarkistuksen jälkeen.
const cancelSentCounterOrder = async (
  prisma,
  { actor, orderId, expectedVersion, reason },
) => {
  assertPositiveInteger(expectedVersion, "expectedVersion");
  const order = await getSentCounterOrder(prisma, { actor, orderId });
  if (order.version !== expectedVersion)
    throw new OrderDomainError(409, "STALE_VERSION", "Order version is stale");
  if (
    !["SUBMITTED", "CONFIRMED"].includes(order.status) ||
    order.billSaleId != null
  )
    throw new OrderDomainError(
      409,
      "ORDER_NOT_CANCELLABLE",
      "Only unpaid Orders not yet preparing can be cancelled",
    );
  return transitionOrder(prisma, {
    actor,
    orderId: order.id,
    expectedVersion,
    nextStatus: "CANCELLED",
    reason,
  });
};

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

// EN: Early Counter payment records the receipt and a versioned audit event while Kitchen keeps its current stage.
// FI: Kassatilauksen ennakkomaksu kirjaa kuitin ja versioidun lokitapahtuman keittiövaiheen pysyessä ennallaan.
const recordEarlyCounterPayment = async (tx, order, billId, now, actor) => {
  const nextVersion = order.version + 1;
  const paid = await tx.order.updateMany({
    where: {
      id: order.id,
      status: order.status,
      version: order.version,
      billSaleId: null,
    },
    data: {
      version: nextVersion,
      paidAt: now,
      billSaleId: billId,
    },
  });
  if (paid.count !== 1)
    throw new OrderDomainError(409, "STALE_VERSION", "Order version is stale");
  await tx.orderStatusHistory.create({
    data: {
      orderId: order.id,
      fromStatus: order.status,
      toStatus: order.status,
      version: nextVersion,
      reason: "Payment recorded before service",
      ...actorHistoryData(actor),
    },
  });
};

// EN: Legacy Counter checkout derives an immutable snapshot from the owned cart before payment.
// FI: Vanha kassan maksupolku muodostaa muuttumattoman tilannekuvan omasta ostoskorista ennen maksua.
const counterCartSnapshot = async (tx, { tableNo, lines, amount }) => {
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
  return { intent, snapshot };
};

const createCounterOrder = (
  tx,
  { verifiedActor, key, intent, snapshot, scope, confirmForKitchen = false },
) => {
  return tx.order.create({
    data: {
      channel: "COUNTER",
      serviceType: intent.serviceType ?? "DINE_IN",
      ...submissionState(verifiedActor, confirmForKitchen),
      restaurantTableId: snapshot.restaurantTableId,
      tableSessionId: null,
      tableNo: snapshot.tableNo,
      createdByUserId: verifiedActor.userId,
      subtotal: snapshot.subtotal,
      modifierTotal: snapshot.modifierTotal,
      total: snapshot.total,
      idempotencyScope: scope ?? "USER:" + verifiedActor.userId,
      idempotencyKey: key,
      idempotencyFingerprint: fingerprintOrderIntent(intent),
      Items: {
        create: snapshot.items.map(({ modifiers, ...item }) => ({
          ...item,
          Modifiers: { create: modifiers },
        })),
      },
    },
  });
};

// EN: Immediate legacy Counter payment confirms Kitchen work and records the bill in the same transaction.
// FI: Vanhan kassapolun välitön maksu vahvistaa keittiötyön ja kirjaa laskun samassa transaktiossa.
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
  const { intent, snapshot } = await counterCartSnapshot(tx, {
    tableNo,
    lines,
    amount,
  });
  const received = payType === "bank" ? snapshot.total : inputMoney;
  if (
    !["cash", "bank"].includes(payType) ||
    !Number.isSafeInteger(received) ||
    received < snapshot.total
  ) {
    throw new OrderDomainError(400, "INVALID_PAYMENT", "Payment is invalid");
  }
  const order = await createCounterOrder(tx, {
    verifiedActor,
    key,
    intent,
    snapshot,
    confirmForKitchen: true,
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
  await recordEarlyCounterPayment(
    tx,
    order,
    bill.id,
    new Date(),
    verifiedActor,
  );
  return bill;
};

// EN: Browser drafts contain identifiers only; the server rebuilds bill lines from the catalog snapshot.
// FI: Selainluonnokset sisältävät vain tunnisteet; palvelin muodostaa laskurivit luettelon tilannekuvasta.
const draftBillLines = (snapshot) =>
  snapshot.items.flatMap((item) => {
    const size = item.modifiers.find((modifier) => modifier.type === "SIZE");
    const taste = item.modifiers.find((modifier) => modifier.type === "TASTE");
    return Array.from({ length: item.quantity }, () => ({
      foodId: item.foodId,
      foodSizeId: size?.foodSizeId ?? null,
      tastedId: taste?.tasteId ?? null,
      foodName: item.foodName,
      foodSizeName: size?.name ?? null,
      tasteName: taste?.name ?? null,
      price: item.unitBasePrice,
      moneyAdded: size?.priceAdjustment ?? 0,
    }));
  });

const quoteCounterDraft = async (client, rawIntent) => {
  const intent = normalizeCounterDraftIntent(rawIntent);
  return { intent, snapshot: await buildOrderSnapshot(client, intent) };
};

// EN: A retry replays the committed bill; payment and Order history commit in one serializable transaction.
// FI: Uusintayritys palauttaa vahvistetun laskun; maksu ja tilaushistoria vahvistetaan yhdessä sarjallistettavassa transaktiossa.
const checkoutCounterDraft = async (prisma, request) => {
  const actor = await verifyStaffActor(prisma, request.actor);
  const key = assertIdempotencyKey(request.idempotencyKey);
  const intent = normalizeCounterDraftIntent(request.intent);
  if (!["cash", "bank"].includes(request.payType)) {
    throw new OrderDomainError(400, "INVALID_PAY_TYPE", "Invalid payment type");
  }
  const inputMoney = request.payType === "bank" ? null : request.inputMoney;
  if (
    request.payType === "cash" &&
    (!Number.isSafeInteger(inputMoney) || inputMoney < 0)
  ) {
    throw new OrderDomainError(
      400,
      "INVALID_INPUT_MONEY",
      "Invalid cash amount",
    );
  }
  if (
    !Number.isSafeInteger(request.expectedTotal) ||
    request.expectedTotal < 0
  ) {
    throw new OrderDomainError(
      400,
      "INVALID_EXPECTED_TOTAL",
      "Invalid quoted total",
    );
  }
  const fingerprint = createHash("sha256")
    .update(
      JSON.stringify({
        scope: "COUNTER_DRAFT",
        intent,
        payType: request.payType,
        inputMoney,
        expectedTotal: request.expectedTotal,
      }),
    )
    .digest("hex");
  const replay = () =>
    existingSettlement(prisma, actor.userId, key, fingerprint);
  const existing = await replay();
  if (existing) return existing;
  for (let attempt = 0; attempt < 3; attempt += 1) {
    try {
      return await prisma.$transaction(
        async (tx) => {
          await verifyStaffActor(tx, actor);
          const committed = await existingSettlement(
            tx,
            actor.userId,
            key,
            fingerprint,
          );
          if (committed) return committed;
          const snapshot = await buildOrderSnapshot(tx, intent);
          if (snapshot.total !== request.expectedTotal) {
            throw new OrderDomainError(
              409,
              "QUOTE_CHANGED",
              "Order total changed; review the new quote",
            );
          }
          const received =
            request.payType === "bank" ? snapshot.total : inputMoney;
          if (received < snapshot.total)
            throw new OrderDomainError(
              409,
              "INSUFFICIENT_CASH",
              "Cash received is insufficient",
            );
          // EN: Paid dine-in and takeaway Orders remain in Kitchen until service; takeaway uses Order.id as pickup number.
          // FI: Maksetut pöytä- ja noutotilaukset pysyvät keittiössä tarjoiluun asti; noutonumero on Order.id.
          const order = await createCounterOrder(tx, {
            verifiedActor: actor,
            key,
            intent,
            snapshot,
            confirmForKitchen: true,
          });
          const bill = await tx.billSale.create({
            data: {
              amount: snapshot.total,
              payType: request.payType,
              userId: actor.userId,
              inputMoney: received,
              returnMoney:
                request.payType === "bank" ? 0 : received - snapshot.total,
              tableNo: snapshot.tableNo,
              serviceType: intent.serviceType ?? "DINE_IN",
              idempotencyKey: key,
              checkoutFingerprint: fingerprint,
              BillSaleDetails: { create: draftBillLines(snapshot) },
            },
          });
          await recordEarlyCounterPayment(
            tx,
            order,
            bill.id,
            new Date(),
            actor,
          );
          return tx.billSale.findUnique({
            where: { id: bill.id },
            include: { BillSaleDetails: true, Orders: true },
          });
        },
        { isolationLevel: Prisma.TransactionIsolationLevel.Serializable },
      );
    } catch (error) {
      if (error instanceof OrderDomainError) throw error;
      if (error?.code === "P2034" && attempt < 2) continue;
      if (error?.code === "P2002" || error?.code === "P2034") {
        const committed = await replay();
        if (committed) return committed;
        throw new OrderDomainError(
          409,
          "CHECKOUT_CONFLICT",
          "Checkout conflicted; retry with the same key",
        );
      }
      throw error;
    }
  }
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
  submitOrder,
  transitionOrder,
  settleOrders,
  settleCounterOrder,
  counterOrderPrebill,
  listSentCounterOrders,
  getSentCounterOrder,
  cancelSentCounterOrder,
  settleTableSession,
  createAndSettleCounterOrder,
  quoteCounterDraft,
  replayCounterKitchenSubmission,
  draftBillLines,
  checkoutCounterDraft,
  normalizeCounterDraftIntent,
};
