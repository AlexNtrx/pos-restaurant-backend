const { cancelLegacyBill } = require("../lib/bill-cancellation-service");
const prisma = require("../lib/prisma");
const dayjs = require("dayjs");
const { readBillHistory } = require("../lib/bill-history");

const {
  BUSINESS_TIME_ZONE,
  parseDateOnly,
  positiveInteger,
  cancellationReason,
} = require("../lib/bill-input");
const listSelect = {
  id: true,
  payDate: true,
  amount: true,
  payType: true,
  tableNo: true,
  serviceType: true,
  Orders: { select: { id: true }, orderBy: { id: "asc" }, take: 1 },
  status: true,
  cancelledAt: true,
  cancelReason: true,
  Refunds: {
    select: {
      amount: true,
      status: true,
      method: true,
      reference: true,
      completedAt: true,
      reservedByUserId: true,
      confirmedByUserId: true,
      reason: true,
    },
  },
  User: { select: { id: true, name: true } },
  CancelledBy: { select: { id: true, name: true } },
  BillSaleDetails: {
    select: {
      id: true,
      foodName: true,
      foodSizeName: true,
      tasteName: true,
      price: true,
      moneyAdded: true,
    },
  },
};

const {
  BillSaleDetails: _details,
  Refunds: _refunds,
  ...headerSelect
} = listSelect;
const boundedInteger = (value, min, max) =>
  typeof value === "number" &&
  Number.isInteger(value) &&
  value >= min &&
  value <= max;

module.exports = {
  history: async (req, res) => {
    const start = parseDateOnly(req.body?.startDate, "startDate");
    const end = parseDateOnly(req.body?.endDate, "endDate");
    if (start.error || end.error)
      return res.status(400).send({ error: start.error || end.error });
    const { page = 1, pageSize = 50, snapshotId } = req.body ?? {};
    if (
      start.date > end.date ||
      !boundedInteger(page, 1, 1_000_000) ||
      !boundedInteger(pageSize, 1, 100) ||
      (snapshotId !== undefined &&
        !boundedInteger(snapshotId, 0, 2_147_483_647))
    )
      return res
        .status(400)
        .send({ error: "Invalid history range or pagination" });
    const endExclusive = dayjs(end.date)
      .tz(BUSINESS_TIME_ZONE)
      .add(1, "day")
      .startOf("day")
      .toDate();
    res.set("Cache-Control", "no-store");
    try {
      const result = await readBillHistory(prisma, {
        where: {
          payDate: { gte: start.date, lt: endExclusive },
          status: { in: ["use", "cancelled"] },
        },
        page,
        pageSize,
        snapshotId,
        headerSelect,
      });
      return res.send(result);
    } catch {
      return res.status(500).send({ error: "Unable to list bill history" });
    }
  },

  detail: async (req, res) => {
    const id = /^\d+$/.test(req.params.id) ? Number(req.params.id) : 0;
    if (!boundedInteger(id, 1, 2_147_483_647))
      return res.status(400).send({ error: "Valid bill id is required" });
    res.set("Cache-Control", "no-store");
    try {
      const result = await prisma.billSale.findFirst({
        where: { id, status: { in: ["use", "cancelled"] } },
        select: {
          ...listSelect,
          BillSaleDetails: {
            ...listSelect.BillSaleDetails,
            orderBy: { id: "asc" },
          },
          Refunds: { ...listSelect.Refunds, orderBy: { id: "asc" } },
        },
      });
      if (!result) return res.status(404).send({ error: "Bill not found" });
      return res.send({ result });
    } catch {
      return res.status(500).send({ error: "Unable to load bill" });
    }
  },

  // Coordinates list behavior for this module.
  list: async (req, res) => {
    const start = parseDateOnly(req.body?.startDate, "startDate");
    const end = parseDateOnly(req.body?.endDate, "endDate");
    if (start.error || end.error)
      return res.status(400).send({ error: start.error || end.error });
    if (start.date > end.date)
      return res
        .status(400)
        .send({ error: "startDate must not be after endDate" });
    const endExclusive = dayjs(end.date)
      .tz(BUSINESS_TIME_ZONE)
      .add(1, "day")
      .startOf("day")
      .toDate();
    try {
      const results = await prisma.billSale.findMany({
        where: {
          payDate: { gte: start.date, lt: endExclusive },
          status: { in: ["use", "cancelled"] },
        },
        select: listSelect,
        orderBy: { payDate: "desc" },
      });
      const summary = results.reduce(
        (accumulator, bill) => {
          if (bill.status === "use") {
            accumulator.activeCount += 1;
            accumulator.activeAmount +=
              bill.amount -
              bill.Refunds.filter(
                (refund) => refund.status === "COMPLETED",
              ).reduce((sum, refund) => sum + refund.amount, 0);
          } else {
            accumulator.cancelledCount += 1;
            accumulator.cancelledAmount += bill.amount;
          }
          return accumulator;
        },
        {
          activeCount: 0,
          activeAmount: 0,
          cancelledCount: 0,
          cancelledAmount: 0,
        },
      );
      return res.send({ results, summary });
    } catch {
      return res.status(500).send({ error: "Unable to list bills" });
    }
  },

  // Removes or clears  using the existing workflow.
  remove: async (req, res) => {
    const id = positiveInteger(req.params.id);
    const reason = cancellationReason(req.body?.reason);
    if (!id)
      return res.status(400).send({ error: "Valid bill id is required" });
    if (!reason)
      return res
        .status(400)
        .send({ error: "Cancellation reason must be 3-500 characters" });
    try {
      const result = await cancelLegacyBill(prisma, {
        id,
        reason,
        actorId: req.user.id,
      });
      if (result)
        return res.status(result.status).send({ error: result.error });
      return res.send({ message: "success" });
    } catch (error) {
      if (error?.code === "P2034")
        return res
          .status(409)
          .send({ error: "Bill cancellation conflicted; try again" });
      return res.status(500).send({ error: "Unable to cancel bill" });
    }
  },
};
