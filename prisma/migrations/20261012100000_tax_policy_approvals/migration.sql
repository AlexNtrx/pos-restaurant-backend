CREATE UNIQUE INDEX "TaxPolicyRevision_organizationId_id_key" ON "TaxPolicyRevision"("organizationId", "id");
CREATE TABLE "TaxPolicyApproval" (
    "id" SERIAL NOT NULL,
    "organizationId" INTEGER NOT NULL,
    "sourceRevisionId" INTEGER NOT NULL,
    "sourceDraftVersion" INTEGER NOT NULL,
    "schemaVersion" INTEGER NOT NULL DEFAULT 1,
    "configuration" JSONB NOT NULL,
    "sellerSnapshot" JSONB NOT NULL,
    "reviewEvidence" JSONB NOT NULL,
    "idempotencyKey" TEXT NOT NULL,
    "requestFingerprint" TEXT NOT NULL,
    "recordedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "recordedByUserId" INTEGER NOT NULL,
    "recordedByName" TEXT NOT NULL,
    CONSTRAINT "TaxPolicyApproval_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "TaxPolicyApproval_positive_ids" CHECK ("organizationId" > 0 AND "sourceRevisionId" > 0 AND "sourceDraftVersion" > 0 AND "recordedByUserId" > 0),
    CONSTRAINT "TaxPolicyApproval_schema_version" CHECK ("schemaVersion" = 1),
    CONSTRAINT "TaxPolicyApproval_actor_name" CHECK (length(btrim("recordedByName")) > 0 AND "recordedByName" = btrim("recordedByName")),
    CONSTRAINT "TaxPolicyApproval_key_uuid" CHECK ("idempotencyKey" ~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'),
    CONSTRAINT "TaxPolicyApproval_fingerprint" CHECK ("requestFingerprint" ~ '^[0-9a-f]{64}$'),
    CONSTRAINT "TaxPolicyApproval_json_objects" CHECK (jsonb_typeof("configuration") = 'object' AND jsonb_typeof("sellerSnapshot") = 'object' AND jsonb_typeof("reviewEvidence") = 'object')
);
CREATE UNIQUE INDEX "TaxPolicyApproval_organizationId_sourceRevisionId_key" ON "TaxPolicyApproval"("organizationId", "sourceRevisionId");
CREATE UNIQUE INDEX "TaxPolicyApproval_organizationId_idempotencyKey_key" ON "TaxPolicyApproval"("organizationId", "idempotencyKey");
CREATE INDEX "TaxPolicyApproval_organizationId_id_idx" ON "TaxPolicyApproval"("organizationId", "id");
ALTER TABLE "TaxPolicyApproval" ADD CONSTRAINT "TaxPolicyApproval_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "Organization"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "TaxPolicyApproval" ADD CONSTRAINT "TaxPolicyApproval_sourceRevision_fkey" FOREIGN KEY ("organizationId", "sourceRevisionId") REFERENCES "TaxPolicyRevision"("organizationId", "id") ON DELETE RESTRICT ON UPDATE CASCADE;
