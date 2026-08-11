ALTER TABLE "BillSale"
ADD COLUMN "idempotencyKey" TEXT,
ADD COLUMN "checkoutFingerprint" TEXT;

ALTER TABLE "BillSaleDetail"
ADD COLUMN "foodName" TEXT,
ADD COLUMN "foodSizeName" TEXT,
ADD COLUMN "tasteName" TEXT;

UPDATE "BillSaleDetail" detail
SET
  "price" = COALESCE(detail."price", (SELECT food."price" FROM "Food" food WHERE food."id" = detail."foodId")),
  "moneyAdded" = COALESCE(detail."moneyAdded", 0),
  "foodName" = (SELECT food."name" FROM "Food" food WHERE food."id" = detail."foodId"),
  "foodSizeName" = (SELECT size."name" FROM "FoodSize" size WHERE size."id" = detail."foodSizeId"),
  "tasteName" = (SELECT taste."name" FROM "Taste" taste WHERE taste."id" = detail."tastedId");

ALTER TABLE "BillSaleDetail" ALTER COLUMN "price" SET NOT NULL;
ALTER TABLE "BillSaleDetail" ALTER COLUMN "moneyAdded" SET DEFAULT 0;
ALTER TABLE "BillSaleDetail" ALTER COLUMN "moneyAdded" SET NOT NULL;
ALTER TABLE "BillSaleDetail" ALTER COLUMN "foodName" SET NOT NULL;

CREATE UNIQUE INDEX "BillSale_userId_idempotencyKey_key"
ON "BillSale"("userId", "idempotencyKey");
