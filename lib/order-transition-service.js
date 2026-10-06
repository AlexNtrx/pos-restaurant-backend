const { Prisma } = require("@prisma/client");
const {
  OrderDomainError,
  STATUS_TIMESTAMP_FIELD,
  actorHistoryData,
  assertPositiveInteger,
  authorizeTransition,
} = require("./order-domain");
const { ORDER_INCLUDE, verifyStaffActor } = require("./order-service-shared");

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

module.exports = { transitionOrder };
