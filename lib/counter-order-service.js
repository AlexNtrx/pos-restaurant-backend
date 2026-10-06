const { createHash } = require("node:crypto");
const { Prisma } = require("@prisma/client");
const {
  OrderDomainError,
  assertIdempotencyKey,
  assertPositiveInteger,
} = require("./order-domain");
const {
  buildOrderSnapshot,
  fingerprintOrderIntent,
  normalizeOrderIntent,
  rejectClientFinancialAuthority,
} = require("./order-pricing");
const {
  ORDER_INCLUDE,
  submissionState,
  verifyStaffActor,
  getExistingOrder,
  existingSettlement,
  expandBillDetails,
  recordEarlyCounterPayment,
} = require("./order-service-shared");
const { transitionOrder } = require("./order-transition-service");

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

module.exports = {
  MAX_COUNTER_DRAFT_UNITS,
  normalizeCounterDraftIntent,
  replayCounterKitchenSubmission,
  counterOrderPrebill,
  sentCounterWhere,
  listSentCounterOrders,
  getSentCounterOrder,
  cancelSentCounterOrder,
  counterCartSnapshot,
  createCounterOrder,
  createAndSettleCounterOrder,
  draftBillLines,
  quoteCounterDraft,
  checkoutCounterDraft,
};
