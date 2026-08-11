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
const OrganizationController = require("./controller/OrganizationController");
const BillSaleController = require("./controller/BillSaleController");
const ReportController = require("./controller/ReportController");
const { isAdmin, isAuthen, isStaff } = require("./middleware/auth");

const dotenv = require("dotenv");
dotenv.config();

//report
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
app.post("/api/saleTemp/printBillAfterPay", isAuthen, isStaff, (req, res) =>
  SaleTempController.printBillAfterPay(req, res),
);
app.post("/api/saleTemp/endSale", isAuthen, isStaff, (req, res) =>
  SaleTempController.endSale(req, res),
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
