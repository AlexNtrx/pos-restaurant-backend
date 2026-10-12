const prisma = require("./prisma");
const { eurosToCents, centsToEuros, checkedCents } = require("./money");
const { createAndSettleCounterOrder } = require("./counter-order-service");
const { OrderDomainError } = require("./order-domain");
const { finalizeBillVat } = require("./vat");
const { captureReceiptIdentity } = require("./receipt-identity");
const {
  positiveInteger,
  CheckoutError,
  LegacyCartError,
  loadCheckoutSnapshot,
  completedCheckoutResponse,
  checkoutFingerprint,
  CHECKOUT_KEY_PATTERN,
  PAYMENT_TYPES,
} = require("./legacy-checkout-state");
const endSale = async (request) => {
  try {
    const tableNo = positiveInteger(request.body.tableNo);
    const payType = request.body.payType;
    const idempotencyKey = request.body.idempotencyKey;
    if (!tableNo)
      throw new LegacyCartError(400, {
        error: "tableNo must be a positive integer",
      });
    if (!PAYMENT_TYPES.has(payType))
      throw new LegacyCartError(400, { error: "payType must be cash or bank" });
    if (
      typeof idempotencyKey !== "string" ||
      !CHECKOUT_KEY_PATTERN.test(idempotencyKey)
    ) {
      throw new LegacyCartError(400, {
        error: "idempotencyKey must be a UUID",
      });
    }

    let requestedInputMoney = null;
    if (payType === "cash") {
      const cents = eurosToCents(request.body.inputMoney);
      if (cents === null) {
        throw new LegacyCartError(400, {
          error:
            "inputMoney must be non-negative EUR with at most two decimal places",
        });
      }
      requestedInputMoney = centsToEuros(cents);
    }

    const fingerprint = checkoutFingerprint({
      tableNo,
      payType,
      inputMoney: requestedInputMoney,
    });

    // Coordinates execute checkout while preserving transaction behavior.
    const executeCheckout = () =>
      prisma.$transaction(
        async (tx) => {
          await tx.$executeRaw`SELECT pg_advisory_xact_lock(${request.user.id}::int, ${tableNo}::int)`;
          const existing = await tx.billSale.findFirst({
            where: { userId: request.user.id, idempotencyKey },
          });
          if (existing) {
            if (existing.checkoutFingerprint !== fingerprint) {
              throw new CheckoutError(
                409,
                "Idempotency key was already used for another checkout",
              );
            }
            return completedCheckoutResponse(existing, true);
          }

          const snapshot = await loadCheckoutSnapshot(
            tx,
            request.user.id,
            tableNo,
          );
          const inputMoney =
            payType === "bank"
              ? snapshot.amount
              : eurosToCents(requestedInputMoney);
          if (inputMoney < snapshot.amount) {
            throw new CheckoutError(
              400,
              "Received amount is less than the total",
            );
          }
          const returnMoney =
            payType === "bank"
              ? 0n
              : checkedCents(inputMoney - snapshot.amount);

          // EN: Disabling the bridge restores legacy checkout without deleting prior Orders.
          // FI: Sovittimen poistaminen käytöstä palauttaa vanhan maksupolun poistamatta aiempia tilauksia.
          const vat = finalizeBillVat(snapshot.lines, snapshot.amount);
          const receiptSnapshot =
            process.env.ORD02_COUNTER_CHECKOUT_ENABLED === "false"
              ? await captureReceiptIdentity(tx, request.user.id)
              : null;
          const bill =
            process.env.ORD02_COUNTER_CHECKOUT_ENABLED === "false"
              ? await tx.billSale.create({
                  data: {
                    receiptSnapshot,
                    amount: snapshot.amount,
                    inputMoney,
                    returnMoney,
                    payType,
                    tableNo,
                    userId: request.user.id,
                    idempotencyKey,
                    checkoutFingerprint: fingerprint,
                    ...vat.vatData,
                    BillSaleDetails: { create: vat.lines },
                  },
                })
              : await createAndSettleCounterOrder(tx, {
                  actor: {
                    type: "STAFF",
                    userId: request.user.id,
                    level: request.user.level,
                  },
                  idempotencyKey,
                  tableNo,
                  lines: snapshot.lines,
                  amount: snapshot.amount,
                  payType,
                  inputMoney,
                  checkoutFingerprint: fingerprint,
                });

          const cartIds = snapshot.carts.map(({ id }) => id);
          await tx.saleTempDetail.deleteMany({
            where: { saleTempId: { in: cartIds } },
          });
          await tx.saleTemp.deleteMany({
            where: { id: { in: cartIds }, userId: request.user.id, tableNo },
          });
          return completedCheckoutResponse(bill);
        },
        { isolationLevel: "Serializable" },
      );

    for (let attempt = 0; attempt < 3; attempt += 1) {
      try {
        return await executeCheckout();
      } catch (error) {
        if (error?.code === "P2034" && attempt < 2) continue;
        if (error?.code === "P2002") {
          const existing = await prisma.billSale.findFirst({
            where: { userId: request.user.id, idempotencyKey },
          });
          if (existing?.checkoutFingerprint === fingerprint) {
            return completedCheckoutResponse(existing, true);
          }
          throw new LegacyCartError(409, { error: "Idempotency key conflict" });
        }
        throw error;
      }
    }
  } catch (e) {
    if (e instanceof RangeError)
      throw new LegacyCartError(400, {
        error: "Payment amount cannot be represented exactly",
      });
    if (e instanceof CheckoutError || e instanceof OrderDomainError)
      throw new LegacyCartError(e.status, { error: e.message });
    throw e;
  }
};
module.exports = { endSale };
