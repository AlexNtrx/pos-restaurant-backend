const prisma = require("../lib/prisma");
const { OrderDomainError } = require("../lib/order-domain");
const orders = require("../lib/staff-order-service");

const actorFor = (req) => ({
  type: "STAFF",
  userId: req.user.id,
  level: req.user.level,
});

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
    return res.status(500).send({ error: "Unable to process staff Order" });
  }
};

module.exports = {
  list: handle(async (req, res) =>
    res.send(
      await orders.listStaffOrders(prisma, {
        actor: actorFor(req),
        filters: req.query,
      }),
    ),
  ),
  detail: handle(async (req, res) =>
    res.send({
      result: await orders.getStaffOrder(prisma, {
        actor: actorFor(req),
        orderId: req.params.orderId,
      }),
    }),
  ),
  changeStatus: handle(async (req, res) =>
    res.send({
      result: await orders.changeIncomingStatus(prisma, {
        actor: actorFor(req),
        orderId: req.params.orderId,
        body: req.body,
      }),
    }),
  ),
  serve: handle(async (req, res) =>
    res.send({
      result: await orders.serveStaffOrder(prisma, {
        actor: actorFor(req),
        orderId: req.params.orderId,
        body: req.body,
      }),
    }),
  ),
};
