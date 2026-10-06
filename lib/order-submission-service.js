const { Prisma } = require("@prisma/client");
const { resolveQrAccess } = require("./table-service");
const {
  OrderDomainError,
  assertIdempotencyKey,
  assertStaffActor,
} = require("./order-domain");
const {
  buildOrderSnapshot,
  fingerprintOrderIntent,
  normalizeOrderIntent,
} = require("./order-pricing");
const {
  ORDER_INCLUDE,
  submissionState,
  idempotencyConflict,
  verifyStaffActor,
  getExistingOrder,
} = require("./order-service-shared");

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

module.exports = { submissionScope, submitOrder };
