const reads = require("../lib/legacy-receipt-service");
const { ReceiptReadError } = require("../lib/receipt-read-error");
const prisma = require("../lib/prisma");

const { sendReceiptPdf } = require("../lib/receipt-pdf");
const legacyCart = require("../lib/legacy-cart-service");
const legacyCheckout = require("../lib/legacy-checkout-service");
const {
  positiveInteger,
  CheckoutError,
  LegacyCartError,
  CHECKOUT_KEY_PATTERN,
} = require("../lib/legacy-checkout-state");

// Coordinates send unexpected error behavior for this module.
const sendUnexpectedError = (res, error) => {
  console.error(error);
  return res.status(500).send({ error: "Internal server error" });
};

module.exports = {
  // Creates  with the current contract.
  create: async (req, res) => {
    try {
      return res.send(
        await legacyCart.create({
          user: req.user,
          body: req.body,
          query: req.query,
          params: req.params,
        }),
      );
    } catch (error) {
      if (error instanceof LegacyCartError)
        return res.status(error.status).send(error.body);
      return sendUnexpectedError(res, error);
    }
  },
  // Coordinates list behavior for this module.
  list: async (req, res) => {
    try {
      return res.send(
        await legacyCart.list({
          user: req.user,
          body: req.body,
          query: req.query,
          params: req.params,
        }),
      );
    } catch (error) {
      if (error instanceof LegacyCartError)
        return res.status(error.status).send(error.body);
      return sendUnexpectedError(res, error);
    }
  },
  // Removes or clears  using the existing workflow.
  remove: async (req, res) => {
    try {
      return res.send(
        await legacyCart.remove({
          user: req.user,
          body: req.body,
          query: req.query,
          params: req.params,
        }),
      );
    } catch (error) {
      if (error instanceof LegacyCartError)
        return res.status(error.status).send(error.body);
      return sendUnexpectedError(res, error);
    }
  },
  // Removes or clears all using the existing workflow.
  removeAll: async (req, res) => {
    try {
      return res.send(
        await legacyCart.removeAll({
          user: req.user,
          body: req.body,
          query: req.query,
          params: req.params,
        }),
      );
    } catch (error) {
      if (error instanceof LegacyCartError)
        return res.status(error.status).send(error.body);
      return sendUnexpectedError(res, error);
    }
  },
  // Updates qty without changing user-visible behavior.
  updateQty: async (req, res) => {
    try {
      return res.send(
        await legacyCart.updateQty({
          user: req.user,
          body: req.body,
          query: req.query,
          params: req.params,
        }),
      );
    } catch (error) {
      if (error instanceof LegacyCartError)
        return res.status(error.status).send(error.body);
      return sendUnexpectedError(res, error);
    }
  },
  // Coordinates generate sale temp detail behavior for this module.
  generateSaleTempDetail: async (req, res) => {
    try {
      return res.send(
        await legacyCart.generateSaleTempDetail({
          user: req.user,
          body: req.body,
          query: req.query,
          params: req.params,
        }),
      );
    } catch (error) {
      if (error instanceof LegacyCartError)
        return res.status(error.status).send(error.body);
      return sendUnexpectedError(res, error);
    }
  },
  // Coordinates info behavior for this module.
  info: async (req, res) => {
    try {
      return res.send(
        await legacyCart.info({
          user: req.user,
          body: req.body,
          query: req.query,
          params: req.params,
        }),
      );
    } catch (error) {
      if (error instanceof LegacyCartError)
        return res.status(error.status).send(error.body);
      return sendUnexpectedError(res, error);
    }
  },
  // Updates taste without changing user-visible behavior.
  selectTaste: async (req, res) => {
    try {
      return res.send(
        await legacyCart.selectTaste({
          user: req.user,
          body: req.body,
          query: req.query,
          params: req.params,
        }),
      );
    } catch (error) {
      if (error instanceof LegacyCartError)
        return res.status(error.status).send(error.body);
      return sendUnexpectedError(res, error);
    }
  },
  // Coordinates un select taste behavior for this module.
  unSelectTaste: async (req, res) => {
    try {
      return res.send(
        await legacyCart.unSelectTaste({
          user: req.user,
          body: req.body,
          query: req.query,
          params: req.params,
        }),
      );
    } catch (error) {
      if (error instanceof LegacyCartError)
        return res.status(error.status).send(error.body);
      return sendUnexpectedError(res, error);
    }
  },
  // Updates size without changing user-visible behavior.
  selectSize: async (req, res) => {
    try {
      return res.send(
        await legacyCart.selectSize({
          user: req.user,
          body: req.body,
          query: req.query,
          params: req.params,
        }),
      );
    } catch (error) {
      if (error instanceof LegacyCartError)
        return res.status(error.status).send(error.body);
      return sendUnexpectedError(res, error);
    }
  },
  // Creates sale temp detail with the current contract.
  createSaleTempDetail: async (req, res) => {
    try {
      return res.send(
        await legacyCart.createSaleTempDetail({
          user: req.user,
          body: req.body,
          query: req.query,
          params: req.params,
        }),
      );
    } catch (error) {
      if (error instanceof LegacyCartError)
        return res.status(error.status).send(error.body);
      return sendUnexpectedError(res, error);
    }
  },
  // Removes or clears sale temp detail modal using the existing workflow.
  removeSaleTempDetailModal: async (req, res) => {
    try {
      return res.send(
        await legacyCart.removeSaleTempDetailModal({
          user: req.user,
          body: req.body,
          query: req.query,
          params: req.params,
        }),
      );
    } catch (error) {
      if (error instanceof LegacyCartError)
        return res.status(error.status).send(error.body);
      return sendUnexpectedError(res, error);
    }
  },
  // Coordinates print bill after pay behavior for this module.
  printBillAfterPay: async (req, res) => {
    try {
      const result = await reads.printBillAfterPay({
        body: req.body,
        params: req.params,
        user: req.user,
      });
      return await sendReceiptPdf(
        res,
        result.organization,
        result.receipt,
        result.filename,
      );
    } catch (e) {
      if (e instanceof ReceiptReadError)
        return res.status(e.status).send(e.body);
      return sendUnexpectedError(res, e);
    }
  },
  // Coordinates print bill before pay behavior for this module.
  printBillBeforePay: async (req, res) => {
    try {
      const result = await reads.printBillBeforePay({
        body: req.body,
        params: req.params,
        user: req.user,
      });
      return await sendReceiptPdf(
        res,
        result.organization,
        result.receipt,
        result.filename,
      );
    } catch (e) {
      if (e instanceof ReceiptReadError)
        return res.status(e.status).send(e.body);
      if (e instanceof CheckoutError)
        return res.status(e.status).send({ error: e.message });
      return sendUnexpectedError(res, e);
    }
  },
  // Coordinates end sale behavior for this module.
  endSale: async (req, res) => {
    try {
      return res.send(
        await legacyCheckout.endSale({
          user: req.user,
          body: req.body,
          query: req.query,
          params: req.params,
        }),
      );
    } catch (error) {
      if (error instanceof LegacyCartError)
        return res.status(error.status).send(error.body);
      return sendUnexpectedError(res, error);
    }
  },
  // EN: A retired unpaid submission can replay a committed Order; a new Counter Order requires payment.
  // FI: Poistettu maksamaton lähetys voi palauttaa tallennetun tilauksen; uusi kassatilaus edellyttää maksua.
  submitToKitchen: async (req, res) => {
    const tableNo = positiveInteger(req.body?.tableNo);
    const idempotencyKey = req.body?.idempotencyKey;
    if (!tableNo)
      return res
        .status(400)
        .send({ error: "tableNo must be a positive integer" });
    if (
      typeof idempotencyKey !== "string" ||
      !CHECKOUT_KEY_PATTERN.test(idempotencyKey)
    )
      return res.status(400).send({ error: "idempotencyKey must be a UUID" });
    try {
      const existing = await prisma.order.findUnique({
        where: {
          idempotencyScope_idempotencyKey: {
            idempotencyScope: "COUNTER_KITCHEN_USER:" + req.user.id,
            idempotencyKey: idempotencyKey.toLowerCase(),
          },
        },
      });
      if (existing) {
        if (existing.channel !== "COUNTER" || existing.tableNo !== tableNo)
          return res.status(409).send({ error: "Idempotency key conflict" });
        return res.send({
          orderId: existing.id,
          status: existing.status,
          total: existing.total,
          replayed: true,
        });
      }
      return res.status(409).send({
        error: "Payment is required before sending a Counter Order to Kitchen",
        code: "PAYMENT_REQUIRED",
      });
    } catch (error) {
      return sendUnexpectedError(res, error);
    }
  },
  // EN: Counter pending orders are scoped to the signed-in cashier until shared table sessions exist.
  // FI: Kassaamisen odottavat tilaukset rajataan kirjautuneeseen työntekijään, kunnes yhteiset pöytäistunnot ovat käytössä.
  pendingCounterOrders: async (req, res) => {
    const tableNo = positiveInteger(req.query?.tableNo);
    if (!tableNo)
      return res
        .status(400)
        .send({ error: "tableNo must be a positive integer" });
    try {
      const orders = await prisma.order.findMany({
        where: {
          channel: "COUNTER",
          createdByUserId: req.user.id,
          tableNo,
          billSaleId: null,
          status: { notIn: ["REJECTED", "CANCELLED"] },
        },
        orderBy: { id: "desc" },
        take: 100,
        select: {
          id: true,
          status: true,
          total: true,
          version: true,
          submittedAt: true,
          Items: {
            select: { foodName: true, quantity: true },
            orderBy: { id: "asc" },
          },
        },
      });
      return res.send({ results: orders });
    } catch (error) {
      return sendUnexpectedError(res, error);
    }
  },
};
