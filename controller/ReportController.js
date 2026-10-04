const prisma = require("../lib/prisma");
const { readSalesBuckets } = require("../lib/sales-report");

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
      const buckets = await readSalesBuckets(prisma, {
        start,
        endExclusive,
        bucket: "day",
      });
      const amountsByDay = new Map(
        buckets.map(({ bucket, amount }) => [bucket, amount]),
      );
      const daysInMonth = new Date(Date.UTC(year, month, 0)).getUTCDate();
      const results = Array.from({ length: daysInMonth }, (_, index) => {
        const date = new Date(Date.UTC(year, month - 1, index + 1))
          .toISOString()
          .slice(0, 10);
        return { date, amount: amountsByDay.get(index + 1) || 0 };
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
      const buckets = await readSalesBuckets(prisma, {
        start,
        endExclusive,
        bucket: "month",
      });
      const amountsByMonth = new Map(
        buckets.map(({ bucket, amount }) => [bucket, amount]),
      );
      const results = Array.from({ length: 12 }, (_, index) => ({
        month: String(index + 1).padStart(2, "0"),
        amount: amountsByMonth.get(index + 1) || 0,
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
