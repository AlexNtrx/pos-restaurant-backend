const { RESTAURANT_TIME_ZONE } = require("../lib/restaurant-calendar");

const calendar = new Intl.DateTimeFormat("en-CA", {
  timeZone: RESTAURANT_TIME_ZONE,
  year: "numeric",
  month: "2-digit",
});

const restaurantMonth = (date) => {
  const parts = Object.fromEntries(
    calendar.formatToParts(date).map(({ type, value }) => [type, value]),
  );
  return { year: Number(parts.year), month: Number(parts.month) };
};

// EN: The benchmark oracle groups stored sale timestamps independently of SQL; completed refunds restate the original sale month.
// FI: Kuormatestin vertailulaskenta ryhmittelee tallennetut myyntiajat SQL:stä riippumatta; valmiit palautukset oikaisevat alkuperäistä myyntikuukautta.
const expectedReportCents = (bills, refunds, year, month) => {
  const completed = new Map();
  for (const refund of refunds) {
    if (refund.status === "COMPLETED")
      completed.set(
        refund.billSaleId,
        (completed.get(refund.billSaleId) ?? 0n) + refund.amount,
      );
  }
  let net = 0n;
  for (const bill of bills) {
    const period = restaurantMonth(bill.payDate);
    if (bill.status === "use" && period.year === year && period.month === month)
      net += bill.amount - (completed.get(bill.id) ?? 0n);
  }
  return net;
};

module.exports = { restaurantMonth, expectedReportCents };
