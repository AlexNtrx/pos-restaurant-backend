const prisma = require("../lib/prisma");
const { OrderDomainError } = require("../lib/order-domain");
const { changeKitchenStatus } = require("../lib/kitchen-order-service");

const changeStatus = async (req, res) => {
  res.set("Cache-Control", "no-store");
  try {
    const result = await changeKitchenStatus(prisma, {
      actor: {
        type: "STAFF",
        userId: req.user.id,
        level: req.user.level,
      },
      orderId: req.params.orderId,
      body: req.body,
    });
    return res.send({ result });
  } catch (error) {
    if (error instanceof OrderDomainError)
      return res
        .status(error.status)
        .send({ error: error.message, code: error.code });
    console.error(error);
    return res.status(500).send({ error: "Unable to process kitchen Order" });
  }
};

module.exports = { changeStatus };
