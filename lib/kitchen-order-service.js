const { OrderDomainError, assertPositiveInteger } = require("./order-domain");
const { transitionOrder } = require("./order-service");
const { staffOrderDto } = require("./staff-order-service");

const KITCHEN_TARGETS = new Set(["PREPARING", "READY"]);

const changeKitchenStatus = async (prisma, { actor, orderId, body }) => {
  if (!body || typeof body !== "object" || Array.isArray(body))
    throw new OrderDomainError(400, "INVALID_INPUT", "Invalid kitchen action");
  const { expectedVersion, nextStatus, ...extra } = body;
  // EN: Kitchen exposes only start/ready; the shared state engine enforces the exact source state and version.
  // FI: Keittiö tarjoaa vain aloitus- ja valmis-toiminnot; yhteinen tilakone tarkistaa lähtötilan ja version.
  if (Object.keys(extra).length || !KITCHEN_TARGETS.has(nextStatus))
    throw new OrderDomainError(400, "INVALID_INPUT", "Invalid kitchen action");
  const order = await transitionOrder(prisma, {
    actor,
    orderId: assertPositiveInteger(Number(orderId), "orderId"),
    expectedVersion,
    nextStatus,
  });
  return staffOrderDto(order, { history: true });
};

module.exports = { changeKitchenStatus };
