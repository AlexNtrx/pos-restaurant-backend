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

module.exports = { salesReportQuery, readSalesBuckets };
