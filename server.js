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
const fileUpload = require("express-fileupload");

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
app.use(fileUpload());
app.use("/uploads", (req, res, next) => {
  if (/^\/bill-.*\.pdf$/i.test(req.path)) {
    return res.status(404).send({ error: "Not found" });
  }
  return next();
});
app.use("/uploads", express.static("uploads"));

const UserController = require("./controller/UserController");
const foodTypeController = require("./controller/FoodTypeController");
const foodSizeController = require("./controller/FoodSizeController");
const TasteController = require("./controller/TasteController");
const FoodController = require("./controller/FoodController");
const SaleTempController = require("./controller/SaleTempController");
const CounterOrderController = require("./controller/CounterOrderController");
const TableController = require("./controller/TableController");
const QrPublicController = require("./controller/QrPublicController");
const StaffOrderController = require("./controller/StaffOrderController");
const ServiceCallController = require("./controller/ServiceCallController");
const KitchenOrderController = require("./controller/KitchenOrderController");
const WaiterOrderController = require("./controller/WaiterOrderController");
const TablePaymentController = require("./controller/TablePaymentController");
const OrganizationController = require("./controller/OrganizationController");
const BillSaleController = require("./controller/BillSaleController");
const ReportController = require("./controller/ReportController");
const DashboardController = require("./controller/DashboardController");
const {
  isAdmin,
  isAuthen,
  isStaff,
  isServiceStaff,
  isOrderReader,
  isKitchenStaff,
} = require("./middleware/auth");

// EN: QR-01 raw access tokens are issued only to authenticated staff, never on a public route.
// FI: QR-01:n alkuperäiset tunnisteet annetaan vain tunnistautuneelle henkilökunnalle, ei julkisella reitillä.
app.get("/api/tables", isAuthen, isServiceStaff, TableController.list);
app.post("/api/tables", isAuthen, isAdmin, TableController.create);
app.put("/api/tables/:tableId", isAuthen, isAdmin, TableController.update);
app.delete("/api/tables/:tableId", isAuthen, isAdmin, TableController.remove);
app.post(
  "/api/tables/:tableId/sessions",
  isAuthen,
  isServiceStaff,
  TableController.openSession,
);
app.post(
  "/api/table-sessions/:sessionId/rotate-token",
  isAuthen,
  isStaff,
  TableController.rotateToken,
);
app.post(
  "/api/table-sessions/:sessionId/close",
  isAuthen,
  isStaff,
  TableController.closeSession,
);
app.post(
  "/api/table-sessions/:sessionId/settle",
  isAuthen,
  isStaff,
  TablePaymentController.settle,
);
app.get("/api/qr-mode", isAuthen, isStaff, TableController.getQrMode);
app.get(
  "/api/table-sessions/:sessionId/qr",
  isAuthen,
  isStaff,
  TableController.reissueToken,
);
app.put("/api/qr-mode", isAuthen, isAdmin, TableController.setQrMode);

// EN: Public QR requests use the table token only; no staff bearer token grants customer access.
// FI: Julkiset QR-pyynnöt käyttävät vain pöytätunnistetta; henkilökunnan bearer-tunniste ei anna asiakaspääsyä.
app.get("/api/qr/:token/context", QrPublicController.context);
app.get("/api/qr/:token/menu", QrPublicController.menu);
app.post("/api/qr/:token/orders", QrPublicController.submit);
app.get("/api/qr/:token/orders/:orderId", QrPublicController.order);
app.get("/api/qr/:token/service-call", ServiceCallController.current);
app.post("/api/qr/:token/service-call", ServiceCallController.create);

app.get(
  "/api/service-calls",
  isAuthen,
  isServiceStaff,
  ServiceCallController.list,
);
app.patch(
  "/api/service-calls/:callId/status",
  isAuthen,
  isServiceStaff,
  ServiceCallController.changeStatus,
);

app.get(
  "/api/waiter/menu",
  isAuthen,
  isServiceStaff,
  WaiterOrderController.menu,
);
app.post(
  "/api/waiter/orders",
  isAuthen,
  isServiceStaff,
  WaiterOrderController.submit,
);
app.get("/api/orders", isAuthen, isOrderReader, StaffOrderController.list);
app.get(
  "/api/orders/:orderId/refund",
  isAuthen,
  isAdmin,
  StaffOrderController.getRefund,
);
app.post(
  "/api/orders/:orderId/refund",
  isAuthen,
  isAdmin,
  StaffOrderController.reserveRefund,
);
app.post(
  "/api/orders/:orderId/refund/complete",
  isAuthen,
  isAdmin,
  StaffOrderController.completeRefund,
);
app.post(
  "/api/orders/:orderId/refund/fail",
  isAuthen,
  isAdmin,
  StaffOrderController.failRefund,
);
app.get(
  "/api/orders/:orderId",
  isAuthen,
  isOrderReader,
  StaffOrderController.detail,
);
app.patch(
  "/api/orders/:orderId/status",
  isAuthen,
  isServiceStaff,
  StaffOrderController.changeStatus,
);
app.patch(
  "/api/orders/:orderId/serve",
  isAuthen,
  isServiceStaff,
  StaffOrderController.serve,
);
app.patch(
  "/api/kitchen/orders/:orderId/status",
  isAuthen,
  isKitchenStaff,
  KitchenOrderController.changeStatus,
);

//report
app.get(
  "/api/dashboard/operations",
  isAuthen,
  isAdmin,
  DashboardController.operations,
);
app.post(
  "/api/report/sumMonthly",
  isAuthen,
  isAdmin,
  ReportController.sumMonthly,
);
app.post(
  "/api/report/dailySales",
  isAuthen,
  isAdmin,
  ReportController.sumPerDayInYearAndMonth,
);

//billSale
app.post("/api/billSale/list", isAuthen, isAdmin, BillSaleController.list);
app.delete(
  "/api/billSale/remove/:id",
  isAuthen,
  isAdmin,
  BillSaleController.remove,
);

//organization
app.post(
  "/api/organization/upload",
  isAuthen,
  isAdmin,
  OrganizationController.upload,
);
app.post(
  "/api/organization/create",
  isAuthen,
  isAdmin,
  OrganizationController.create,
);
app.get(
  "/api/organization/info",
  isAuthen,
  isAdmin,
  OrganizationController.info,
);

//saleTemp
app.post(
  "/api/counterOrder/quote",
  isAuthen,
  isStaff,
  CounterOrderController.quote,
);
app.get(
  "/api/counterOrder/options/:foodId",
  isAuthen,
  isStaff,
  CounterOrderController.options,
);
app.post(
  "/api/counterOrder/submit",
  isAuthen,
  isStaff,
  CounterOrderController.submit,
);
app.post(
  "/api/counterOrder/checkout",
  isAuthen,
  isStaff,
  CounterOrderController.checkout,
);
app.post(
  "/api/counterOrder/prebill",
  isAuthen,
  isStaff,
  CounterOrderController.prebill,
);
app.get(
  "/api/counterOrder/sent",
  isAuthen,
  isStaff,
  CounterOrderController.listSent,
);
app.get(
  "/api/counterOrder/:id",
  isAuthen,
  isStaff,
  CounterOrderController.sentDetail,
);
app.patch(
  "/api/counterOrder/:id/cancel",
  isAuthen,
  isStaff,
  CounterOrderController.cancelSent,
);
app.post(
  "/api/counterOrder/:id/prebill",
  isAuthen,
  isStaff,
  CounterOrderController.sentPrebill,
);
app.post(
  "/api/counterOrder/:id/settle",
  isAuthen,
  isStaff,
  CounterOrderController.settle,
);

app.post(
  "/api/saleTemp/printBillAfterPay",
  isAuthen,
  isStaff,
  SaleTempController.printBillAfterPay,
);
app.post(
  "/api/saleTemp/endSale",
  isAuthen,
  isStaff,
  SaleTempController.endSale,
);
app.post(
  "/api/saleTemp/submitToKitchen",
  isAuthen,
  isStaff,
  SaleTempController.submitToKitchen,
);
app.get(
  "/api/saleTemp/pendingCounterOrders",
  isAuthen,
  isStaff,
  SaleTempController.pendingCounterOrders,
);
app.post(
  "/api/saleTemp/printBillBeforePay",
  isAuthen,
  isStaff,
  SaleTempController.printBillBeforePay,
);
app.delete(
  "/api/saleTemp/removeSaleTempDetailModal",
  isAuthen,
  isStaff,
  SaleTempController.removeSaleTempDetailModal,
);
app.post(
  "/api/saleTemp/createSaleTempDetail",
  isAuthen,
  isStaff,
  SaleTempController.createSaleTempDetail,
);
app.put(
  "/api/saleTemp/selectSize",
  isAuthen,
  isStaff,
  SaleTempController.selectSize,
);
app.put(
  "/api/saleTemp/unSelectTaste",
  isAuthen,
  isStaff,
  SaleTempController.unSelectTaste,
);
app.put(
  "/api/saleTemp/selectTaste",
  isAuthen,
  isStaff,
  SaleTempController.selectTaste,
);
app.get("/api/saleTemp/info/:id", isAuthen, isStaff, SaleTempController.info);
app.post(
  "/api/saleTemp/generateSaleTempDetail",
  isAuthen,
  isStaff,
  SaleTempController.generateSaleTempDetail,
);
app.put(
  "/api/saleTemp/updateQty",
  isAuthen,
  isStaff,
  SaleTempController.updateQty,
);
app.delete(
  "/api/saleTemp/removeAll",
  isAuthen,
  isStaff,
  SaleTempController.removeAll,
);
app.delete(
  "/api/saleTemp/remove/:id",
  isAuthen,
  isStaff,
  SaleTempController.remove,
);
app.get("/api/saleTemp/list/", isAuthen, isStaff, SaleTempController.list);
app.post("/api/saleTemp/create", isAuthen, isStaff, SaleTempController.create);

//food
app.post("/api/food/paginate", isAuthen, isAdmin, FoodController.paginate);
app.get("/api/food/filter/:foodType", isAuthen, isStaff, FoodController.filter);
app.post("/api/food/upload", isAuthen, isAdmin, FoodController.upload);
app.post("/api/food/create", isAuthen, isAdmin, FoodController.create);
app.get("/api/food/list", isAuthen, isAdmin, FoodController.list);
app.delete("/api/food/remove/:id", isAuthen, isAdmin, FoodController.remove);
app.put("/api/food/update", isAuthen, isAdmin, FoodController.update);
//foodtaste
app.post("/api/taste/create", isAuthen, isAdmin, TasteController.create);
app.get("/api/taste/list", isAuthen, isAdmin, TasteController.list);
app.delete("/api/taste/remove/:id", isAuthen, isAdmin, TasteController.remove);
app.put("/api/taste/update", isAuthen, isAdmin, TasteController.update);
//foodsize
app.post("/api/foodSize/create", isAuthen, isAdmin, foodSizeController.create);
app.get("/api/foodSize/list", isAuthen, isAdmin, foodSizeController.list);
app.delete(
  "/api/foodSize/remove/:id",
  isAuthen,
  isAdmin,
  foodSizeController.remove,
);
app.put("/api/foodSize/update", isAuthen, isAdmin, foodSizeController.update);
//foodtype

app.post("/api/foodtype/create", isAuthen, isAdmin, foodTypeController.create);
app.get("/api/foodType/list", isAuthen, isAdmin, foodTypeController.list);
app.put("/api/foodtype/update", isAuthen, isAdmin, foodTypeController.update);

//remove
app.delete(
  "/api/foodtype/remove/:id",
  isAuthen,
  isAdmin,
  foodTypeController.remove,
);

//signIn
app.get("/api/user/getLevelByToken", isAuthen, UserController.getLevelByToken);
app.get("/api/user/list", isAuthen, isAdmin, UserController.list);
app.put("/api/user/update", isAuthen, isAdmin, UserController.update);
app.delete("/api/user/remove/:id", isAuthen, isAdmin, UserController.remove);
app.post("/api/user/create", isAuthen, isAdmin, UserController.create);
app.post("/api/user/signIn", UserController.signIn);

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
