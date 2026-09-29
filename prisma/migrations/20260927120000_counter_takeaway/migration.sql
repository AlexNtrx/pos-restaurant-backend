CREATE TYPE "ServiceType" AS ENUM ('DINE_IN', 'TAKEAWAY');

ALTER TABLE "Order"
  ADD COLUMN "serviceType" "ServiceType" NOT NULL DEFAULT 'DINE_IN',
  ALTER COLUMN "tableNo" DROP NOT NULL;

ALTER TABLE "BillSale"
  ADD COLUMN "serviceType" "ServiceType" NOT NULL DEFAULT 'DINE_IN',
  ALTER COLUMN "tableNo" DROP NOT NULL;

-- EN: A takeaway has no physical table or QR session; historical rows retain their dine-in location.
-- FI: Noutotilauksella ei ole fyysistä pöytää tai QR-istuntoa; vanhat rivit säilyttävät pöytätietonsa.
ALTER TABLE "Order" ADD CONSTRAINT "Order_service_location_check"
  CHECK (
    ("serviceType" = 'DINE_IN' AND "tableNo" IS NOT NULL) OR
    ("serviceType" = 'TAKEAWAY' AND "tableNo" IS NULL AND "tableSessionId" IS NULL AND "restaurantTableId" IS NULL AND "channel" = 'COUNTER')
  );

ALTER TABLE "BillSale" ADD CONSTRAINT "BillSale_service_location_check"
  CHECK (
    ("serviceType" = 'DINE_IN' AND "tableNo" IS NOT NULL) OR
    ("serviceType" = 'TAKEAWAY' AND "tableNo" IS NULL AND "tableSessionId" IS NULL)
  );
