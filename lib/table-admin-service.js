const { Prisma } = require("@prisma/client");
const {
  TableError,
  positiveId,
  withConflict,
  TERMINAL_ORDER_STATUSES,
} = require("./table-service-shared");

const tableNumber = (value) => {
  if (!Number.isSafeInteger(value) || value <= 0 || value > 10000)
    throw new TableError(
      400,
      "INVALID_TABLE_NUMBER",
      "Table number must be an integer from 1 to 10000",
    );
  return value;
};

const tableName = (value) => {
  if (value == null || value === "") return null;
  if (typeof value !== "string" || value.trim().length > 80)
    throw new TableError(400, "INVALID_TABLE_NAME", "Table name is invalid");
  return value.trim() || null;
};

// EN: Table lists contain no QR material; only authenticated staff may request an issued QR again.
// FI: Pöytälistat eivät sisällä QR-tietoja; vain tunnistautunut henkilökunta voi pyytää myönnetyn QR:n uudelleen.
const listTables = async (prisma) => {
  const tables = await prisma.restaurantTable.findMany({
    where: { status: "use" },
    orderBy: { tableNo: "asc" },
    select: {
      id: true,
      tableNo: true,
      name: true,
      Sessions: {
        where: { status: "OPEN" },
        select: {
          id: true,
          openedAt: true,
          qrTokenExpiresAt: true,
          tokenVersion: true,
        },
      },
    },
  });
  return tables.map(({ Sessions, ...table }) => ({
    ...table,
    openSession: Sessions[0] ?? null,
  }));
};

const createTable = (prisma, body) => {
  const data = {
    tableNo: tableNumber(body?.tableNo),
    name: tableName(body?.name),
  };
  return withConflict(() =>
    prisma.restaurantTable.create({
      data,
      select: { id: true, tableNo: true, name: true },
    }),
  );
};

const updateTable = (prisma, rawId, body) => {
  const id = positiveId(rawId);
  if (
    !body ||
    typeof body !== "object" ||
    (!Object.hasOwn(body, "tableNo") && !Object.hasOwn(body, "name"))
  )
    throw new TableError(400, "INVALID_INPUT", "No table changes supplied");
  const data = {
    ...(Object.hasOwn(body, "tableNo")
      ? { tableNo: tableNumber(body.tableNo) }
      : {}),
    ...(Object.hasOwn(body, "name") ? { name: tableName(body.name) } : {}),
  };
  return withConflict(() =>
    prisma.$transaction(
      async (tx) => {
        const table = await tx.restaurantTable.findUnique({ where: { id } });
        if (!table || table.status !== "use")
          throw new TableError(404, "TABLE_NOT_FOUND", "Table not found");
        if (
          data.tableNo != null &&
          data.tableNo !== table.tableNo &&
          (await tx.tableSession.count({
            where: { restaurantTableId: id, status: "OPEN" },
          }))
        )
          throw new TableError(
            409,
            "TABLE_OPEN",
            "Close the table session before renumbering",
          );
        return tx.restaurantTable.update({
          where: { id },
          data,
          select: { id: true, tableNo: true, name: true },
        });
      },
      { isolationLevel: Prisma.TransactionIsolationLevel.Serializable },
    ),
  );
};

// EN: Soft deletion preserves historical table references and refuses an active session or unsettled order.
// FI: Pehmeä poisto säilyttää historialliset pöytäviittaukset ja estää poiston aktiivisen istunnon tai maksamattoman tilauksen aikana.
const deleteTable = (prisma, rawId) => {
  const id = positiveId(rawId);
  return withConflict(() =>
    prisma.$transaction(
      async (tx) => {
        const table = await tx.restaurantTable.findUnique({ where: { id } });
        if (!table || table.status !== "use")
          throw new TableError(404, "TABLE_NOT_FOUND", "Table not found");
        const [openSessions, pendingOrders] = await Promise.all([
          tx.tableSession.count({
            where: { restaurantTableId: id, status: "OPEN" },
          }),
          tx.order.count({
            where: {
              tableNo: table.tableNo,
              status: { notIn: TERMINAL_ORDER_STATUSES },
            },
          }),
        ]);
        if (openSessions || pendingOrders)
          throw new TableError(
            409,
            "TABLE_IN_USE",
            "Close the session and settle or cancel orders first",
          );
        await tx.restaurantTable.update({
          where: { id },
          data: { status: "delete" },
        });
      },
      { isolationLevel: Prisma.TransactionIsolationLevel.Serializable },
    ),
  );
};
module.exports = { listTables, createTable, updateTable, deleteTable };
