const { Prisma } = require("@prisma/client");
const prisma = require("../lib/prisma");
const dayjs = require("dayjs");
const utc = require("dayjs/plugin/utc");
const timezone = require("dayjs/plugin/timezone");

const BUSINESS_TIME_ZONE = "Europe/Helsinki";
dayjs.extend(utc);
dayjs.extend(timezone);

// Coordinates positive integer behavior for this module.
const positiveInteger = (value) => {
  const parsed = Number(value);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : null;
};

// Parses and validates date only responses.
const parseDateOnly = (value, fieldName) => {
  if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(value))
    return { error: `${fieldName} must be YYYY-MM-DD` };
  const [year, month, day] = value.split("-").map(Number);
  const validationDate = new Date(Date.UTC(year, month - 1, day));
  if (
    validationDate.getUTCFullYear() !== year ||
    validationDate.getUTCMonth() !== month - 1 ||
    validationDate.getUTCDate() !== day
  )
    return { error: `${fieldName} is invalid` };
  return {
    date: dayjs
      .tz(value, "YYYY-MM-DD", BUSINESS_TIME_ZONE)
      .startOf("day")
      .toDate(),
  };
};

// Coordinates cancellation reason behavior for this module.
const cancellationReason = (value) => {
  const reason = typeof value === "string" ? value.trim() : "";
  return reason.length >= 3 && reason.length <= 500 ? reason : null;
};

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

module.exports = {
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
            accumulator.activeAmount += bill.amount;
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
      const result = await prisma.$transaction(
        async (tx) => {
          const bill = await tx.billSale.findFirst({
            where: { id },
            select: { id: true, status: true },
          });
          if (!bill) return { status: 404, error: "Bill not found" };
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
              cancelledByUserId: req.user.id,
              cancelReason: reason,
            },
          });
          return null;
        },
        { isolationLevel: Prisma.TransactionIsolationLevel.Serializable },
      );
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
