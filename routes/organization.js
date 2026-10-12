const { parseImageUpload } = require("../middleware/image-upload");
const OrganizationController = require("../controller/OrganizationController");
const { isAdmin, isAuthen } = require("../middleware/auth");
const TaxDraftController = require("../controller/TaxDraftController");
const TaxPolicyController = require("../controller/TaxPolicyController");
const TaxPublicationReadinessController = require("../controller/TaxPublicationReadinessController");
const TaxApprovalController = require("../controller/TaxApprovalController");
const TaxControlController = require("../controller/TaxControlController");
const privateResponse = (_req, res, next) => {
  res.set("Cache-Control", "private, no-store");
  next();
};

module.exports = function registerOrganizationRoutes(app) {
  app.get(
    "/api/organization/tax-control",
    privateResponse,
    isAuthen,
    isAdmin,
    TaxControlController.read,
  );
  app.get(
    "/api/organization/tax-policy-approvals",
    privateResponse,
    isAuthen,
    isAdmin,
    TaxApprovalController.list,
  );
  app.post(
    "/api/organization/tax-policy-approvals",
    privateResponse,
    isAuthen,
    isAdmin,
    TaxApprovalController.create,
  );
  app.get(
    "/api/organization/tax-policy-publication-readiness",
    privateResponse,
    isAuthen,
    isAdmin,
    TaxPublicationReadinessController.read,
  );
  app.get(
    "/api/organization/tax-policy-review",
    privateResponse,
    isAuthen,
    isAdmin,
    TaxPolicyController.review,
  );
  app.get(
    "/api/organization/tax-policy-revisions",
    privateResponse,
    isAuthen,
    isAdmin,
    TaxPolicyController.list,
  );
  app.post(
    "/api/organization/tax-policy-revisions",
    privateResponse,
    isAuthen,
    isAdmin,
    TaxPolicyController.create,
  );
  app.get(
    "/api/organization/tax-draft",
    isAuthen,
    isAdmin,
    TaxDraftController.read,
  );
  app.put(
    "/api/organization/tax-draft",
    isAuthen,
    isAdmin,
    TaxDraftController.save,
  );
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
