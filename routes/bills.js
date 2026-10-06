const BillSaleController = require("../controller/BillSaleController");
const { isAdmin, isAuthen } = require("../middleware/auth");

module.exports = function registerBillsRoutes(app) {
  //billSale
  app.post("/api/billSale/list", isAuthen, isAdmin, BillSaleController.list);
  app.post(
    "/api/billSale/history",
    isAuthen,
    isAdmin,
    BillSaleController.history,
  );
  app.get(
    "/api/billSale/detail/:id",
    isAuthen,
    isAdmin,
    BillSaleController.detail,
  );
  app.delete(
    "/api/billSale/remove/:id",
    isAuthen,
    isAdmin,
    BillSaleController.remove,
  );
};
