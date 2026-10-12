const { sendMoney } = require("../lib/money-dto");
const prisma = require("../lib/prisma");
const { getOperations } = require("../lib/dashboard-service");

module.exports = {
  operations: async (_req, res) => {
    res.set("Cache-Control", "no-store");
    try {
      return sendMoney(res, await getOperations(prisma));
    } catch (error) {
      console.error(error);
      return res.status(500).send({ error: "Unable to load operations" });
    }
  },
};
