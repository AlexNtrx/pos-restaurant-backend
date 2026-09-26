const prisma = require("../lib/prisma");
const { OrderDomainError } = require("../lib/order-domain");
const qr = require("../lib/qr-public-service");

const handle = (operation) => async (req, res) => {
  res.set("Cache-Control", "no-store");
  res.set("Referrer-Policy", "no-referrer");
  try {
    return await operation(req, res);
  } catch (error) {
    if (error instanceof OrderDomainError)
      return res
        .status(error.status)
        .send({ error: error.message, code: error.code });
    console.error(error);
    return res.status(500).send({ error: "Unable to process QR request" });
  }
};

module.exports = {
  context: handle(async (req, res) =>
    res.send({ result: await qr.publicContext(prisma, req.params.token) }),
  ),
  menu: handle(async (req, res) =>
    res.send({ result: await qr.publicMenu(prisma, req.params.token) }),
  ),
  submit: handle(async (req, res) =>
    res.status(201).send({
      result: await qr.publicSubmit(prisma, req.params.token, req.body),
    }),
  ),
  order: handle(async (req, res) =>
    res.send({
      result: await qr.publicOrder(
        prisma,
        req.params.token,
        req.params.orderId,
      ),
    }),
  ),
};
