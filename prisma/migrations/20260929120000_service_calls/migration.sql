CREATE TYPE "ServiceCallStatus" AS ENUM ('REQUESTED', 'ACKNOWLEDGED', 'RESOLVED');

CREATE TABLE "ServiceCall" (
    "id" SERIAL NOT NULL,
    "tableSessionId" INTEGER NOT NULL,
    "status" "ServiceCallStatus" NOT NULL DEFAULT 'REQUESTED',
    "version" INTEGER NOT NULL DEFAULT 1,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "acknowledgedAt" TIMESTAMP(3),
    "resolvedAt" TIMESTAMP(3),
    "acknowledgedByUserId" INTEGER,
    "resolvedByUserId" INTEGER,
    CONSTRAINT "ServiceCall_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "ServiceCall_version_positive" CHECK ("version" > 0)
);

CREATE INDEX "ServiceCall_status_createdAt_idx" ON "ServiceCall"("status", "createdAt");
CREATE INDEX "ServiceCall_tableSessionId_createdAt_idx" ON "ServiceCall"("tableSessionId", "createdAt");

-- EN: One unresolved call per table session makes concurrent QR retries idempotent.
-- FI: Yksi keskeneräinen kutsu pöytäistuntoa kohden tekee samanaikaisista QR-uusintayrityksistä idempotentteja.
CREATE UNIQUE INDEX "ServiceCall_one_active_per_session"
    ON "ServiceCall"("tableSessionId")
    WHERE "status" IN ('REQUESTED', 'ACKNOWLEDGED');

ALTER TABLE "ServiceCall" ADD CONSTRAINT "ServiceCall_tableSessionId_fkey"
    FOREIGN KEY ("tableSessionId") REFERENCES "TableSession"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "ServiceCall" ADD CONSTRAINT "ServiceCall_acknowledgedByUserId_fkey"
    FOREIGN KEY ("acknowledgedByUserId") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "ServiceCall" ADD CONSTRAINT "ServiceCall_resolvedByUserId_fkey"
    FOREIGN KEY ("resolvedByUserId") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;
