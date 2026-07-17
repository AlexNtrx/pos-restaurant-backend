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

const isAuthen = (req, res, next) => {
  if (req.headers.authorization) {
    const token = req.headers.authorization.split(" ")[1];
    const decoded = jwt.verify(token, process.env.SECRET_KEY);

    if (decoded) {
      next();
    } else {
      res.status(401).send({ error: "Unauthorized" });
    }
  } else {
    res.status(401).send({ error: "Unauthorized" });
  }
};

//report
app.post("/api/report/sumMonthly",isAuthen, (req, res) =>
  ReportController.sumMonthly(req, res),
);
app.post("/api/report/dailySales",isAuthen, (req, res) =>
  ReportController.sumPerDayInYearAndMonth(req, res),
);

//billSale
app.post("/api/billSale/list", (req, res) => BillSaleController.list(req, res));
app.delete("/api/billSale/remove/:id", (req, res) =>
  BillSaleController.remove(req, res),
);

//organization
app.post("/api/organization/upload", (req, res) =>
  OrganizationController.upload(req, res),
);
app.post("/api/organization/create", (req, res) =>
  OrganizationController.create(req, res),
);
app.get("/api/organization/info", (req, res) =>
  OrganizationController.info(req, res),
);

//saleTemp
app.post("/api/saleTemp/printBillAfterPay", (req, res) =>
  SaleTempController.printBillAfterPay(req, res),
);
app.post("/api/saleTemp/endSale", (req, res) =>
  SaleTempController.endSale(req, res),
);
app.post("/api/saleTemp/printBillBeforePay", (req, res) =>
  SaleTempController.printBillBeforePay(req, res),
);
app.delete("/api/saleTemp/removeSaleTempDetailModal", (req, res) =>
  SaleTempController.removeSaleTempDetailModal(req, res),
);
app.post("/api/saleTemp/createSaleTempDetail", (req, res) =>
  SaleTempController.createSaleTempDetail(req, res),
);
app.put("/api/saleTemp/selectSize", (req, res) =>
  SaleTempController.selectSize(req, res),
);
app.put("/api/saleTemp/UnSelectTaste", (req, res) =>
  SaleTempController.unSelectTaste(req, res),
);
app.put("/api/saleTemp/selectTaste", (req, res) =>
  SaleTempController.selectTaste(req, res),
);
app.get("/api/saleTemp/info/:id", (req, res) =>
  SaleTempController.info(req, res),
);
app.post("/api/saleTemp/generateSaleTempDetail", (req, res) =>
  SaleTempController.generateSaleTempDetail(req, res),
);
app.put("/api/saleTemp/updateQty", (req, res) =>
  SaleTempController.updateQty(req, res),
);
app.delete("/api/saleTemp/removeAll", (req, res) =>
  SaleTempController.removeAll(req, res),
);
app.delete("/api/saleTemp/remove/:id", (req, res) =>
  SaleTempController.remove(req, res),
);
app.get("/api/saleTemp/list/", (req, res) => SaleTempController.list(req, res));
app.post("/api/saleTemp/create", (req, res) =>
  SaleTempController.create(req, res),
);

//food
app.get("/api/food/filter/:foodType", (req, res) =>
  FoodController.filter(req, res),
);
app.post("/api/food/upload", (req, res) => FoodController.upload(req, res));
app.post("/api/food/create", (req, res) => FoodController.create(req, res));
app.get("/api/food/list", (req, res) => FoodController.list(req, res));
app.delete("/api/food/remove/:id", (req, res) =>
  FoodController.remove(req, res),
);
app.put("/api/food/update", (req, res) => FoodController.update(req, res));
//foodtaste
app.post("/api/taste/create", (req, res) => TasteController.create(req, res));
app.get("/api/taste/list", (req, res) => TasteController.list(req, res));
app.delete("/api/taste/remove/:id", (req, res) =>
  TasteController.remove(req, res),
);
app.put("/api/taste/update", (req, res) => TasteController.update(req, res));
//foodsize
app.post("/api/foodSize/create", (req, res) =>
  foodSizeController.create(req, res),
);
app.get("/api/foodSize/list", (req, res) => foodSizeController.list(req, res));
app.delete("/api/foodSize/remove/:id", (req, res) =>
  foodSizeController.remove(req, res),
);
app.put("/api/foodSize/update", (req, res) =>
  foodSizeController.update(req, res),
);
//foodtype

app.post("/api/foodtype/create", (req, res) =>
  foodTypeController.create(req, res),
);
app.get("/api/foodType/list", (req, res) => foodTypeController.list(req, res));
app.put("/api/foodtype/update", (req, res) =>
  foodTypeController.update(req, res),
);

//remove
app.delete("/api/foodtype/remove/:id", (req, res) =>
  foodTypeController.remove(req, res),
);

//signIn
app.get("/api/user/list", (req, res) => UserController.list(req, res));
app.put("/api/user/update", (req, res) => UserController.update(req, res));
app.delete("/api/user/remove/:id", (req, res) =>
  UserController.remove(req, res),
);
app.post("/api/user/create", (req, res) => UserController.create(req, res));
app.post("/api/user/signIn", (req, res) => UserController.signIn(req, res));

app.listen(3001, () => {
  console.log("API Server running on port 3001");
});
