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

//saleTemp
app.get("/api/saleTemp/list", (req, res) => SaleTempController.list(req, res));
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
app.post("/api/user/signIn", (req, res) => UserController.signIn(req, res));

app.listen(3001, () => {
  console.log("API Server running on port 3001");
});
