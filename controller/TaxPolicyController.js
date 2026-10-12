const prisma = require("../lib/prisma");
const { CatalogWriteError } = require("../lib/catalog-write-error");
const {
  readTaxPolicyReview,
  listTaxPolicyRevisions,
  createTaxPolicyRevision,
} = require("../lib/tax-policy-service");
const handle = (operation) => async (req, res) => {
  res.set("Cache-Control", "private, no-store");
  try {
    return await operation(req, res);
  } catch (error) {
    return error instanceof CatalogWriteError
      ? res.status(error.status).send(error.body)
      : res.status(500).send({ error: "Unable to process tax policy review" });
  }
};
module.exports = {
  review: handle(async (req, res) =>
    res.send(await readTaxPolicyReview(prisma, req.user.id)),
  ),
  list: handle(async (req, res) =>
    res.send(await listTaxPolicyRevisions(prisma, req.user.id, req.query)),
  ),
  create: handle(async (req, res) => {
    const result = await createTaxPolicyRevision(prisma, req.user.id, req.body);
    return res.status(result.created ? 201 : 200).send(result);
  }),
};
