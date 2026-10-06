const { parseImageUpload } = require("../middleware/image-upload");
const foodTypeController = require("../controller/FoodTypeController");
const foodSizeController = require("../controller/FoodSizeController");
const TasteController = require("../controller/TasteController");
const FoodController = require("../controller/FoodController");
const { isAdmin, isAuthen, isStaff } = require("../middleware/auth");

module.exports = function registerCatalogRoutes(app) {
  //food
  app.post("/api/food/paginate", isAuthen, isAdmin, FoodController.paginate);
  app.get(
    "/api/food/filter/:foodType",
    isAuthen,
    isStaff,
    FoodController.filter,
  );
  app.post(
    "/api/food/upload",
    isAuthen,
    isAdmin,
    parseImageUpload,
    FoodController.upload,
  );
  app.post("/api/food/create", isAuthen, isAdmin, FoodController.create);
  app.get("/api/food/list", isAuthen, isAdmin, FoodController.list);
  app.delete("/api/food/remove/:id", isAuthen, isAdmin, FoodController.remove);
  app.put("/api/food/update", isAuthen, isAdmin, FoodController.update);
  //foodtaste
  app.post("/api/taste/create", isAuthen, isAdmin, TasteController.create);
  app.get("/api/taste/list", isAuthen, isAdmin, TasteController.list);
  app.delete(
    "/api/taste/remove/:id",
    isAuthen,
    isAdmin,
    TasteController.remove,
  );
  app.put("/api/taste/update", isAuthen, isAdmin, TasteController.update);
  //foodsize
  app.post(
    "/api/foodSize/create",
    isAuthen,
    isAdmin,
    foodSizeController.create,
  );
  app.get("/api/foodSize/list", isAuthen, isAdmin, foodSizeController.list);
  app.delete(
    "/api/foodSize/remove/:id",
    isAuthen,
    isAdmin,
    foodSizeController.remove,
  );
  app.put("/api/foodSize/update", isAuthen, isAdmin, foodSizeController.update);
  //foodtype

  app.post(
    "/api/foodtype/create",
    isAuthen,
    isAdmin,
    foodTypeController.create,
  );
  app.get("/api/foodType/list", isAuthen, isAdmin, foodTypeController.list);
  app.put("/api/foodtype/update", isAuthen, isAdmin, foodTypeController.update);

  //remove
  app.delete(
    "/api/foodtype/remove/:id",
    isAuthen,
    isAdmin,
    foodTypeController.remove,
  );
};
