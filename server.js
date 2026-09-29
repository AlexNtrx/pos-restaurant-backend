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
app.use(cors());
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
const TablePaymentController = require("./controller/TablePaymentController");
const OrganizationController = require("./controller/OrganizationController");
const BillSaleController = require("./controller/BillSaleController");
const ReportController = require("./controller/ReportController");
const DashboardController = require("./controller/DashboardController");
const { isAdmin, isAuthen, isStaff } = require("./middleware/auth");

const dotenv = require("dotenv");
dotenv.config();

// EN: QR-01 raw access tokens are issued only to authenticated staff, never on a public route.
// FI: QR-01:n alkuperäiset tunnisteet annetaan vain tunnistautuneelle henkilökunnalle, ei julkisella reitillä.
app.get("/api/tables", isAuthen, isStaff, TableController.list);
app.post("/api/tables", isAuthen, isAdmin, TableController.create);
app.put("/api/tables/:tableId", isAuthen, isAdmin, TableController.update);
app.delete("/api/tables/:tableId", isAuthen, isAdmin, TableController.remove);
app.post(
  "/api/tables/:tableId/sessions",
  isAuthen,
  isStaff,
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

app.get("/api/service-calls", isAuthen, isStaff, ServiceCallController.list);
app.patch(
  "/api/service-calls/:callId/status",
  isAuthen,
  isStaff,
  ServiceCallController.changeStatus,
);

app.get("/api/orders", isAuthen, isStaff, StaffOrderController.list);
app.get("/api/orders/:orderId", isAuthen, isStaff, StaffOrderController.detail);
app.patch(
  "/api/orders/:orderId/status",
  isAuthen,
  isStaff,
  StaffOrderController.changeStatus,
);
app.patch(
  "/api/orders/:orderId/serve",
  isAuthen,
  isStaff,
  StaffOrderController.serve,
);
app.patch(
  "/api/kitchen/orders/:orderId/status",
  isAuthen,
  isStaff,
  KitchenOrderController.changeStatus,
);

//report
app.get(
  "/api/dashboard/operations",
  isAuthen,
  isAdmin,
  DashboardController.operations,
);
app.post("/api/report/sumMonthly", isAuthen, isAdmin, (req, res) =>
  ReportController.sumMonthly(req, res),
);
app.post("/api/report/dailySales", isAuthen, isAdmin, (req, res) =>
  ReportController.sumPerDayInYearAndMonth(req, res),
);

//billSale
app.post("/api/billSale/list", isAuthen, isAdmin, (req, res) =>
  BillSaleController.list(req, res),
);
app.delete("/api/billSale/remove/:id", isAuthen, isAdmin, (req, res) =>
  BillSaleController.remove(req, res),
);

//organization
app.post("/api/organization/upload", isAuthen, isAdmin, (req, res) =>
  OrganizationController.upload(req, res),
);
app.post("/api/organization/create", isAuthen, isAdmin, (req, res) =>
  OrganizationController.create(req, res),
);
app.get("/api/organization/info", isAuthen, isAdmin, (req, res) =>
  OrganizationController.info(req, res),
);

//saleTemp
app.post("/api/counterOrder/quote", isAuthen, isStaff, (req, res) =>
  CounterOrderController.quote(req, res),
);
app.get("/api/counterOrder/options/:foodId", isAuthen, isStaff, (req, res) =>
  CounterOrderController.options(req, res),
);
app.post("/api/counterOrder/submit", isAuthen, isStaff, (req, res) =>
  CounterOrderController.submit(req, res),
);
app.post("/api/counterOrder/checkout", isAuthen, isStaff, (req, res) =>
  CounterOrderController.checkout(req, res),
);
app.post("/api/counterOrder/prebill", isAuthen, isStaff, (req, res) =>
  CounterOrderController.prebill(req, res),
);
app.get("/api/counterOrder/sent", isAuthen, isStaff, (req, res) =>
  CounterOrderController.listSent(req, res),
);
app.get("/api/counterOrder/:id", isAuthen, isStaff, (req, res) =>
  CounterOrderController.sentDetail(req, res),
);
app.patch("/api/counterOrder/:id/cancel", isAuthen, isStaff, (req, res) =>
  CounterOrderController.cancelSent(req, res),
);
app.post("/api/counterOrder/:id/prebill", isAuthen, isStaff, (req, res) =>
  CounterOrderController.sentPrebill(req, res),
);
app.post("/api/counterOrder/:id/settle", isAuthen, isStaff, (req, res) =>
  CounterOrderController.settle(req, res),
);

app.post("/api/saleTemp/printBillAfterPay", isAuthen, isStaff, (req, res) =>
  SaleTempController.printBillAfterPay(req, res),
);
app.post("/api/saleTemp/endSale", isAuthen, isStaff, (req, res) =>
  SaleTempController.endSale(req, res),
);
app.post("/api/saleTemp/submitToKitchen", isAuthen, isStaff, (req, res) =>
  SaleTempController.submitToKitchen(req, res),
);
app.get("/api/saleTemp/pendingCounterOrders", isAuthen, isStaff, (req, res) =>
  SaleTempController.pendingCounterOrders(req, res),
);
app.post("/api/saleTemp/printBillBeforePay", isAuthen, isStaff, (req, res) =>
  SaleTempController.printBillBeforePay(req, res),
);
app.delete(
  "/api/saleTemp/removeSaleTempDetailModal",
  isAuthen,
  isStaff,
  (req, res) => SaleTempController.removeSaleTempDetailModal(req, res),
);
app.post("/api/saleTemp/createSaleTempDetail", isAuthen, isStaff, (req, res) =>
  SaleTempController.createSaleTempDetail(req, res),
);
app.put("/api/saleTemp/selectSize", isAuthen, isStaff, (req, res) =>
  SaleTempController.selectSize(req, res),
);
app.put("/api/saleTemp/unSelectTaste", isAuthen, isStaff, (req, res) =>
  SaleTempController.unSelectTaste(req, res),
);
app.put("/api/saleTemp/selectTaste", isAuthen, isStaff, (req, res) =>
  SaleTempController.selectTaste(req, res),
);
app.get("/api/saleTemp/info/:id", isAuthen, isStaff, (req, res) =>
  SaleTempController.info(req, res),
);
app.post(
  "/api/saleTemp/generateSaleTempDetail",
  isAuthen,
  isStaff,
  (req, res) => SaleTempController.generateSaleTempDetail(req, res),
);
app.put("/api/saleTemp/updateQty", isAuthen, isStaff, (req, res) =>
  SaleTempController.updateQty(req, res),
);
app.delete("/api/saleTemp/removeAll", isAuthen, isStaff, (req, res) =>
  SaleTempController.removeAll(req, res),
);
app.delete("/api/saleTemp/remove/:id", isAuthen, isStaff, (req, res) =>
  SaleTempController.remove(req, res),
);
app.get("/api/saleTemp/list/", isAuthen, isStaff, (req, res) =>
  SaleTempController.list(req, res),
);
app.post("/api/saleTemp/create", isAuthen, isStaff, (req, res) =>
  SaleTempController.create(req, res),
);

//food
app.post("/api/food/paginate", isAuthen, isAdmin, (req, res) =>
  FoodController.paginate(req, res),
);
app.get("/api/food/filter/:foodType", isAuthen, isStaff, (req, res) =>
  FoodController.filter(req, res),
);
app.post("/api/food/upload", isAuthen, isAdmin, (req, res) =>
  FoodController.upload(req, res),
);
app.post("/api/food/create", isAuthen, isAdmin, (req, res) =>
  FoodController.create(req, res),
);
app.get("/api/food/list", isAuthen, isAdmin, (req, res) =>
  FoodController.list(req, res),
);
app.delete("/api/food/remove/:id", isAuthen, isAdmin, (req, res) =>
  FoodController.remove(req, res),
);
app.put("/api/food/update", isAuthen, isAdmin, (req, res) =>
  FoodController.update(req, res),
);
//foodtaste
app.post("/api/taste/create", isAuthen, isAdmin, (req, res) =>
  TasteController.create(req, res),
);
app.get("/api/taste/list", isAuthen, isAdmin, (req, res) =>
  TasteController.list(req, res),
);
app.delete("/api/taste/remove/:id", isAuthen, isAdmin, (req, res) =>
  TasteController.remove(req, res),
);
app.put("/api/taste/update", isAuthen, isAdmin, (req, res) =>
  TasteController.update(req, res),
);
//foodsize
app.post("/api/foodSize/create", isAuthen, isAdmin, (req, res) =>
  foodSizeController.create(req, res),
);
app.get("/api/foodSize/list", isAuthen, isAdmin, (req, res) =>
  foodSizeController.list(req, res),
);
app.delete("/api/foodSize/remove/:id", isAuthen, isAdmin, (req, res) =>
  foodSizeController.remove(req, res),
);
app.put("/api/foodSize/update", isAuthen, isAdmin, (req, res) =>
  foodSizeController.update(req, res),
);
//foodtype

app.post("/api/foodtype/create", isAuthen, isAdmin, (req, res) =>
  foodTypeController.create(req, res),
);
app.get("/api/foodType/list", isAuthen, isAdmin, (req, res) =>
  foodTypeController.list(req, res),
);
app.put("/api/foodtype/update", isAuthen, isAdmin, (req, res) =>
  foodTypeController.update(req, res),
);

//remove
app.delete("/api/foodtype/remove/:id", isAuthen, isAdmin, (req, res) =>
  foodTypeController.remove(req, res),
);

//signIn
app.get("/api/user/getLevelByToken", isAuthen, isStaff, (req, res) =>
  UserController.getLevelByToken(req, res),
);
app.get("/api/user/list", isAuthen, isAdmin, (req, res) =>
  UserController.list(req, res),
);
app.put("/api/user/update", isAuthen, isAdmin, (req, res) =>
  UserController.update(req, res),
);
app.delete("/api/user/remove/:id", isAuthen, isAdmin, (req, res) =>
  UserController.remove(req, res),
);
app.post("/api/user/create", isAuthen, isAdmin, (req, res) =>
  UserController.create(req, res),
);
app.post("/api/user/signIn", (req, res) => UserController.signIn(req, res));

// Coordinates start server behavior for this module.
const startServer = (port = 3001) =>
  app.listen(port, () => {
    console.log(`API Server running on port ${port}`);
  });

const server = require.main === module ? startServer() : null;

module.exports = { app, server, startServer };
