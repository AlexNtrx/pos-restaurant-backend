const { Prisma } = require("@prisma/client");

// EN: Page headers omit item snapshots and refund audit text; only the opened bill loads these potentially long collections.
// FI: Sivun otsikkotiedot eivät sisällä tuoterivejä tai palautusten auditointitekstejä; pitkät kokoelmat ladataan vain avatulle kuitille.
const readBillHistory = (
  prisma,
  { where, page, pageSize, snapshotId, headerSelect },
) =>
  prisma.$transaction(
    async (tx) => {
      const upperId =
        snapshotId ??
        (await tx.billSale.aggregate({ where, _max: { id: true } }))._max.id ??
        0;
      const scope = { ...where, id: { lte: upperId } };
      // EN: Count, money summary and page share one database snapshot; the ID ceiling excludes newly allocated bills while paging.
      // FI: Määrä, rahayhteenveto ja sivu käyttävät samaa tietokantatilannetta; ID-raja sulkee uudet kuitit pois sivuja selattaessa.
      const groups = await tx.billSale.groupBy({
        by: ["status"],
        where: scope,
        _count: { _all: true },
        _sum: { amount: true },
      });
      const completed = await tx.orderRefund.aggregate({
        where: { status: "COMPLETED", BillSale: { ...scope, status: "use" } },
        _sum: { amount: true },
      });
      const summary = {
        activeCount: 0,
        activeAmount: 0,
        cancelledCount: 0,
        cancelledAmount: 0,
      };
      for (const group of groups) {
        const prefix = group.status === "use" ? "active" : "cancelled";
        summary[`${prefix}Count`] = group._count._all;
        summary[`${prefix}Amount`] = group._sum.amount ?? 0;
      }
      summary.activeAmount -= completed._sum.amount ?? 0;
      const results = await tx.billSale.findMany({
        where: scope,
        select: headerSelect,
        orderBy: [{ payDate: "desc" }, { id: "desc" }],
        take: pageSize,
        skip: (page - 1) * pageSize,
      });
      const refunds = await tx.orderRefund.groupBy({
        by: ["billSaleId", "status"],
        where: { billSaleId: { in: results.map((bill) => bill.id) } },
        _count: { _all: true },
        _sum: { amount: true },
        orderBy: { status: "asc" },
      });
      const totalCount = summary.activeCount + summary.cancelledCount;
      return {
        results: results.map((bill) => ({
          ...bill,
          refundSummary: refunds
            .filter((refund) => refund.billSaleId === bill.id)
            .map((refund) => ({
              status: refund.status,
              amount: refund._sum.amount ?? 0,
              count: refund._count._all,
            })),
        })),
        summary,
        pagination: {
          page,
          pageSize,
          totalCount,
          totalPages: Math.ceil(totalCount / pageSize),
          snapshotId: upperId,
        },
      };
    },
    { isolationLevel: Prisma.TransactionIsolationLevel.RepeatableRead },
  );

module.exports = { readBillHistory };
