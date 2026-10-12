-- EN: Add nullable demo metadata only; historical and unclassified records are not guessed or backfilled.
-- FI: Lisää vain valinnaiset demotiedot; vanhoja tai luokittelemattomia tietueita ei päätellä tai täytetä jälkikäteen.
BEGIN;
ALTER TABLE "Food" ADD COLUMN "taxCategory" TEXT;
ALTER TABLE "Food" ADD CONSTRAINT "Food_taxCategory_check" CHECK ("taxCategory" IN ('FOOD_NON_ALCOHOLIC', 'ALCOHOL'));
ALTER TABLE "OrderItem" ADD COLUMN "vatSnapshot" JSONB;
ALTER TABLE "BillSale" ADD COLUMN "vatSnapshot" JSONB;
ALTER TABLE "BillSaleDetail" ADD COLUMN "vatSnapshot" JSONB;
ALTER TABLE "OrderRefund" ADD COLUMN "vatSnapshot" JSONB;
COMMIT;
