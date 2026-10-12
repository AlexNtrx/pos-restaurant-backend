CREATE TABLE "TaxPolicyRevision" (
    "id" SERIAL NOT NULL,
    "organizationId" INTEGER NOT NULL,
    "sourceDraftVersion" INTEGER NOT NULL,
    "schemaVersion" INTEGER NOT NULL DEFAULT 1,
    "configuration" JSONB NOT NULL,
    "sellerSnapshot" JSONB NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "createdByUserId" INTEGER NOT NULL,
    "createdByName" TEXT NOT NULL,
    CONSTRAINT "TaxPolicyRevision_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "TaxPolicyRevision_sourceDraftVersion_check" CHECK ("sourceDraftVersion" > 0),
    CONSTRAINT "TaxPolicyRevision_schemaVersion_check" CHECK ("schemaVersion" = 1)
);
CREATE UNIQUE INDEX "TaxPolicyRevision_organizationId_sourceDraftVersion_key" ON "TaxPolicyRevision"("organizationId", "sourceDraftVersion");
CREATE INDEX "TaxPolicyRevision_organizationId_id_idx" ON "TaxPolicyRevision"("organizationId", "id");
ALTER TABLE "TaxPolicyRevision" ADD CONSTRAINT "TaxPolicyRevision_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "Organization"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
