const QrPublicController = require("../controller/QrPublicController");
const ServiceCallController = require("../controller/ServiceCallController");

module.exports = function registerQrPublicRoutes(app) {
  // EN: Public QR requests use the table token only; no staff bearer token grants customer access.
  // FI: Julkiset QR-pyynnöt käyttävät vain pöytätunnistetta; henkilökunnan bearer-tunniste ei anna asiakaspääsyä.
  app.get("/api/qr/:token/context", QrPublicController.context);
  app.get("/api/qr/:token/menu", QrPublicController.menu);
  app.post("/api/qr/:token/orders", QrPublicController.submit);
  app.get("/api/qr/:token/orders/:orderId", QrPublicController.order);
  app.get("/api/qr/:token/service-call", ServiceCallController.current);
  app.post("/api/qr/:token/service-call", ServiceCallController.create);
};
