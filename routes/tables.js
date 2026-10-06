const TableController = require("../controller/TableController");
const TablePaymentController = require("../controller/TablePaymentController");
const {
  isAdmin,
  isAuthen,
  isStaff,
  isServiceStaff,
} = require("../middleware/auth");

module.exports = function registerTablesRoutes(app) {
  // EN: QR-01 raw access tokens are issued only to authenticated staff, never on a public route.
  // FI: QR-01:n alkuperäiset tunnisteet annetaan vain tunnistautuneelle henkilökunnalle, ei julkisella reitillä.
  app.get("/api/tables", isAuthen, isServiceStaff, TableController.list);
  app.post("/api/tables", isAuthen, isAdmin, TableController.create);
  app.put("/api/tables/:tableId", isAuthen, isAdmin, TableController.update);
  app.delete("/api/tables/:tableId", isAuthen, isAdmin, TableController.remove);
  app.post(
    "/api/tables/:tableId/sessions",
    isAuthen,
    isServiceStaff,
    TableController.openSession,
  );
  app.post(
    "/api/table-sessions/:sessionId/rotate-token",
    isAuthen,
    isAdmin,
    TableController.rotateToken,
  );
  app.post(
    "/api/table-sessions/:sessionId/close",
    isAuthen,
    isAdmin,
    TableController.closeSession,
  );
  app.post(
    "/api/table-sessions/:sessionId/settle",
    isAuthen,
    isStaff,
    TablePaymentController.settle,
  );
  app.get("/api/qr-mode", isAuthen, isAdmin, TableController.getQrMode);
  app.get(
    "/api/table-sessions/:sessionId/qr",
    isAuthen,
    isAdmin,
    TableController.reissueToken,
  );
  app.put("/api/qr-mode", isAuthen, isAdmin, TableController.setQrMode);
};
