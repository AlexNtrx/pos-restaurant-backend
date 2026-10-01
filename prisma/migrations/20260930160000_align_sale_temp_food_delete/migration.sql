-- EN: foodId became required in 20260719193000, but its original SET NULL FK remained.
-- FI: foodId muuttui pakolliseksi migraatiossa 20260719193000, mutta SET NULL -viite jäi.
-- EN: Replace only the FK atomically; preserve rows and fail safely on locks or invalid data.
-- FI: Korvaa vain viite atomisesti; säilytä rivit ja keskeytä turvallisesti lukitus- tai datavirheessä.
BEGIN;
SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '60s';

ALTER TABLE "SaleTemp"
  DROP CONSTRAINT "SaleTemp_foodId_fkey",
  ADD CONSTRAINT "SaleTemp_foodId_fkey"
    FOREIGN KEY ("foodId") REFERENCES "Food"("id")
    ON DELETE RESTRICT ON UPDATE CASCADE;

COMMIT;
