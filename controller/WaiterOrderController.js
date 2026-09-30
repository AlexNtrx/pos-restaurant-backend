const prisma = require("../lib/prisma");
const { OrderDomainError } = require("../lib/order-domain");
const service = require("../lib/waiter-order-service");

const handle = (operation) => async (req, res) => {
  res.set("Cache-Control", "no-store");
  try {
    return await operation(req, res);
  } catch (error) {
    if (error instanceof OrderDomainError)
      return res
        .status(error.status)
        .send({ error: error.message, code: error.code });
    console.error(error);
    return res.status(500).send({ error: "Unable to process waiter order" });
  }
};

module.exports = {
  menu: handle(async (_req, res) =>
    res.send({ result: await service.waiterMenu(prisma) }),
  ),
  submit: handle(async (req, res) =>
    res.status(201).send({
      result: await service.submitWaiterOrder(prisma, {
        actor: { type: "STAFF", userId: req.user.id, level: req.user.level },
        body: req.body,
      }),
    }),
  ),
};
