BEGIN;
SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '60s';
CREATE TABLE "OrderRefund" (
  "id" SERIAL PRIMARY KEY,
  "orderId" INTEGER NOT NULL UNIQUE,
  "billSaleId" INTEGER NOT NULL,
  "idempotencyKey" TEXT NOT NULL UNIQUE,
  "amount" INTEGER NOT NULL CHECK ("amount" >= 0),
  "method" TEXT NOT NULL CHECK ("method" IN ('cash', 'bank')),
  "status" TEXT NOT NULL DEFAULT 'PENDING' CHECK ("status" IN ('PENDING', 'FAILED', 'COMPLETED')),
  "reason" TEXT NOT NULL,
  "reference" TEXT,
  "failureReason" TEXT,
  "reservedByUserId" INTEGER NOT NULL,
  "confirmedByUserId" INTEGER,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "completedAt" TIMESTAMP(3),
  CONSTRAINT "OrderRefund_orderId_fkey" FOREIGN KEY ("orderId") REFERENCES "Order"("id") ON DELETE CASCADE ON UPDATE CASCADE,
  CONSTRAINT "OrderRefund_billSaleId_fkey" FOREIGN KEY ("billSaleId") REFERENCES "BillSale"("id") ON DELETE RESTRICT ON UPDATE CASCADE,
  CONSTRAINT "OrderRefund_completion_check" CHECK (("status" = 'COMPLETED') = ("completedAt" IS NOT NULL AND "reference" IS NOT NULL AND "confirmedByUserId" IS NOT NULL))
);
CREATE INDEX "OrderRefund_status_completedAt_idx" ON "OrderRefund"("status", "completedAt");
COMMIT;
