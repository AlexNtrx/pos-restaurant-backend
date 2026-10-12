const { Prisma } = require("@prisma/client");
const { isDeepStrictEqual } = require("node:util");
const { CatalogWriteError } = require("./catalog-write-error");
const { readStoredConfiguration } = require("./tax-policy-validation");
const { configurationIssues } = require("./tax-policy-review-rules");
const { TERMINAL_ORDER_STATUSES } = require("./table-service-shared");
const {
  positiveId: positive,
  sellerText,
  readRevision,
} = require("./tax-policy-snapshots");
const validateReadinessQuery = (query) => {
  if (
    !query ||
    Object.keys(query).length !== 1 ||
    typeof query.revisionId !== "string" ||
    !/^[1-9]\d{0,9}$/.test(query.revisionId) ||
    !positive(Number(query.revisionId))
  )
    throw new CatalogWriteError(400, {
      code: "INVALID_TAX_PUBLICATION_QUERY",
      error: "A valid revisionId is required",
    });
  return Number(query.revisionId);
};
const verifyAdmin = async (client, id) => {
  const user =
    positive(id) &&
    (await client.user.findUnique({
      where: { id },
      select: { status: true, level: true },
    }));
  if (!user || user.status !== "use" || user.level !== "admin")
    throw new CatalogWriteError(403, {
      error: "Active administrator is required",
    });
};
const readTaxPublicationReadiness = async (client, userId, query) => {
  await verifyAdmin(client, userId);
  const id = validateReadinessQuery(query);
  return client.$transaction(
    async (tx) => {
      await verifyAdmin(tx, userId);
      const organization = await tx.organization.findFirst({
        orderBy: { id: "asc" },
      });
      if (!organization)
        throw new CatalogWriteError(409, {
          code: "RESTAURANT_SETUP_REQUIRED",
          error: "Save restaurant settings first",
        });
      const stored = await tx.taxPolicyRevision.findFirst({
        where: { id, organizationId: organization.id },
      });
      if (!stored)
        throw new CatalogWriteError(404, {
          code: "TAX_POLICY_REVISION_NOT_FOUND",
          error: "Revision was not found",
        });
      const revision = readRevision(stored);
      const current = readStoredConfiguration(
        organization.taxSettingsDraft,
        organization.taxSettingsVersion,
      );
      const seller = sellerText(organization);
      const candidateMatchesCurrentDraft =
        revision.sourceDraftVersion === organization.taxSettingsVersion &&
        isDeepStrictEqual(current, revision.configuration);
      const sellerMatchesCurrent = Boolean(
        seller && isDeepStrictEqual(seller, revision.sellerSnapshot),
      );
      // EN: Counts share one snapshot and cover this single-restaurant database; a query failure must never become a zero/pass result.
      // FI: Laskennat käyttävät samaa tilannekuvaa ja kattavat tämän yhden ravintolan tietokannan; kyselyvirheestä ei saa tulla nollaa tai hyväksyttyä tulosta.
      const activeItems = await tx.food.count({ where: { status: "use" } });
      const unclassifiedItems = await tx.food.count({
        where: { status: "use", taxCategory: null },
      });
      const unsupportedItems = await tx.food.count({
        where: {
          status: "use",
          taxCategory: { notIn: ["FOOD_NON_ALCOHOLIC", "ALCOHOL"] },
        },
      });
      const nonterminal = { status: { notIn: TERMINAL_ORDER_STATUSES } };
      const outstanding = {
        unpaidOrders: await tx.order.count({
          where: { ...nonterminal, billSaleId: null },
        }),
        paidOpenOrders: await tx.order.count({
          where: { ...nonterminal, billSaleId: { not: null } },
        }),
        legacyCartLines: await tx.saleTemp.count(),
        openTableSessions: await tx.tableSession.count({
          where: { status: "OPEN" },
        }),
        pendingRefunds: await tx.orderRefund.count({
          where: { status: "PENDING" },
        }),
        failedRefunds: await tx.orderRefund.count({
          where: { status: "FAILED" },
        }),
      };
      const checks = [];
      const add = (code, scope, passed, field) =>
        checks.push({
          code,
          scope,
          state: passed ? "PASS" : "BLOCKED",
          ...(field && { field }),
        });
      const issues = configurationIssues(revision.configuration);
      add("CANDIDATE_COMPLETE", "DATA", issues.length === 0);
      for (const issue of issues)
        add(
          issue.code === "RATE_MUST_BE_EMPTY"
            ? "CANDIDATE_RATE_MUST_BE_EMPTY"
            : "CANDIDATE_FIELD_REQUIRED",
          "DATA",
          false,
          issue.field,
        );
      add("CURRENT_DRAFT_MATCH", "DATA", candidateMatchesCurrentDraft);
      add("SELLER_COMPLETE", "DATA", Boolean(seller));
      add("SELLER_MATCH", "DATA", sellerMatchesCurrent);
      add("ACTIVE_MENU", "DATA", activeItems > 0);
      add(
        "TAX_CATEGORY_ASSIGNMENT",
        "DATA",
        revision.configuration.vatStatus === "NOT_REGISTERED" ||
          unclassifiedItems === 0,
      );
      add("TAX_CATEGORY_SUPPORTED", "DATA", unsupportedItems === 0);
      const workCodes = {
        unpaidOrders: "UNPAID_ORDERS",
        paidOpenOrders: "PAID_OPEN_ORDERS",
        legacyCartLines: "LEGACY_CART_LINES",
        openTableSessions: "OPEN_TABLE_SESSIONS",
        pendingRefunds: "PENDING_REFUNDS",
        failedRefunds: "FAILED_REFUNDS",
      };
      for (const [key, count] of Object.entries(outstanding))
        add(workCodes[key], "OPERATIONAL", count === 0);
      // EN: A database snapshot cannot verify merchant consent, external funds or every browser's pending intent; readiness has no activation authority.
      // FI: Tietokannan tilannekuva ei vahvista kauppiaan suostumusta, ulkoisia varoja tai kaikkien selainten keskeneräisiä pyyntöjä; tarkistus ei oikeuta käyttöönottoa.
      for (const code of [
        "MERCHANT_POLICY_UNCONFIRMED",
        "TAX_EVENT_UNCONFIRMED",
        "PAYMENT_EVIDENCE_UNCONFIRMED",
        "BROWSER_PENDING_OUTCOMES_UNVERIFIED",
      ])
        checks.push({ code, scope: "EXTERNAL", state: "UNVERIFIED" });
      checks.push({
        code: "PUBLICATION_RUNTIME_NOT_IMPLEMENTED",
        scope: "RUNTIME",
        state: "BLOCKED",
      });
      return {
        revision,
        currentDraftVersion: organization.taxSettingsVersion,
        candidateMatchesCurrentDraft,
        sellerMatchesCurrent,
        observedAt: new Date().toISOString(),
        catalog: { activeItems, unclassifiedItems, unsupportedItems },
        outstanding,
        checks,
        technicalChecksPassed: checks
          .filter((check) => ["DATA", "OPERATIONAL"].includes(check.scope))
          .every((check) => check.state === "PASS"),
        canPublish: false,
        canActivate: false,
        commercialReady: false,
      };
    },
    { isolationLevel: Prisma.TransactionIsolationLevel.RepeatableRead },
  );
};
module.exports = { readTaxPublicationReadiness, validateReadinessQuery };
