-- EN: Seed only the legacy baseline; no transition, approval or financial history is invented.
-- FI: Alusta vain vanha lähtötila; siirtymä-, hyväksyntä- tai taloushistoriaa ei keksitä.
CREATE TABLE "OrganizationTaxControl" (
    "organizationId" INTEGER NOT NULL,
    "mode" TEXT NOT NULL DEFAULT 'LEGACY',
    "generation" INTEGER NOT NULL DEFAULT 0,
    "version" INTEGER NOT NULL DEFAULT 1,
    "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "OrganizationTaxControl_pkey" PRIMARY KEY ("organizationId"),
    CONSTRAINT "OrganizationTaxControl_state" CHECK (
        "organizationId" > 0 AND "mode" IN ('LEGACY', 'DRAINING')
        AND "generation" BETWEEN 0 AND 2147483646
        AND "version"::bigint = "generation"::bigint + 1
    )
);
CREATE TABLE "TaxControlEvent" (
    "id" SERIAL NOT NULL,
    "organizationId" INTEGER NOT NULL,
    "schemaVersion" INTEGER NOT NULL DEFAULT 1,
    "action" TEXT NOT NULL,
    "fromMode" TEXT NOT NULL,
    "toMode" TEXT NOT NULL,
    "fromGeneration" INTEGER NOT NULL,
    "toGeneration" INTEGER NOT NULL,
    "fromVersion" INTEGER NOT NULL,
    "toVersion" INTEGER NOT NULL,
    "reason" TEXT NOT NULL,
    "idempotencyKey" TEXT NOT NULL,
    "requestFingerprint" TEXT NOT NULL,
    "recordedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "recordedByUserId" INTEGER NOT NULL,
    "recordedByName" TEXT NOT NULL,
    CONSTRAINT "TaxControlEvent_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "TaxControlEvent_metadata" CHECK (
        "organizationId" > 0 AND "recordedByUserId" > 0 AND "schemaVersion" = 1
        AND length(btrim("recordedByName")) > 0 AND "recordedByName" = btrim("recordedByName")
        AND length("reason") BETWEEN 3 AND 500 AND "reason" = btrim("reason")
        AND "idempotencyKey" ~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
        AND "requestFingerprint" ~ '^[0-9a-f]{64}$'
    ),
    CONSTRAINT "TaxControlEvent_transition" CHECK (
        ("action" = 'DRAIN' AND "fromMode" = 'LEGACY' AND "toMode" = 'DRAINING')
        OR ("action" = 'RESUME_LEGACY' AND "fromMode" = 'DRAINING' AND "toMode" = 'LEGACY')
    ),
    CONSTRAINT "TaxControlEvent_generation" CHECK (
        "fromGeneration" BETWEEN 0 AND 2147483645
        AND "toGeneration"::bigint = "fromGeneration"::bigint + 1
        AND "fromVersion"::bigint = "fromGeneration"::bigint + 1
        AND "toVersion"::bigint = "toGeneration"::bigint + 1
    )
);
CREATE UNIQUE INDEX "TaxControlEvent_organizationId_idempotencyKey_key" ON "TaxControlEvent"("organizationId", "idempotencyKey");
CREATE UNIQUE INDEX "TaxControlEvent_organizationId_toGeneration_key" ON "TaxControlEvent"("organizationId", "toGeneration");
CREATE INDEX "TaxControlEvent_organizationId_id_idx" ON "TaxControlEvent"("organizationId", "id");
ALTER TABLE "OrganizationTaxControl" ADD CONSTRAINT "OrganizationTaxControl_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "Organization"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "TaxControlEvent" ADD CONSTRAINT "TaxControlEvent_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "OrganizationTaxControl"("organizationId") ON DELETE RESTRICT ON UPDATE CASCADE;
INSERT INTO "OrganizationTaxControl" ("organizationId") SELECT "id" FROM "Organization";
