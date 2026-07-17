const bodyParser = require("body-parser");
const express = require("express");
const app = express();
const cors = require("cors");
const fileUpload = require("express-fileupload");

app.use(bodyParser.json());
app.use(bodyParser.urlencoded({ extended: true }));
app.use(cors());
app.use(fileUpload());
app.use("/uploads", express.static("uploads"));

const UserController = require("./controller/UserController");
const foodTypeController = require("./controller/FoodTypeControllert");
const foodSizeController = require("./controller/FoodSizeController");
const TasteController = require("./controller/TasteController");
const FoodController = require("./controller/FoodController");
const SaleTempController = require("./controller/SaleTempController");
const OrganizationController = require("./controller/OrganizationController");
const BillSaleController = require("./controller/BillSaleController");
const ReportController = require("./controller/ReportController");

const jwt = require("jsonwebtoken");
const dotenv = require("dotenv");
dotenv.config();

const getTokenFromRequest = (req) => {
  const authorizationHeader =
    req.headers.authorization || req.headers.Authorization;

  if (!authorizationHeader) return null;

  const parts = authorizationHeader.split(" ");
  if (parts.length === 2) {
    return parts[1];
  }

  if (authorizationHeader.toLowerCase().startsWith("bearer")) {
    return authorizationHeader.slice(6).trim();
  }

  return authorizationHeader;
};

const isAuthen = (req, res, next) => {
  const token = getTokenFromRequest(req);

  if (!token) {
    return res.status(401).send({ error: "Unauthorized" });
  }

  try {
    const decoded = jwt.verify(token, process.env.SECRET_KEY);
    req.user = decoded;
    next();
  } catch (error) {
    return res.status(401).send({ error: "Unauthorized" });
  }
};
const isAdmin = (req, res, next) => {
  if (req.user.level !== "admin") {
    return res.status(403).send({
      error: "Only admin",
    });
  }

  next();
};

//report
app.post("/api/report/sumMonthly", isAuthen, isAdmin, (req, res) =>
  ReportController.sumMonthly(req, res),
);
app.post("/api/report/dailySales", isAuthen, isAdmin, (req, res) =>
  ReportController.sumPerDayInYearAndMonth(req, res),
);

//billSale
app.post("/api/billSale/list", isAuthen,isAdmin, (req, res) =>
  BillSaleController.list(req, res),
);
app.delete("/api/billSale/remove/:id", isAuthen,isAdmin, (req, res) =>
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
app.post("/api/saleTemp/printBillAfterPay", isAuthen, (req, res) =>
  SaleTempController.printBillAfterPay(req, res),
);
app.post("/api/saleTemp/endSale", isAuthen, (req, res) =>
  SaleTempController.endSale(req, res),
);
app.post("/api/saleTemp/printBillBeforePay", isAuthen, (req, res) =>
  SaleTempController.printBillBeforePay(req, res),
);
app.delete("/api/saleTemp/removeSaleTempDetailModal", isAuthen, (req, res) =>
  SaleTempController.removeSaleTempDetailModal(req, res),
);
app.post("/api/saleTemp/createSaleTempDetail", isAuthen, (req, res) =>
  SaleTempController.createSaleTempDetail(req, res),
);
app.put("/api/saleTemp/selectSize", isAuthen, (req, res) =>
  SaleTempController.selectSize(req, res),
);
app.put("/api/saleTemp/UnSelectTaste", isAuthen, (req, res) =>
  SaleTempController.unSelectTaste(req, res),
);
app.put("/api/saleTemp/selectTaste", isAuthen, (req, res) =>
  SaleTempController.selectTaste(req, res),
);
app.get("/api/saleTemp/info/:id", isAuthen, (req, res) =>
  SaleTempController.info(req, res),
);
app.post("/api/saleTemp/generateSaleTempDetail", isAuthen, (req, res) =>
  SaleTempController.generateSaleTempDetail(req, res),
);
app.put("/api/saleTemp/updateQty", isAuthen, (req, res) =>
  SaleTempController.updateQty(req, res),
);
app.delete("/api/saleTemp/removeAll", isAuthen, (req, res) =>
  SaleTempController.removeAll(req, res),
);
app.delete("/api/saleTemp/remove/:id", isAuthen, (req, res) =>
  SaleTempController.remove(req, res),
);
app.get("/api/saleTemp/list/", isAuthen, (req, res) =>
  SaleTempController.list(req, res),
);
app.post("/api/saleTemp/create", isAuthen, (req, res) =>
  SaleTempController.create(req, res),
);

//food
app.get("/api/food/filter/:foodType", isAuthen, (req, res) =>
  FoodController.filter(req, res),
);
app.post("/api/food/upload", isAuthen, (req, res) =>
  FoodController.upload(req, res),
);
app.post("/api/food/create", isAuthen, (req, res) =>
  FoodController.create(req, res),
);
app.get("/api/food/list", isAuthen, (req, res) =>
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
app.get("/api/user/getLevelByToken", isAuthen,(req, res) =>
  UserController.getLevelByToken(req, res),
);
app.get("/api/user/list",isAuthen, isAdmin, (req, res) => UserController.list(req, res));
app.put("/api/user/update", isAuthen, isAdmin,(req, res) => UserController.update(req, res));
app.delete("/api/user/remove/:id",isAuthen, isAdmin, (req, res) =>
  UserController.remove(req, res),
);
app.post("/api/user/create", (req, res) => UserController.create(req, res));
app.post("/api/user/signIn", (req, res) => UserController.signIn(req, res));

app.listen(3001, () => {
  console.log("API Server running on port 3001");
});
