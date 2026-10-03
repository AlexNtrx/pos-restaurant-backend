const prisma = require("../lib/prisma");

const MIN_REPORT_YEAR = 2000;
const MAX_REPORT_YEAR = 2100;

// Coordinates report integer behavior for this module.
const reportInteger = (value, minimum, maximum) => {
  const parsed = Number(value);
  return Number.isInteger(parsed) && parsed >= minimum && parsed <= maximum
    ? parsed
    : null;
};

// Coordinates utc month bounds behavior for this module.
const utcMonthBounds = (year, month) => ({
  start: new Date(Date.UTC(year, month - 1, 1)),
  endExclusive: new Date(Date.UTC(year, month, 1)),
});

// Coordinates utc year bounds behavior for this module.
const utcYearBounds = (year) => ({
  start: new Date(Date.UTC(year, 0, 1)),
  endExclusive: new Date(Date.UTC(year + 1, 0, 1)),
});

module.exports = {
  // Coordinates sum per day in year and month behavior for this module.
  sumPerDayInYearAndMonth: async (req, res) => {
    const year = reportInteger(
      req.body?.year,
      MIN_REPORT_YEAR,
      MAX_REPORT_YEAR,
    );
    const month = reportInteger(req.body?.month, 1, 12);
    if (!year || !month) {
      return res
        .status(400)
        .send({ error: "year and month must be valid calendar values" });
    }

    try {
      const { start, endExclusive } = utcMonthBounds(year, month);
      const bills = await prisma.billSale.findMany({
        where: { payDate: { gte: start, lt: endExclusive }, status: "use" },
        select: {
          payDate: true,
          amount: true,
          Refunds: { where: { status: "COMPLETED" }, select: { amount: true } },
        },
      });
      const amountsByDay = new Map();
      for (const bill of bills) {
        const date = bill.payDate.toISOString().slice(0, 10);
        // EN: Restate the original sale period only for confirmed returns; pending refunds remain paid revenue.
        // FI: Oikaise alkuperäinen myyntijakso vain vahvistetuilla palautuksilla; keskeneräinen palautus jää maksetuksi myynniksi.
        const net =
          bill.amount -
          bill.Refunds.reduce((sum, refund) => sum + refund.amount, 0);
        amountsByDay.set(date, (amountsByDay.get(date) || 0) + net);
      }
      const daysInMonth = new Date(Date.UTC(year, month, 0)).getUTCDate();
      const results = Array.from({ length: daysInMonth }, (_, index) => {
        const date = new Date(Date.UTC(year, month - 1, index + 1))
          .toISOString()
          .slice(0, 10);
        return { date, amount: amountsByDay.get(date) || 0 };
      });
      const totalAmount = results.reduce((sum, item) => sum + item.amount, 0);
      return res.send({ results, totalAmount });
    } catch {
      return res
        .status(500)
        .send({ error: "Unable to generate daily sales report" });
    }
  },
  // Coordinates sum monthly behavior for this module.
  sumMonthly: async (req, res) => {
    const year = reportInteger(
      req.body?.year,
      MIN_REPORT_YEAR,
      MAX_REPORT_YEAR,
    );
    if (!year) {
      return res
        .status(400)
        .send({ error: "year must be a valid calendar value" });
    }

    try {
      const { start, endExclusive } = utcYearBounds(year);
      const bills = await prisma.billSale.findMany({
        where: { payDate: { gte: start, lt: endExclusive }, status: "use" },
        select: {
          payDate: true,
          amount: true,
          Refunds: { where: { status: "COMPLETED" }, select: { amount: true } },
        },
      });
      const amountsByMonth = new Array(12).fill(0);
      for (const bill of bills) {
        amountsByMonth[bill.payDate.getUTCMonth()] +=
          bill.amount -
          bill.Refunds.reduce((sum, refund) => sum + refund.amount, 0);
      }
      const results = amountsByMonth.map((amount, index) => ({
        month: String(index + 1).padStart(2, "0"),
        amount,
      }));
      const totalAmount = results.reduce((sum, item) => sum + item.amount, 0);
      return res.send({ results, totalAmount });
    } catch {
      return res
        .status(500)
        .send({ error: "Unable to generate monthly sales report" });
    }
  },
};
