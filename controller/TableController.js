const prisma = require("../lib/prisma");
const tables = require("../lib/table-service");

const sendError = (res, error) => {
  if (error instanceof tables.TableError)
    return res.status(error.status).send({
      error: error.message,
      code: error.code,
    });
  return res.status(500).send({ error: "Unable to process table request" });
};

const handle = (operation) => async (req, res) => {
  try {
    return await operation(req, res);
  } catch (error) {
    return sendError(res, error);
  }
};

module.exports = {
  list: handle(async (_req, res) =>
    res.send({ results: await tables.listTables(prisma) }),
  ),
  create: handle(async (req, res) =>
    res
      .status(201)
      .send({ result: await tables.createTable(prisma, req.body) }),
  ),
  update: handle(async (req, res) =>
    res.send({
      result: await tables.updateTable(prisma, req.params.tableId, req.body),
    }),
  ),
  remove: handle(async (req, res) => {
    await tables.deleteTable(prisma, req.params.tableId);
    return res.send({ message: "success" });
  }),
  openSession: handle(async (req, res) => {
    const result = await tables.openSession(prisma, req.params.tableId);
    res.set("Cache-Control", "no-store");
    return res.status(201).send({ result });
  }),
  rotateToken: handle(async (req, res) => {
    const result = await tables.rotateToken(
      prisma,
      req.params.sessionId,
      req.body?.expectedVersion,
    );
    res.set("Cache-Control", "no-store");
    return res.send({ result });
  }),
  reissueToken: handle(async (req, res) => {
    res.set("Cache-Control", "no-store");
    return res.send({
      result: await tables.reissueToken(prisma, req.params.sessionId),
    });
  }),
  closeSession: handle(async (req, res) =>
    res.send({
      result: await tables.closeSession(
        prisma,
        req.params.sessionId,
        req.body?.expectedVersion,
      ),
    }),
  ),
  getQrMode: handle(async (_req, res) =>
    res.send({ result: { mode: await tables.getQrMode(prisma) } }),
  ),
  setQrMode: handle(async (req, res) =>
    res.send({
      result: { mode: await tables.setQrMode(prisma, req.body?.mode) },
    }),
  ),
};
