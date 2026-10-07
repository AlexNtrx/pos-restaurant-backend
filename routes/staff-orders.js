const StaffOrderController = require("../controller/StaffOrderController");
const KitchenOrderController = require("../controller/KitchenOrderController");
const WaiterOrderController = require("../controller/WaiterOrderController");
const {
  isStaff,
  isAuthen,
  isServiceStaff,
  isOrderReader,
  isKitchenStaff,
} = require("../middleware/auth");

module.exports = function registerStaffOrdersRoutes(app) {
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
    isStaff,
    StaffOrderController.getRefund,
  );
  app.post(
    "/api/orders/:orderId/refund",
    isAuthen,
    isStaff,
    StaffOrderController.reserveRefund,
  );
  app.post(
    "/api/orders/:orderId/refund/complete",
    isAuthen,
    isStaff,
    StaffOrderController.completeRefund,
  );
  app.post(
    "/api/orders/:orderId/refund/fail",
    isAuthen,
    isStaff,
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
};
