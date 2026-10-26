const { parseImageUpload } = require("../middleware/image-upload");
const OrganizationController = require("../controller/OrganizationController");
const { isAdmin, isAuthen } = require("../middleware/auth");

module.exports = function registerOrganizationRoutes(app) {
  //organization
  app.post(
    "/api/organization/upload",
    isAuthen,
    isAdmin,
    parseImageUpload,
    OrganizationController.upload,
  );
  app.post(
    "/api/organization/create",
    isAuthen,
    isAdmin,
    OrganizationController.create,
  );
  app.get(
    "/api/organization/info",
    isAuthen,
    isAdmin,
    OrganizationController.info,
  );
};
