const { Prisma } = require("@prisma/client");
const {
  OrderDomainError,
  assertPositiveInteger,
  assertIdempotencyKey,
} = require("./order-domain");

const fail = (status, code, message) => {
  throw new OrderDomainError(status, code, message);
};
const text = (value, field, min = 3) => {
  if (
    typeof value !== "string" ||
    value.trim().length < min ||
    value.trim().length > 500
  )
    fail(400, "INVALID_INPUT", `${field} must be ${min}-500 characters`);
  return value.trim();
};
const strictBody = (body, allowed) => {
  if (
    !body ||
    typeof body !== "object" ||
    Array.isArray(body) ||
    Object.keys(body).some((key) => !allowed.includes(key))
  )
    fail(400, "INVALID_INPUT", "Unexpected refund fields");
};
// EN: Re-read admin authority inside the transaction; JWT claims and hidden UI cannot authorize refunds.
// FI: Tarkista ylläpitäjän oikeus transaktiossa; JWT-väitteet ja piilotettu käyttöliittymä eivät oikeuta palautuksiin.
const verifyAdmin = async (tx, actor) => {
  const user =
    actor?.type === "STAFF" && Number.isSafeInteger(actor.userId)
      ? await tx.user.findUnique({ where: { id: actor.userId } })
      : null;
  if (!user || user.status !== "use" || user.level !== "admin")
    fail(403, "FORBIDDEN", "Active admin is required");
  return user.id;
};
const transaction = async (prisma, operation) => {
  try {
    return await prisma.$transaction(operation, {
      isolationLevel: Prisma.TransactionIsolationLevel.Serializable,
    });
  } catch (error) {
    if (["P2034", "P2002"].includes(error?.code))
      fail(409, "REFUND_CONFLICT", "Refund conflicted; retry the same request");
    throw error;
  }
};

const getRefund = async (prisma, { actor, orderId }) => {
  const id = assertPositiveInteger(Number(orderId), "orderId");
  await verifyAdmin(prisma, actor);
  return prisma.orderRefund.findUnique({ where: { orderId: id } });
};

// EN: The versioned CANCELLED update competes with Kitchen's start in one transaction and reserves the refund without claiming money moved.
// FI: Versioitu CANCELLED-päivitys kilpailee keittiön aloituksen kanssa samassa transaktiossa ja varaa palautuksen väittämättä rahojen siirtyneen.
const reserveRefund = async (prisma, { actor, orderId, body }) => {
  const id = assertPositiveInteger(Number(orderId), "orderId");
  strictBody(body, ["expectedVersion", "idempotencyKey", "reason", "method"]);
  const version = assertPositiveInteger(
    body.expectedVersion,
    "expectedVersion",
  );
  const key = assertIdempotencyKey(body.idempotencyKey);
  const reason = text(body.reason, "reason");
  if (!["cash", "bank"].includes(body.method))
    fail(400, "INVALID_INPUT", "Invalid refund method");
  return transaction(prisma, async (tx) => {
    const userId = await verifyAdmin(tx, actor);
    const prior = await tx.orderRefund.findUnique({ where: { orderId: id } });
    if (prior) {
      if (
        prior.idempotencyKey !== key ||
        prior.reason !== reason ||
        prior.method !== body.method ||
        prior.reservedByUserId !== userId
      )
        fail(409, "IDEMPOTENCY_CONFLICT", "Refund reservation already exists");
      return prior;
    }
    const order = await tx.order.findUnique({
      where: { id },
      include: { BillSale: { include: { Orders: { select: { id: true } } } } },
    });
    if (!order) fail(404, "ORDER_NOT_FOUND", "Order was not found");
    if (order.version !== version)
      fail(409, "STALE_VERSION", "Order version is stale");
    if (
      !["SUBMITTED", "CONFIRMED"].includes(order.status) ||
      order.preparingAt !== null
    )
      fail(
        409,
        "ORDER_NOT_CANCELLABLE",
        "Preparation has already started or Order is terminal",
      );
    const bill = order.BillSale;
    if (!bill || !order.paidAt || bill.status !== "use")
      fail(409, "ORDER_NOT_PAID", "An active payment is required");
    if (bill.Orders.length !== 1 || bill.amount !== order.total)
      fail(
        409,
        "REFUND_SCOPE_CONFLICT",
        "Refund requires the original standalone payment",
      );
    const now = new Date();
    const updated = await tx.order.updateMany({
      where: { id, version, status: order.status, preparingAt: null },
      data: {
        status: "CANCELLED",
        version: { increment: 1 },
        cancelledAt: now,
        cancellationReason: reason,
      },
    });
    if (updated.count !== 1)
      fail(409, "STALE_VERSION", "Order changed before cancellation");
    await tx.orderStatusHistory.create({
      data: {
        orderId: id,
        fromStatus: order.status,
        toStatus: "CANCELLED",
        version: version + 1,
        actorType: "STAFF",
        actorUserId: userId,
        reason,
      },
    });
    return tx.orderRefund.create({
      data: {
        orderId: id,
        billSaleId: bill.id,
        idempotencyKey: key,
        amount: bill.amount,
        method: body.method,
        reason,
        reservedByUserId: userId,
      },
    });
  });
};

// EN: Completion records a manual return with evidence; it never calls a payment provider or overwrites the original payment.
// FI: Valmistuminen kirjaa käsin tehdyn palautuksen tositteineen; se ei kutsu maksupalvelua eikä korvaa alkuperäistä maksua.
const finishRefund = async (
  prisma,
  { actor, orderId, body, failed = false },
) => {
  const id = assertPositiveInteger(Number(orderId), "orderId");
  strictBody(body, ["idempotencyKey", failed ? "reason" : "reference"]);
  const key = assertIdempotencyKey(body.idempotencyKey);
  const evidence = text(
    failed ? body.reason : body.reference,
    failed ? "reason" : "reference",
  );
  return transaction(prisma, async (tx) => {
    const userId = await verifyAdmin(tx, actor);
    const refund = await tx.orderRefund.findUnique({ where: { orderId: id } });
    if (!refund)
      fail(404, "REFUND_NOT_FOUND", "Refund reservation was not found");
    if (refund.idempotencyKey !== key)
      fail(409, "IDEMPOTENCY_CONFLICT", "Wrong refund request");
    if (refund.status === "COMPLETED") {
      if (failed || refund.reference !== evidence)
        fail(409, "REFUND_ALREADY_COMPLETED", "Refund is already complete");
      return refund;
    }
    return tx.orderRefund.update({
      where: { id: refund.id },
      data: failed
        ? { status: "FAILED", failureReason: evidence }
        : {
            status: "COMPLETED",
            reference: evidence,
            confirmedByUserId: userId,
            completedAt: new Date(),
            failureReason: null,
          },
    });
  });
};
module.exports = { getRefund, reserveRefund, finishRefund };
