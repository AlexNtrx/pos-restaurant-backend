const prisma = require("../lib/prisma");
const { CatalogWriteError } = require("../lib/catalog-write-error");
const {
  readTaxPublicationReadiness,
} = require("../lib/tax-publication-readiness-service");
module.exports = {
  read: async (req, res) => {
    res.set("Cache-Control", "private, no-store");
    try {
      return res.send(
        await readTaxPublicationReadiness(prisma, req.user.id, req.query),
      );
    } catch (error) {
      return error instanceof CatalogWriteError
        ? res.status(error.status).send(error.body)
        : res
            .status(500)
            .send({ error: "Unable to read publication readiness" });
    }
  },
};
