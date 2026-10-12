const { Prisma } = require("@prisma/client");
const { RESTAURANT_TIME_ZONE } = require("./restaurant-calendar");

// EN: Prisma stores UTC without a zone; attach UTC before converting for local buckets, independently of the SQL session zone.
// FI: Prisma tallentaa UTC-ajan ilman vyöhykettä; liitä UTC ennen paikallista ryhmittelyä SQL-istunnon vyöhykkeestä riippumatta.
const localTimestamp = (column) =>
  Prisma.sql`(${column} AT TIME ZONE 'UTC' AT TIME ZONE ${RESTAURANT_TIME_ZONE})`;

const salesReportQuery = ({ start, endExclusive, bucket }) => {
  if (bucket !== "day" && bucket !== "month")
    throw new Error("Unsupported sales report bucket");
  // EN: UTC bounds represent Helsinki midnights; compare the stored UTC column directly to preserve range index use.
  // FI: UTC-rajat vastaavat Helsingin keskiöitä; vertaa tallennettua UTC-saraketta suoraan, jotta väli-indeksiä voidaan käyttää.
  const period = Prisma.sql`b."status" = 'use'
    AND b."payDate" >= ${start.toISOString()}::timestamp
    AND b."payDate" < ${endExclusive.toISOString()}::timestamp`;
  // EN: Union signed amounts instead of joining refunds to sale totals: each bill is counted once and only completed refunds restate its original sale period.
  // FI: Yhdistä etumerkilliset summat liittämättä palautuksia myyntisummiin: kukin kuitti lasketaan kerran ja vain vahvistetut palautukset oikaisevat alkuperäistä myyntijaksoa.
  // EN: Sum integer units before converting each final bucket to the existing JSON number type; do not change money units.
  // FI: Laske kokonaislukuyksiköt yhteen ennen lopullisen ryhmäsumman muuntamista nykyiseen JSON-lukutyyppiin; rahayksiköt eivät muutu.
  return Prisma.sql`
    SELECT "bucket", SUM("amount")::text AS "amount"
    FROM (
      SELECT DATE_PART(${bucket}, ${localTimestamp(Prisma.sql`b."payDate"`)})::integer AS "bucket",
        b."amount"::bigint AS "amount"
      FROM "BillSale" b WHERE ${period}
      UNION ALL
      SELECT DATE_PART(${bucket}, ${localTimestamp(Prisma.sql`b."payDate"`)})::integer AS "bucket",
        -r."amount"::bigint AS "amount"
      FROM "OrderRefund" r
      JOIN "BillSale" b ON b."id" = r."billSaleId"
      WHERE ${period} AND r."status" = 'COMPLETED'
    ) entries
    GROUP BY "bucket" ORDER BY "bucket"`;
};

const readSalesBuckets = async (prisma, period) =>
  (await prisma.$queryRaw(salesReportQuery(period))).map((row) => ({
    ...row,
    amount: BigInt(row.amount),
  }));

const dailySalesBreakdownQuery = ({ start, endExclusive }) => {
  const salePeriod = Prisma.sql`b."status" = 'use'
    AND b."payDate" >= ${start.toISOString()}::timestamp
    AND b."payDate" < ${endExclusive.toISOString()}::timestamp`;
  // EN: Aggregate independent bill/refund/Order entries in one snapshot; cancellations never subtract revenue or multiply a shared bill.
  // FI: Laske erilliset lasku-, palautus- ja tilausrivit yhdessä tilannekuvassa; peruutukset eivät vähennä myyntiä tai monista yhteistä laskua.
  // EN: Refund statuses belong to the original Helsinki sale date; operational cancellations belong to their own Helsinki cancellation date.
  // FI: Palautustilat kuuluvat alkuperäiseen Helsingin myyntipäivään; toiminnalliset peruutukset omaan Helsingin peruutuspäiväänsä.
  return Prisma.sql`
    WITH entries AS (
      SELECT DATE_PART('day', ${localTimestamp(Prisma.sql`b."payDate"`)})::integer AS "bucket",
        'GROSS'::text AS "kind", b."amount"::bigint AS "amount"
      FROM "BillSale" b WHERE ${salePeriod}
      UNION ALL
      SELECT DATE_PART('day', ${localTimestamp(Prisma.sql`b."payDate"`)})::integer AS "bucket",
        r."status"::text AS "kind", r."amount"::bigint AS "amount"
      FROM "OrderRefund" r
      JOIN "BillSale" b ON b."id" = r."billSaleId"
      WHERE ${salePeriod}
      UNION ALL
      SELECT DATE_PART('day', ${localTimestamp(Prisma.sql`o."cancelledAt"`)})::integer AS "bucket",
        CASE WHEN o."paidAt" IS NULL THEN 'UNPAID_CANCELLED' ELSE 'PAID_CANCELLED' END AS "kind",
        o."total"::bigint AS "amount"
      FROM "Order" o
      WHERE o."status" = 'CANCELLED'
        AND o."cancelledAt" >= ${start.toISOString()}::timestamp
        AND o."cancelledAt" < ${endExclusive.toISOString()}::timestamp
    )
    SELECT "bucket",
      COALESCE(SUM("amount") FILTER (WHERE "kind" = 'GROSS'), 0)::text AS "grossAmount",
      COALESCE(SUM("amount") FILTER (WHERE "kind" = 'COMPLETED'), 0)::text AS "refundedAmount",
      COALESCE(SUM("amount") FILTER (WHERE "kind" = 'PENDING'), 0)::text AS "pendingRefundAmount",
      COALESCE(SUM("amount") FILTER (WHERE "kind" = 'FAILED'), 0)::text AS "failedRefundAmount",
      COUNT(*) FILTER (WHERE "kind" = 'UNPAID_CANCELLED')::double precision AS "unpaidCancelledCount",
      COALESCE(SUM("amount") FILTER (WHERE "kind" = 'UNPAID_CANCELLED'), 0)::text AS "unpaidCancelledAmount",
      COUNT(*) FILTER (WHERE "kind" = 'PAID_CANCELLED')::double precision AS "paidCancelledCount",
      COALESCE(SUM("amount") FILTER (WHERE "kind" = 'PAID_CANCELLED'), 0)::text AS "paidCancelledAmount"
    FROM entries GROUP BY "bucket" ORDER BY "bucket"`;
};

const readDailySalesBreakdown = async (prisma, period) =>
  (await prisma.$queryRaw(dailySalesBreakdownQuery(period))).map((row) =>
    Object.fromEntries(
      Object.entries(row).map(([field, value]) => [
        field,
        field.endsWith("Amount") ? BigInt(value) : value,
      ]),
    ),
  );

module.exports = {
  salesReportQuery,
  readSalesBuckets,
  readDailySalesBreakdown,
};
