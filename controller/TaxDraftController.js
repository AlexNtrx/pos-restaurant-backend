const prisma = require("../lib/prisma");
const { CatalogWriteError } = require("../lib/catalog-write-error");
const { readTaxDraft, saveTaxDraft } = require("../lib/tax-draft-service");
const sendError = (res, error) =>
  error instanceof CatalogWriteError
    ? res.status(error.status).send(error.body)
    : res.status(500).send({ error: "Unable to process tax draft" });
module.exports = {
  read: async (req, res) => {
    res.set("Cache-Control", "private, no-store");
    try {
      return res.send(await readTaxDraft(prisma, req.user.id));
    } catch (error) {
      return sendError(res, error);
    }
  },
  save: async (req, res) => {
    res.set("Cache-Control", "private, no-store");
    try {
      return res.send(await saveTaxDraft(prisma, req.user.id, req.body));
    } catch (error) {
      return sendError(res, error);
    }
  },
};
