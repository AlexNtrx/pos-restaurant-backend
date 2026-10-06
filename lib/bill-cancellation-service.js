const { Prisma } = require("@prisma/client");
// EN: Cancel legacy bills atomically; linked Orders must use the guarded refund workflow.
// FI: Peruuta vanhat kuitit atomisesti; liittyvät tilaukset käyttävät suojattua palautustyönkulkua.
const cancelLegacyBill = (prisma, { id, reason, actorId }) =>
  prisma.$transaction(
    async (tx) => {
      const bill = await tx.billSale.findFirst({
        where: { id },
        select: {
          id: true,
          status: true,
          Orders: { select: { id: true } },
        },
      });
      if (!bill) return { status: 404, error: "Bill not found" };
      // EN: Linked Order payments must use the guarded refund flow; voiding a bill cannot bypass Kitchen rules.
      // FI: Tilaukseen liittyvä maksu käyttää suojattua palautusta; kuitin mitätöinti ei ohita keittiön sääntöjä.
      if (bill.Orders.length > 0)
        return {
          status: 409,
          error: "Use Order cancellation and refund before preparation",
        };
      if (bill.status !== "use")
        return {
          status: 409,
          error: "Only an active bill can be cancelled",
        };
      await tx.billSale.update({
        where: { id },
        data: {
          status: "cancelled",
          cancelledAt: new Date(),
          cancelledByUserId: actorId,
          cancelReason: reason,
        },
      });
      return null;
    },
    { isolationLevel: Prisma.TransactionIsolationLevel.Serializable },
  );
module.exports = { cancelLegacyBill };
