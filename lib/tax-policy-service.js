const { configurationIssues } = require("./tax-policy-review-rules");
const { Prisma } = require("@prisma/client");
const { CatalogWriteError } = require("./catalog-write-error");
const { validateOrganization } = require("./organization-validation");
const {
  validateRevisionRequest,
  validateRevisionPage,
  readStoredConfiguration,
} = require("./tax-policy-validation");
const verifyAdmin = async (client, userId) => {
  const user =
    Number.isSafeInteger(userId) &&
    userId > 0 &&
    (await client.user.findUnique({
      where: { id: userId },
      select: { status: true, level: true, name: true },
    }));
  if (!user || user.status !== "use" || user.level !== "admin")
    throw new CatalogWriteError(403, {
      error: "Active administrator is required",
    });
  return user;
};
const revisionSelect = {
  id: true,
  organizationId: true,
  sourceDraftVersion: true,
  schemaVersion: true,
  configuration: true,
  sellerSnapshot: true,
  createdAt: true,
  createdByUserId: true,
  createdByName: true,
};
const review = async (client, organization, user) => {
  const issues = [];
  const add = (code, field) => issues.push({ code, field });
  const configuration = organization
    ? readStoredConfiguration(
        organization.taxSettingsDraft,
        organization.taxSettingsVersion,
      )
    : null;
  let sellerSnapshot = null;
  if (!organization) add("RESTAURANT_SETUP_REQUIRED", "seller");
  else {
    const seller = validateOrganization({ ...organization, logo: "" });
    if (seller.error) add("SELLER_INCOMPLETE", "seller");
    else {
      const { logo, ...text } = seller;
      sellerSnapshot = text;
    }
  }
  issues.push(...configurationIssues(configuration));
  if (!user.name.trim()) add("ACTOR_NAME_REQUIRED", "createdByName");
  const existing =
    organization && organization.taxSettingsVersion > 0
      ? await client.taxPolicyRevision.findUnique({
          where: {
            organizationId_sourceDraftVersion: {
              organizationId: organization.id,
              sourceDraftVersion: organization.taxSettingsVersion,
            },
          },
          select: { id: true },
        })
      : null;
  return {
    organizationConfigured: Boolean(organization),
    draftVersion: organization?.taxSettingsVersion ?? 0,
    canCreateRevision: issues.length === 0 && !existing,
    commercialReady: false,
    issues,
    existingRevisionId: existing?.id ?? null,
    configuration,
    sellerSnapshot,
  };
};
const readTaxPolicyReview = (client, userId) =>
  client.$transaction(
    async (tx) => {
      const user = await verifyAdmin(tx, userId);
      const organization = await tx.organization.findFirst({
        orderBy: { id: "asc" },
      });
      return review(tx, organization, user);
    },
    { isolationLevel: Prisma.TransactionIsolationLevel.RepeatableRead },
  );
const listTaxPolicyRevisions = async (client, userId, query) => {
  await verifyAdmin(client, userId);
  const { page, pageSize, skip } = validateRevisionPage(query);
  return client.$transaction(
    async (tx) => {
      await verifyAdmin(tx, userId);
      const organization = await tx.organization.findFirst({
        orderBy: { id: "asc" },
        select: { id: true },
      });
      const where = { organizationId: organization?.id ?? -1 };
      const totalCount = await tx.taxPolicyRevision.count({ where });
      const results = await tx.taxPolicyRevision.findMany({
        where,
        select: revisionSelect,
        orderBy: { id: "desc" },
        skip,
        take: pageSize,
      });
      return {
        results,
        totalCount,
        page,
        pageSize,
        pageCount: Math.ceil(totalCount / pageSize),
      };
    },
    { isolationLevel: Prisma.TransactionIsolationLevel.RepeatableRead },
  );
};
const createTaxPolicyRevision = async (client, userId, body) => {
  await verifyAdmin(client, userId);
  const expectedDraftVersion = validateRevisionRequest(body);
  try {
    return await client.$transaction(
      async (tx) => {
        const user = await verifyAdmin(tx, userId);
        // EN: Lock before reading seller/draft so one consistent copy is captured; retries return the original copy before comparing the newer draft.
        // FI: Lukitse ennen myyjän ja luonnoksen lukemista yhtenäisen kopion tallentamiseksi; uusintapyynnöt palauttavat alkuperäisen ennen uudemman luonnoksen vertailua.
        const rows =
          await tx.$queryRaw`SELECT "id" FROM "Organization" ORDER BY "id" ASC LIMIT 1 FOR UPDATE`;
        if (!rows.length)
          throw new CatalogWriteError(409, {
            code: "RESTAURANT_SETUP_REQUIRED",
            error: "Save restaurant settings first",
          });
        const organization = await tx.organization.findUnique({
          where: { id: rows[0].id },
        });
        const existing = await tx.taxPolicyRevision.findUnique({
          where: {
            organizationId_sourceDraftVersion: {
              organizationId: organization.id,
              sourceDraftVersion: expectedDraftVersion,
            },
          },
          select: revisionSelect,
        });
        if (existing) return { revision: existing, created: false };
        if (organization.taxSettingsVersion !== expectedDraftVersion)
          throw new CatalogWriteError(409, {
            code: "TAX_DRAFT_CONFLICT",
            error: "Review the latest saved draft",
          });
        const checked = await review(tx, organization, user);
        if (checked.issues.length)
          throw new CatalogWriteError(409, {
            code: "TAX_POLICY_REVIEW_INCOMPLETE",
            error: "Complete the saved draft before creating a revision",
            issues: checked.issues,
          });
        const revision = await tx.taxPolicyRevision.create({
          data: {
            organizationId: organization.id,
            sourceDraftVersion: expectedDraftVersion,
            schemaVersion: 1,
            configuration: checked.configuration,
            sellerSnapshot: checked.sellerSnapshot,
            createdByUserId: userId,
            createdByName: user.name.trim(),
          },
          select: revisionSelect,
        });
        return { revision, created: true };
      },
      { isolationLevel: Prisma.TransactionIsolationLevel.Serializable },
    );
  } catch (error) {
    // EN: PostgreSQL serialization/deadlock errors from raw row locks surface as P2010, not P2034.
    // FI: Raakarivilukon PostgreSQL-sarjallistus- ja lukkiutumisvirheet näkyvät P2010-virheinä, eivät P2034-virheinä.
    if (
      ["P2002", "P2034"].includes(error?.code) ||
      (error?.code === "P2010" && ["40001", "40P01"].includes(error.meta?.code))
    )
      throw new CatalogWriteError(409, {
        code: "TAX_DRAFT_CONFLICT",
        error: "Concurrent change; review or retry the same draft version",
      });
    throw error;
  }
};
module.exports = {
  readTaxPolicyReview,
  listTaxPolicyRevisions,
  createTaxPolicyRevision,
};
