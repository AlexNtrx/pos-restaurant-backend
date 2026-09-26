const prisma = require("../lib/prisma");
const { OrderDomainError } = require("../lib/order-domain");
const { payTableSession } = require("../lib/table-payment-service");

const settle = async (req, res) => {
  res.set("Cache-Control", "no-store");
  try {
    const bill = await payTableSession(prisma, {
      actor: {
        type: "STAFF",
        userId: req.user.id,
        level: req.user.level,
      },
      sessionId: req.params.sessionId,
      body: req.body,
    });
    return res.send({
      message: "success",
      billId: bill.id,
      amount: bill.amount,
      inputMoney: bill.inputMoney,
      returnMoney: bill.returnMoney,
    });
  } catch (error) {
    if (error instanceof OrderDomainError)
      return res
        .status(error.status)
        .send({ error: error.message, code: error.code });
    console.error(error);
    return res.status(500).send({ error: "Unable to settle table session" });
  }
};

module.exports = { settle };
