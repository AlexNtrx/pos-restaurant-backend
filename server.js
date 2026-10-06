require("dotenv").config({ quiet: true });
const {
  getCorsOrigins,
  getPort,
  validateRuntimeEnvironment,
} = require("./lib/environment");
if (require.main === module || process.env.NODE_ENV === "production") {
  validateRuntimeEnvironment();
}
const prisma = require("./lib/prisma");
const bodyParser = require("body-parser");
const express = require("express");
const app = express();
const cors = require("cors");

app.use(bodyParser.json());
app.use((error, req, res, next) => {
  if (error?.type === "entity.parse.failed") {
    return res.status(400).send({ error: "Invalid JSON" });
  }

  return next(error);
});
app.use(bodyParser.urlencoded({ extended: true }));
const corsOrigins = getCorsOrigins();
app.use(
  cors({
    exposedHeaders: ["ETag"],
    origin: corsOrigins.length
      ? corsOrigins
      : process.env.NODE_ENV !== "production",
  }),
);

// EN: Readiness checks database connectivity without disclosing connection details.
// FI: Valmiustarkistus testaa tietokantayhteyden paljastamatta yhteyden tietoja.
app.get("/health", async (req, res) => {
  try {
    await prisma.$queryRaw`SELECT 1`;
    res.status(200).send({ status: "ok" });
  } catch {
    res.status(503).send({ status: "unavailable" });
  }
});
app.use("/uploads", (req, res, next) => {
  if (/^\/bill-.*\.pdf$/i.test(req.path)) {
    return res.status(404).send({ error: "Not found" });
  }
  return next();
});
app.get(
  "/uploads/variants/:variant/:filename",
  require("./controller/ImageController").variant,
);
app.use("/uploads", express.static("uploads"));

// EN: Catalog bodies are explicitly revalidated after authorization; shared browser/proxy caches must not reuse staff responses.
// FI: Luettelosisältö tarkistetaan aina valtuutuksen jälkeen; selaimen ja välityspalvelimen yhteiset välimuistit eivät saa käyttää henkilökunnan vastauksia uudelleen.
app.use(
  [
    "/api/food/list",
    "/api/food/filter",
    "/api/foodType/list",
    "/api/foodSize/list",
    "/api/taste/list",
  ],
  (_req, res, next) => {
    res.set("Cache-Control", "no-store");
    next();
  },
);

require("./routes/tables")(app);

require("./routes/qr-public")(app);

require("./routes/service-calls")(app);

require("./routes/staff-orders")(app);

require("./routes/reports")(app);

require("./routes/bills")(app);

require("./routes/organization")(app);

require("./routes/counter")(app);

require("./routes/legacy-cart")(app);

require("./routes/catalog")(app);

require("./routes/users")(app);

// EN: Connect before accepting traffic, then drain HTTP requests before releasing the shared pool.
// FI: Yhdistä ennen liikenteen vastaanottamista ja päätä HTTP-pyynnöt ennen yhteisen poolin sulkemista.
const startServer = async (port = getPort()) => {
  await prisma.$connect();
  const server = app.listen(port, "0.0.0.0");
  await new Promise((resolve, reject) => {
    server.once("listening", resolve);
    server.once("error", reject);
  });
  console.log(`API Server running on port ${port}`);
  return server;
};

const shutdownServer = (server) => {
  let closing = false;
  const shutdown = () => {
    if (closing) return;
    closing = true;
    const deadline = setTimeout(() => process.exit(1), 25_000);
    deadline.unref();
    server.close(async () => {
      try {
        await prisma.$disconnect();
        clearTimeout(deadline);
      } catch {
        process.exitCode = 1;
      }
    });
  };
  process.once("SIGTERM", shutdown);
  process.once("SIGINT", shutdown);
};

module.exports = { app, server: null, startServer };
if (require.main === module) {
  startServer()
    .then((server) => {
      module.exports.server = server;
      shutdownServer(server);
    })
    .catch(async () => {
      console.error(
        "API startup failed: check database connectivity and PORT configuration.",
      );
      await prisma.$disconnect();
      process.exitCode = 1;
    });
}
