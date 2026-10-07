const { Prisma } = require("@prisma/client");

const salesReportQuery = ({ start, endExclusive, bucket }) => {
  if (bucket !== "day" && bucket !== "month")
    throw new Error("Unsupported sales report bucket");
  // EN: Stored payDate timestamps represent UTC; explicit timestamp bounds preserve that calendar regardless of the database session timezone.
  // FI: Tallennetut payDate-aikaleimat ovat UTC-aikaa; aikaleimarajat säilyttävät kalenterin tietokantaistunnon aikavyöhykkeestä riippumatta.
  const period = Prisma.sql`b."status" = 'use'
    AND b."payDate" >= ${start.toISOString()}::timestamp
    AND b."payDate" < ${endExclusive.toISOString()}::timestamp`;
  // EN: Union signed amounts instead of joining refunds to sale totals: each bill is counted once and only completed refunds restate its original sale period.
  // FI: Yhdistä etumerkilliset summat liittämättä palautuksia myyntisummiin: kukin kuitti lasketaan kerran ja vain vahvistetut palautukset oikaisevat alkuperäistä myyntijaksoa.
  // EN: Sum integer units before converting each final bucket to the existing JSON number type; do not change money units.
  // FI: Laske kokonaislukuyksiköt yhteen ennen lopullisen ryhmäsumman muuntamista nykyiseen JSON-lukutyyppiin; rahayksiköt eivät muutu.
  return Prisma.sql`
    SELECT "bucket", SUM("amount")::double precision AS "amount"
    FROM (
      SELECT DATE_PART(${bucket}, b."payDate")::integer AS "bucket",
        b."amount"::bigint AS "amount"
      FROM "BillSale" b WHERE ${period}
      UNION ALL
      SELECT DATE_PART(${bucket}, b."payDate")::integer AS "bucket",
        -r."amount"::bigint AS "amount"
      FROM "OrderRefund" r
      JOIN "BillSale" b ON b."id" = r."billSaleId"
      WHERE ${period} AND r."status" = 'COMPLETED'
    ) entries
    GROUP BY "bucket" ORDER BY "bucket"`;
};

const readSalesBuckets = (prisma, period) =>
  prisma.$queryRaw(salesReportQuery(period));

const dailySalesBreakdownQuery = ({ start, endExclusive }) => {
  const salePeriod = Prisma.sql`b."status" = 'use'
    AND b."payDate" >= ${start.toISOString()}::timestamp
    AND b."payDate" < ${endExclusive.toISOString()}::timestamp`;
  // EN: Aggregate independent bill/refund/Order entries in one snapshot; cancellations never subtract revenue or multiply a shared bill.
  // FI: Laske erilliset lasku-, palautus- ja tilausrivit yhdessä tilannekuvassa; peruutukset eivät vähennä myyntiä tai monista yhteistä laskua.
  // EN: Refund statuses belong to the original UTC sale date; operational cancellations belong to their own UTC cancellation date.
  // FI: Palautustilat kuuluvat alkuperäiseen UTC-myyntipäivään; toiminnalliset peruutukset omaan UTC-peruutuspäiväänsä.
  return Prisma.sql`
    WITH entries AS (
      SELECT DATE_PART('day', b."payDate")::integer AS "bucket",
        'GROSS'::text AS "kind", b."amount"::bigint AS "amount"
      FROM "BillSale" b WHERE ${salePeriod}
      UNION ALL
      SELECT DATE_PART('day', b."payDate")::integer AS "bucket",
        r."status"::text AS "kind", r."amount"::bigint AS "amount"
      FROM "OrderRefund" r
      JOIN "BillSale" b ON b."id" = r."billSaleId"
      WHERE ${salePeriod}
      UNION ALL
      SELECT DATE_PART('day', o."cancelledAt")::integer AS "bucket",
        CASE WHEN o."paidAt" IS NULL THEN 'UNPAID_CANCELLED' ELSE 'PAID_CANCELLED' END AS "kind",
        o."total"::bigint AS "amount"
      FROM "Order" o
      WHERE o."status" = 'CANCELLED'
        AND o."cancelledAt" >= ${start.toISOString()}::timestamp
        AND o."cancelledAt" < ${endExclusive.toISOString()}::timestamp
    )
    SELECT "bucket",
      COALESCE(SUM("amount") FILTER (WHERE "kind" = 'GROSS'), 0)::double precision AS "grossAmount",
      COALESCE(SUM("amount") FILTER (WHERE "kind" = 'COMPLETED'), 0)::double precision AS "refundedAmount",
      COALESCE(SUM("amount") FILTER (WHERE "kind" = 'PENDING'), 0)::double precision AS "pendingRefundAmount",
      COALESCE(SUM("amount") FILTER (WHERE "kind" = 'FAILED'), 0)::double precision AS "failedRefundAmount",
      COUNT(*) FILTER (WHERE "kind" = 'UNPAID_CANCELLED')::double precision AS "unpaidCancelledCount",
      COALESCE(SUM("amount") FILTER (WHERE "kind" = 'UNPAID_CANCELLED'), 0)::double precision AS "unpaidCancelledAmount",
      COUNT(*) FILTER (WHERE "kind" = 'PAID_CANCELLED')::double precision AS "paidCancelledCount",
      COALESCE(SUM("amount") FILTER (WHERE "kind" = 'PAID_CANCELLED'), 0)::double precision AS "paidCancelledAmount"
    FROM entries GROUP BY "bucket" ORDER BY "bucket"`;
};

const readDailySalesBreakdown = (prisma, period) =>
  prisma.$queryRaw(dailySalesBreakdownQuery(period));

module.exports = {
  salesReportQuery,
  readSalesBuckets,
  readDailySalesBreakdown,
};
