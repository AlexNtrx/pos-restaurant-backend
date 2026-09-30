const prisma = require("../lib/prisma");
const { OrderDomainError } = require("../lib/order-domain");
const { settleCounterOrder } = require("../lib/order-service");
const { sendReceiptPdf } = require("../lib/receipt-pdf");
const { rejectClientFinancialAuthority } = require("../lib/order-pricing");
const { staffOrderDto } = require("../lib/staff-order-service");
const {
  cancelSentCounterOrder,
  checkoutCounterDraft,
  counterOrderPrebill,
  draftBillLines,
  getSentCounterOrder,
  listSentCounterOrders,
  quoteCounterDraft,
  replayCounterKitchenSubmission,
  normalizeCounterDraftIntent,
} = require("../lib/order-service");

const actorFor = (req) => ({
  type: "STAFF",
  userId: req.user.id,
  level: req.user.level,
});

const sendError = (res, error) => {
  if (error instanceof OrderDomainError)
    return res
      .status(error.status)
      .send({ error: error.message, code: error.code });
  console.error(error);
  return res.status(500).send({ error: "Unable to process Counter Order" });
};

module.exports = {
  // EN: Quote and prebill always reprice client identifiers against the active catalog.
  // FI: Hinta-arvio ja ennakkolasku hinnoittelevat asiakkaan tunnisteet aina aktiivisesta luettelosta.
  quote: async (req, res) => {
    try {
      const { snapshot } = await quoteCounterDraft(prisma, req.body);
      return res.send({ results: snapshot });
    } catch (error) {
      return sendError(res, error);
    }
  },
  options: async (req, res) => {
    try {
      const foodId = Number(req.params.foodId);
      if (!Number.isSafeInteger(foodId) || foodId <= 0)
        return res.status(400).send({ error: "Invalid foodId" });
      const food = await prisma.food.findFirst({
        where: { id: foodId, status: "use" },
        include: {
          FoodType: {
            include: {
              tastes: { where: { status: "use" } },
              foodSizes: { where: { status: "use" } },
            },
          },
        },
      });
      if (!food || food.FoodType.status !== "use")
        return res.status(404).send({ error: "Food unavailable" });
      return res.send({
        results: {
          tastes: food.FoodType.tastes.map(({ id, name }) => ({ id, name })),
          foodSizes: food.FoodType.foodSizes.map(
            ({ id, name, moneyAdded }) => ({ id, name, moneyAdded }),
          ),
        },
      });
    } catch (error) {
      return sendError(res, error);
    }
  },
  submit: async (req, res) => {
    try {
      rejectClientFinancialAuthority(req.body);
      const intent = normalizeCounterDraftIntent(req.body);
      const order = await replayCounterKitchenSubmission(prisma, {
        actor: actorFor(req),
        idempotencyKey: req.body?.idempotencyKey,
        intent,
      });
      return res.send({
        orderId: order.id,
        status: order.status,
        total: order.total,
      });
    } catch (error) {
      return sendError(res, error);
    }
  },
  checkout: async (req, res) => {
    try {
      const {
        tableNo,
        serviceType,
        items,
        idempotencyKey,
        payType,
        inputMoney,
        expectedTotal,
        ...untrustedFields
      } = req.body ?? {};
      rejectClientFinancialAuthority({ items, ...untrustedFields });
      const bill = await checkoutCounterDraft(prisma, {
        actor: actorFor(req),
        idempotencyKey,
        intent: { tableNo, serviceType, items },
        expectedTotal,
        payType,
        inputMoney,
      });
      return res.send({
        message: "success",
        billId: bill.id,
        amount: bill.amount,
        inputMoney: bill.inputMoney,
        returnMoney: bill.returnMoney,
        ...(bill.serviceType === "TAKEAWAY"
          ? { pickupNo: bill.Orders[0].id }
          : {}),
      });
    } catch (error) {
      return sendError(res, error);
    }
  },
  prebill: async (req, res) => {
    try {
      const organization = await prisma.organization.findFirst();
      if (!organization)
        return res
          .status(409)
          .send({ error: "Organization is not configured" });
      const { snapshot } = await quoteCounterDraft(prisma, req.body);
      return sendReceiptPdf(
        res,
        organization,
        {
          title: "Esilasku",
          cashierName: req.user.name,
          tableNo: snapshot.tableNo,
          serviceType: snapshot.serviceType ?? "DINE_IN",
          date: new Date(),
          lines: draftBillLines(snapshot),
          amount: snapshot.total,
          inputMoney: null,
          returnMoney: null,
          payType: null,
        },
        snapshot.serviceType === "TAKEAWAY"
          ? "bill-preview-takeaway.pdf"
          : `bill-preview-table-${snapshot.tableNo}.pdf`,
      );
    } catch (error) {
      return sendError(res, error);
    }
  },
  sentPrebill: async (req, res) => {
    try {
      const order = await counterOrderPrebill(prisma, {
        actor: actorFor(req),
        orderId: Number(req.params.id),
      });
      const organization = await prisma.organization.findFirst();
      if (!organization)
        return res
          .status(409)
          .send({ error: "Organization is not configured" });
      return sendReceiptPdf(
        res,
        organization,
        {
          title: "Esilasku",
          cashierName: req.user.name,
          tableNo: order.tableNo,
          serviceType: order.serviceType,
          pickupNo: order.serviceType === "TAKEAWAY" ? order.id : null,
          date: order.submittedAt,
          lines: order.lines,
          amount: order.total,
          inputMoney: null,
          returnMoney: null,
          payType: null,
        },
        `bill-preview-order-${order.id}.pdf`,
      );
    } catch (error) {
      return sendError(res, error);
    }
  },
  listSent: async (req, res) => {
    res.set("Cache-Control", "no-store");
    try {
      const results = await listSentCounterOrders(prisma, {
        actor: actorFor(req),
        tableNo: req.query.tableNo == null ? null : Number(req.query.tableNo),
        serviceType: req.query.serviceType ?? "DINE_IN",
        view: req.query.view ?? "all",
      });
      return res.send({ results });
    } catch (error) {
      return sendError(res, error);
    }
  },
  sentDetail: async (req, res) => {
    res.set("Cache-Control", "no-store");
    try {
      const order = await getSentCounterOrder(prisma, {
        actor: actorFor(req),
        orderId: Number(req.params.id),
      });
      return res.send({ result: staffOrderDto(order, { history: true }) });
    } catch (error) {
      return sendError(res, error);
    }
  },
  cancelSent: async (req, res) => {
    res.set("Cache-Control", "no-store");
    try {
      const body = req.body;
      if (
        !body ||
        typeof body !== "object" ||
        Array.isArray(body) ||
        Object.keys(body).some(
          (key) => !["expectedVersion", "reason"].includes(key),
        )
      )
        return res.status(400).send({ error: "Invalid cancellation body" });
      const order = await cancelSentCounterOrder(prisma, {
        actor: actorFor(req),
        orderId: Number(req.params.id),
        expectedVersion: body.expectedVersion,
        reason: body.reason,
      });
      return res.send({ result: staffOrderDto(order, { history: true }) });
    } catch (error) {
      return sendError(res, error);
    }
  },
  settle: async (req, res) => {
    try {
      const body = req.body ?? {};
      const bill = await settleCounterOrder(prisma, {
        actor: { type: "STAFF", userId: req.user.id, level: req.user.level },
        orderId: Number(req.params.id),
        expectedVersion: body.expectedVersion,
        idempotencyKey: body.idempotencyKey,
        payType: body.payType,
        inputMoney: body.inputMoney,
      });
      return res.send({
        message: "success",
        billId: bill.id,
        amount: bill.amount,
        inputMoney: bill.inputMoney,
        returnMoney: bill.returnMoney,
      });
    } catch (error) {
      if (error instanceof OrderDomainError)
        return res
          .status(error.status)
          .send({ error: error.message, code: error.code });
      console.error(error);
      return res.status(500).send({ error: "Unable to settle Counter Order" });
    }
  },
};
