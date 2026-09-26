-- Additive QR-01 state; existing open sessions remain usable without a token until staff rotates one.
CREATE TYPE "QrMode" AS ENUM ('DISABLED', 'MENU_ONLY', 'ORDERING');

CREATE TABLE "QrPolicy" (
    "id" INTEGER NOT NULL,
    "mode" "QrMode" NOT NULL DEFAULT 'DISABLED',
    "updatedAt" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "QrPolicy_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "QrPolicy_singleton" CHECK ("id" = 1)
);

ALTER TABLE "TableSession"
    ADD COLUMN "qrTokenHash" TEXT,
    ADD COLUMN "qrTokenExpiresAt" TIMESTAMP(3),
    ADD COLUMN "tokenVersion" INTEGER NOT NULL DEFAULT 0;

CREATE UNIQUE INDEX "TableSession_qrTokenHash_key" ON "TableSession"("qrTokenHash");

-- EN: Closed sessions cannot retain access; a token hash and expiry must appear together.
-- FI: Suljetut istunnot eivät voi säilyttää pääsyä; tunnisteen tiivisteen ja vanhenemisajan on oltava yhdessä.
ALTER TABLE "TableSession" ADD CONSTRAINT "TableSession_qr_access_state" CHECK (
    ("qrTokenHash" IS NULL AND "qrTokenExpiresAt" IS NULL)
    OR ("status" = 'OPEN' AND "qrTokenHash" IS NOT NULL AND "qrTokenExpiresAt" IS NOT NULL)
);

ALTER TABLE "TableSession" ADD CONSTRAINT "TableSession_token_version_nonnegative"
    CHECK ("tokenVersion" >= 0);
