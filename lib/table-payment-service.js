const { OrderDomainError } = require("./order-domain");
const { settleTableSession } = require("./order-service");

const payTableSession = (prisma, { actor, sessionId, body }) => {
  if (!body || typeof body !== "object" || Array.isArray(body))
    throw new OrderDomainError(400, "INVALID_INPUT", "Invalid payment body");
  const { orders, idempotencyKey, payType, inputMoney, ...extra } = body;
  if (Object.keys(extra).length)
    throw new OrderDomainError(400, "INVALID_INPUT", "Invalid payment body");
  // EN: Client IDs and versions are assertions, not financial authority; settlement reloads every session order and total.
  // FI: Asiakkaan tunnisteet ja versiot ovat tarkistuksia eivätkä maksun auktoriteetti; maksu lataa kaikki istunnon tilaukset ja summan uudelleen.
  return settleTableSession(prisma, {
    actor,
    sessionId,
    orders,
    idempotencyKey,
    payType,
    inputMoney,
  });
};

module.exports = { payTableSession };
