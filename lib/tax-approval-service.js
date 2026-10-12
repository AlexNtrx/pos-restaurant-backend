const { Prisma } = require("@prisma/client");
const { isDeepStrictEqual } = require("node:util");
const { CatalogWriteError } = require("./catalog-write-error");
const { validateTaxDraft } = require("./tax-draft-validation");
const { readStoredConfiguration } = require("./tax-policy-validation");
const { configurationIssues } = require("./tax-policy-review-rules");
const {
  positiveId,
  sellerText,
  readRevision,
  readSellerSnapshot,
} = require("./tax-policy-snapshots");
const {
  UUID,
  validateReviewEvidence,
  validateApprovalRequest,
  validateApprovalPage,
  approvalFingerprint,
  helsinkiDay,
} = require("./tax-approval-validation");
const fail = (status, code, error, extra) => {
  throw new CatalogWriteError(status, { code, error, ...extra });
};
const verifyAdmin = async (client, id) => {
  const user =
    positiveId(id) &&
    (await client.user.findUnique({
      where: { id },
      select: { status: true, level: true, name: true },
    }));
  if (!user || user.status !== "use" || user.level !== "admin")
    fail(403, "FORBIDDEN", "Active administrator is required");
  return user;
};
const approvalDto = (row) => {
  try {
    const configuration = validateTaxDraft(row.configuration),
      reviewEvidence = validateReviewEvidence(row.reviewEvidence);
    if (
      [
        row.id,
        row.organizationId,
        row.sourceRevisionId,
        row.sourceDraftVersion,
        row.recordedByUserId,
      ].some((id) => !positiveId(id)) ||
      row.schemaVersion !== 1 ||
      typeof row.recordedByName !== "string" ||
      !row.recordedByName.trim() ||
      row.recordedByName !== row.recordedByName.trim() ||
      !(row.recordedAt instanceof Date) ||
      !Number.isFinite(row.recordedAt.getTime()) ||
      !UUID.test(row.idempotencyKey) ||
      configurationIssues(configuration).length ||
      !isDeepStrictEqual(configuration, row.configuration) ||
      !isDeepStrictEqual(reviewEvidence, row.reviewEvidence) ||
      row.requestFingerprint !==
        approvalFingerprint({
          sourceRevisionId: row.sourceRevisionId,
          expectedDraftVersion: row.sourceDraftVersion,
          reviewEvidence,
        })
    )
      throw new Error("Invalid approval");
    return {
      id: row.id,
      organizationId: row.organizationId,
      sourceRevisionId: row.sourceRevisionId,
      sourceDraftVersion: row.sourceDraftVersion,
      schemaVersion: 1,
      configuration,
      sellerSnapshot: readSellerSnapshot(row.sellerSnapshot),
      reviewEvidence,
      recordedAt: row.recordedAt,
      recordedByUserId: row.recordedByUserId,
      recordedByName: row.recordedByName,
    };
  } catch {
    fail(
      409,
      "TAX_POLICY_APPROVAL_INVALID",
      "Stored review approval is invalid",
    );
  }
};
const flags = { canActivate: false, commercialReady: false };
const listTaxApprovals = async (client, userId, query) => {
  await verifyAdmin(client, userId);
  const { page, pageSize, skip } = validateApprovalPage(query);
  return client.$transaction(
    async (tx) => {
      await verifyAdmin(tx, userId);
      const organization = await tx.organization.findFirst({
        orderBy: { id: "asc" },
        select: { id: true },
      });
      const where = { organizationId: organization?.id ?? -1 };
      const totalCount = await tx.taxPolicyApproval.count({ where });
      const rows = await tx.taxPolicyApproval.findMany({
        where,
        orderBy: { id: "desc" },
        skip,
        take: pageSize,
      });
      return {
        results: rows.map(approvalDto),
        totalCount,
        page,
        pageSize,
        pageCount: Math.ceil(totalCount / pageSize),
        ...flags,
      };
    },
    { isolationLevel: Prisma.TransactionIsolationLevel.RepeatableRead },
  );
};
const createTaxApproval = async (
  client,
  userId,
  body,
  now = () => new Date(),
) => {
  await verifyAdmin(client, userId);
  const request = validateApprovalRequest(body),
    fingerprint = approvalFingerprint(request);
  try {
    return await client.$transaction(
      async (tx) => {
        const user = await verifyAdmin(tx, userId);
        const locked =
          await tx.$queryRaw`SELECT "id" FROM "Organization" ORDER BY "id" ASC LIMIT 1 FOR UPDATE`;
        if (!locked.length)
          fail(
            409,
            "RESTAURANT_SETUP_REQUIRED",
            "Save restaurant settings first",
          );
        const organizationId = locked[0].id;
        // EN: Resolve the original request before current clock/draft/seller gates; a retry cannot create a different approval.
        // FI: Selvitä alkuperäinen pyyntö ennen nykyajan, luonnoksen ja myyjän tarkistuksia; uusinta ei voi luoda eri hyväksyntää.
        const prior = await tx.taxPolicyApproval.findUnique({
          where: {
            organizationId_idempotencyKey: {
              organizationId,
              idempotencyKey: request.idempotencyKey,
            },
          },
        });
        if (prior) {
          const approval = approvalDto(prior);
          if (
            prior.requestFingerprint !== fingerprint ||
            prior.recordedByUserId !== userId
          )
            fail(
              409,
              "TAX_APPROVAL_IDEMPOTENCY_CONFLICT",
              "This request key belongs to another review request",
            );
          return { created: false, approval, ...flags };
        }
        const source = await tx.taxPolicyRevision.findFirst({
          where: { id: request.sourceRevisionId, organizationId },
        });
        if (!source)
          fail(404, "TAX_POLICY_REVISION_NOT_FOUND", "Revision was not found");
        const revision = readRevision(source);
        const existing = await tx.taxPolicyApproval.findUnique({
          where: {
            organizationId_sourceRevisionId: {
              organizationId,
              sourceRevisionId: request.sourceRevisionId,
            },
          },
        });
        if (existing) {
          approvalDto(existing);
          fail(
            409,
            "TAX_POLICY_APPROVAL_ALREADY_EXISTS",
            "This revision already has a review approval",
            { existingApprovalId: existing.id },
          );
        }
        const organization = await tx.organization.findUnique({
          where: { id: organizationId },
        });
        const current = readStoredConfiguration(
          organization.taxSettingsDraft,
          organization.taxSettingsVersion,
        );
        if (
          request.expectedDraftVersion !== revision.sourceDraftVersion ||
          organization.taxSettingsVersion !== revision.sourceDraftVersion ||
          !isDeepStrictEqual(current, revision.configuration) ||
          !isDeepStrictEqual(sellerText(organization), revision.sellerSnapshot)
        )
          fail(
            409,
            "TAX_APPROVAL_SOURCE_CHANGED",
            "Review the current draft and seller before recording approval",
          );
        const issues = configurationIssues(revision.configuration);
        if (!user.name.trim())
          issues.push({ code: "ACTOR_NAME_REQUIRED", field: "recordedByName" });
        const recordedAt = now();
        if (request.reviewEvidence.reviewedOn > helsinkiDay(recordedAt))
          issues.push({ code: "REVIEW_DATE_IN_FUTURE", field: "reviewedOn" });
        if (issues.length)
          fail(
            409,
            "TAX_APPROVAL_INCOMPLETE",
            "Complete actual review evidence before recording approval",
            { issues },
          );
        const row = await tx.taxPolicyApproval.create({
          data: {
            organizationId,
            sourceRevisionId: revision.id,
            sourceDraftVersion: revision.sourceDraftVersion,
            schemaVersion: 1,
            configuration: revision.configuration,
            sellerSnapshot: revision.sellerSnapshot,
            reviewEvidence: request.reviewEvidence,
            idempotencyKey: request.idempotencyKey,
            requestFingerprint: fingerprint,
            recordedAt,
            recordedByUserId: userId,
            recordedByName: user.name.trim(),
          },
        });
        return { created: true, approval: approvalDto(row), ...flags };
      },
      { isolationLevel: Prisma.TransactionIsolationLevel.Serializable },
    );
  } catch (error) {
    // EN: Raw PostgreSQL lock errors use P2010; every conflict leaves the immutable record untouched.
    // FI: PostgreSQL:n raakalukkovirheet käyttävät P2010-koodia; jokainen ristiriita jättää muuttumattoman merkinnän ennalleen.
    if (
      ["P2002", "P2034"].includes(error?.code) ||
      (error?.code === "P2010" && ["40001", "40P01"].includes(error.meta?.code))
    )
      fail(
        409,
        "TAX_APPROVAL_CONFLICT",
        "Concurrent review change; retry the same request",
      );
    throw error;
  }
};
module.exports = { listTaxApprovals, createTaxApproval };
