const ORDER_INCLUDE = {
  Items: {
    orderBy: { id: "asc" },
    include: { Modifiers: { orderBy: { id: "asc" } } },
  },
  StatusHistory: { orderBy: { version: "asc" } },
};
const ORDER_LIST_INCLUDE = { Items: ORDER_INCLUDE.Items };

const staffOrderDto = (order, { history = false } = {}) => ({
  id: order.id,
  channel: order.channel,
  serviceType: order.serviceType,
  status: order.status,
  version: order.version,
  tableNo: order.tableNo,
  tableSessionId: order.tableSessionId,
  total: order.total,
  submittedAt: order.submittedAt,
  confirmedAt: order.confirmedAt,
  rejectedAt: order.rejectedAt,
  preparingAt: order.preparingAt,
  readyAt: order.readyAt,
  servedAt: order.servedAt,
  paidAt: order.paidAt,
  completedAt: order.completedAt,
  cancelledAt: order.cancelledAt,
  updatedAt: order.updatedAt,
  rejectionReason: order.rejectionReason,
  cancellationReason: order.cancellationReason,
  items: order.Items.map((item) => ({
    name: item.foodName,
    quantity: item.quantity,
    note: item.note,
    lineTotal: item.lineTotal,
    modifiers: item.Modifiers.map((modifier) => ({
      type: modifier.type,
      name: modifier.name,
      priceAdjustment: modifier.priceAdjustment,
    })),
  })),
  ...(history
    ? {
        history: order.StatusHistory.map((event) => ({
          fromStatus: event.fromStatus,
          toStatus: event.toStatus,
          version: event.version,
          reason: event.reason,
          actorType: event.actorType,
          at: event.createdAt,
        })),
      }
    : {}),
});

module.exports = { ORDER_INCLUDE, ORDER_LIST_INCLUDE, staffOrderDto };
