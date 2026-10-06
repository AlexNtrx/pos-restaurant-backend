const writes = require("../lib/taste-write-service");
const { CatalogWriteError } = require("../lib/catalog-write-error");
const prisma = require("../lib/prisma");

// Coordinates send known error behavior for this module.
const sendKnownError = (res, error) => {
  if (error?.code === "P2002") {
    res
      .status(409)
      .send({ error: "Taste name is already in use for this category" });
    return true;
  }
  if (error?.code === "P2034") {
    res.status(409).send({ error: "Taste change conflicted; try again" });
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
      return res.status(500).send({ error: "Unable to create taste" });
    }
  },

  // Coordinates list behavior for this module.
  list: async (_req, res) => {
    try {
      return res.send({
        results: await prisma.taste.findMany({
          include: { FoodType: true },
          where: { status: "use" },
          orderBy: { id: "desc" },
        }),
      });
    } catch {
      return res.status(500).send({ error: "Unable to list tastes" });
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
      return res.status(500).send({ error: "Unable to remove taste" });
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
      return res.status(500).send({ error: "Unable to update taste" });
    }
  },
};
