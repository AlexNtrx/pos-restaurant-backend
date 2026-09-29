const prisma = require("../lib/prisma");
const { OrderDomainError } = require("../lib/order-domain");
const calls = require("../lib/service-call-service");

const handle =
  (operation, isPublic = false) =>
  async (req, res) => {
    res.set("Cache-Control", "no-store");
    if (isPublic) res.set("Referrer-Policy", "no-referrer");
    try {
      return await operation(req, res);
    } catch (error) {
      if (error instanceof OrderDomainError)
        return res
          .status(error.status)
          .send({ error: error.message, code: error.code });
      console.error(error);
      return res.status(500).send({ error: "Unable to process service call" });
    }
  };

module.exports = {
  current: handle(
    async (req, res) =>
      res.send({
        result: await calls.getCurrentCall(prisma, req.params.token),
      }),
    true,
  ),
  create: handle(
    async (req, res) =>
      res.send({
        result: await calls.createCall(prisma, req.params.token, req.body),
      }),
    true,
  ),
  list: handle(async (req, res) =>
    res.send(await calls.listActiveCalls(prisma)),
  ),
  changeStatus: handle(async (req, res) =>
    res.send({
      result: await calls.changeCallStatus(
        prisma,
        req.params.callId,
        req.body,
        req.user.id,
      ),
    }),
  ),
};
