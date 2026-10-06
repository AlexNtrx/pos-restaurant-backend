const {
  OrderDomainError,
  actorHistoryData,
  assertStaffActor,
} = require("./order-domain");

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
      "kassa",
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

module.exports = {
  ORDER_INCLUDE,
  submissionState,
  idempotencyConflict,
  verifyStaffActor,
  getExistingOrder,
  existingSettlement,
  expandBillDetails,
  recordEarlyCounterPayment,
};
