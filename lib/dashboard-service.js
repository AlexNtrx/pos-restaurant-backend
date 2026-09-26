const ACTIVE_STATUSES = [
  "SUBMITTED",
  "CONFIRMED",
  "PREPARING",
  "READY",
  "SERVED",
];

// EN: Operational counts come from Orders and sessions; BillSale remains the sole revenue source.
// FI: Operatiiviset määrät tulevat tilauksista ja istunnoista; BillSale on edelleen ainoa myyntitulojen lähde.
const getOperations = async (prisma) => {
  const [counts, openTables, recentOrders] = await Promise.all([
    prisma.order.groupBy({
      by: ["status"],
      where: { status: { in: ACTIVE_STATUSES } },
      _count: { _all: true },
    }),
    prisma.tableSession.count({ where: { status: "OPEN" } }),
    prisma.order.findMany({
      orderBy: [{ submittedAt: "desc" }, { id: "desc" }],
      take: 5,
      select: {
        id: true,
        channel: true,
        status: true,
        tableNo: true,
        total: true,
        submittedAt: true,
      },
    }),
  ]);
  const byStatus = new Map(counts.map((row) => [row.status, row._count._all]));
  const count = (status) => byStatus.get(status) ?? 0;
  return {
    metrics: {
      activeOrders: ACTIVE_STATUSES.reduce(
        (sum, status) => sum + count(status),
        0,
      ),
      kitchenQueue: count("CONFIRMED") + count("PREPARING"),
      readyOrders: count("READY"),
      openTables,
    },
    recentOrders,
  };
};

module.exports = { getOperations };
