ALTER TABLE "BillSale"
  ADD COLUMN "cancelledAt" TIMESTAMP(3),
  ADD COLUMN "cancelledByUserId" INTEGER,
  ADD COLUMN "cancelReason" TEXT;

ALTER TABLE "BillSale"
  ADD CONSTRAINT "BillSale_cancelledByUserId_fkey"
  FOREIGN KEY ("cancelledByUserId") REFERENCES "User"("id")
  ON DELETE SET NULL ON UPDATE CASCADE;

-- Preserve legacy cancellations without inventing an actor, time, or reason.
UPDATE "BillSale" SET "status" = 'cancelled' WHERE "status" = 'delete';

CREATE INDEX "BillSale_payDate_status_idx" ON "BillSale"("payDate", "status");
