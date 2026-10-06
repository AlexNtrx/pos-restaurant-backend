const writes = require("../lib/size-write-service");
const { CatalogWriteError } = require("../lib/catalog-write-error");
const prisma = require("../lib/prisma");

// Coordinates send known error behavior for this module.
const sendKnownError = (res, error) => {
  if (error?.code === "P2002") {
    res
      .status(409)
      .send({ error: "Size name is already in use for this category" });
    return true;
  }
  if (error?.code === "P2034") {
    res.status(409).send({ error: "Size change conflicted; try again" });
    return true;
  }
  return false;
};

module.exports = {
  // Creates  with the current contract.
  create: async (req, res) => {
    try {
      const result = await writes.create({
        body: req.body,
        params: req.params,
        user: req.user,
      });
      return res.status(201).send(result);
    } catch (error) {
      if (error instanceof CatalogWriteError)
        return res.status(error.status).send(error.body);
      if (sendKnownError(res, error)) return;
      return res.status(500).send({ error: "Unable to create food size" });
    }
  },

  // Coordinates list behavior for this module.
  list: async (_req, res) => {
    try {
      const rows = await prisma.foodSize.findMany({
        include: { FoodType: true },
        where: { status: "use" },
        orderBy: { id: "desc" },
      });
      return res.send({ results: rows });
    } catch {
      return res.status(500).send({ error: "Unable to list food sizes" });
    }
  },

  // Removes or clears  using the existing workflow.
  remove: async (req, res) => {
    try {
      const result = await writes.remove({
        body: req.body,
        params: req.params,
        user: req.user,
      });
      return res.send(result);
    } catch (error) {
      if (error instanceof CatalogWriteError)
        return res.status(error.status).send(error.body);
      if (sendKnownError(res, error)) return;
      return res.status(500).send({ error: "Unable to remove food size" });
    }
  },

  // Updates  without changing user-visible behavior.
  update: async (req, res) => {
    try {
      const result = await writes.update({
        body: req.body,
        params: req.params,
        user: req.user,
      });
      return res.send(result);
    } catch (error) {
      if (error instanceof CatalogWriteError)
        return res.status(error.status).send(error.body);
      if (sendKnownError(res, error)) return;
      return res.status(500).send({ error: "Unable to update food size" });
    }
  },
};
