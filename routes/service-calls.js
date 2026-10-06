const ServiceCallController = require("../controller/ServiceCallController");
const { isAuthen, isServiceStaff } = require("../middleware/auth");

module.exports = function registerServiceCallsRoutes(app) {
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
};
