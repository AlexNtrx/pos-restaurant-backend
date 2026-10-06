const ReportController = require("../controller/ReportController");
const DashboardController = require("../controller/DashboardController");
const { isAdmin, isAuthen } = require("../middleware/auth");

module.exports = function registerReportsRoutes(app) {
  //report
  app.get(
    "/api/dashboard/operations",
    isAuthen,
    isAdmin,
    DashboardController.operations,
  );
  app.post(
    "/api/report/sumMonthly",
    isAuthen,
    isAdmin,
    ReportController.sumMonthly,
  );
  app.post(
    "/api/report/dailySales",
    isAuthen,
    isAdmin,
    ReportController.sumPerDayInYearAndMonth,
  );
};
