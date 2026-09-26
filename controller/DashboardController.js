const prisma = require("../lib/prisma");
const { getOperations } = require("../lib/dashboard-service");

module.exports = {
  operations: async (_req, res) => {
    res.set("Cache-Control", "no-store");
    try {
      return res.send(await getOperations(prisma));
    } catch (error) {
      console.error(error);
      return res.status(500).send({ error: "Unable to load operations" });
    }
  },
};
