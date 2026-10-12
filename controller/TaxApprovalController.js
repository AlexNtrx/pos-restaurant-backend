const prisma = require("../lib/prisma");
const { CatalogWriteError } = require("../lib/catalog-write-error");
const {
  listTaxApprovals,
  createTaxApproval,
} = require("../lib/tax-approval-service");
const failure = (res, error) =>
  error instanceof CatalogWriteError
    ? res.status(error.status).send(error.body)
    : res.status(500).send({ error: "Unable to process tax review approvals" });
module.exports = {
  list: async (req, res) => {
    try {
      return res.send(await listTaxApprovals(prisma, req.user.id, req.query));
    } catch (error) {
      return failure(res, error);
    }
  },
  create: async (req, res) => {
    try {
      const result = await createTaxApproval(prisma, req.user.id, req.body);
      return res.status(result.created ? 201 : 200).send(result);
    } catch (error) {
      return failure(res, error);
    }
  },
};
