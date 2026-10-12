const prisma = require("../lib/prisma");
const { CatalogWriteError } = require("../lib/catalog-write-error");
const { readTaxControl } = require("../lib/tax-control-service");
module.exports = {
  read: async (req, res) => {
    try {
      return res.send(await readTaxControl(prisma, req.user.id, req.query));
    } catch (error) {
      return error instanceof CatalogWriteError
        ? res.status(error.status).send(error.body)
        : res.status(500).send({ error: "Unable to read tax control" });
    }
  },
};
