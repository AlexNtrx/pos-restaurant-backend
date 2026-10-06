const UserController = require("../controller/UserController");
const { isAdmin, isAuthen } = require("../middleware/auth");

module.exports = function registerUsersRoutes(app) {
  //signIn
  app.get(
    "/api/user/getLevelByToken",
    isAuthen,
    UserController.getLevelByToken,
  );
  app.get("/api/user/list", isAuthen, isAdmin, UserController.list);
  app.put("/api/user/update", isAuthen, isAdmin, UserController.update);
  app.delete("/api/user/remove/:id", isAuthen, isAdmin, UserController.remove);
  app.post("/api/user/create", isAuthen, isAdmin, UserController.create);
  app.post("/api/user/signIn", UserController.signIn);
};
