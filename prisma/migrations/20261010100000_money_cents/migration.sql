-- EN: Stop all writers before coordinated cutover. Old INTEGER values are whole EUR.
-- FI: Pysäytä kaikki kirjoittajat ennen yhteensovitettua käyttöönottoa. Vanhat INTEGER-arvot ovat kokonaisia euroja.
BEGIN;
LOCK TABLE "Food", "FoodSize", "BillSale", "BillSaleDetail", "Order", "OrderItem", "OrderItemModifier", "OrderRefund" IN ACCESS EXCLUSIVE MODE;
DO $$ BEGIN
  IF to_regclass('"MoneyStorage"') IS NOT NULL THEN
    RAISE EXCEPTION 'Money unit marker already exists; refusing a second conversion';
  END IF;
  IF (SELECT COUNT(*) FROM information_schema.columns WHERE table_schema = 'public' AND data_type = 'integer' AND (table_name, column_name) IN (('Food','price'),('FoodSize','moneyAdded'),('BillSale','amount'),('BillSale','inputMoney'),('BillSale','returnMoney'),('BillSaleDetail','price'),('BillSaleDetail','moneyAdded'),('Order','subtotal'),('Order','modifierTotal'),('Order','total'),('OrderItem','unitBasePrice'),('OrderItem','unitModifierTotal'),('OrderItem','unitTotal'),('OrderItem','lineTotal'),('OrderItemModifier','priceAdjustment'),('OrderRefund','amount'))) <> 16 THEN
    RAISE EXCEPTION 'Expected all sixteen legacy INTEGER EUR columns';
  END IF;
END $$;
ALTER TABLE "Food"
  ALTER COLUMN "price" TYPE BIGINT USING ("price"::bigint * 100);
ALTER TABLE "FoodSize"
  ALTER COLUMN "moneyAdded" TYPE BIGINT USING ("moneyAdded"::bigint * 100);
ALTER TABLE "BillSale"
  ALTER COLUMN "amount" TYPE BIGINT USING ("amount"::bigint * 100),
  ALTER COLUMN "inputMoney" TYPE BIGINT USING ("inputMoney"::bigint * 100),
  ALTER COLUMN "returnMoney" TYPE BIGINT USING ("returnMoney"::bigint * 100);
ALTER TABLE "BillSaleDetail"
  ALTER COLUMN "price" TYPE BIGINT USING ("price"::bigint * 100),
  ALTER COLUMN "moneyAdded" TYPE BIGINT USING ("moneyAdded"::bigint * 100);
ALTER TABLE "Order"
  ALTER COLUMN "subtotal" TYPE BIGINT USING ("subtotal"::bigint * 100),
  ALTER COLUMN "modifierTotal" TYPE BIGINT USING ("modifierTotal"::bigint * 100),
  ALTER COLUMN "total" TYPE BIGINT USING ("total"::bigint * 100);
ALTER TABLE "OrderItem"
  ALTER COLUMN "unitBasePrice" TYPE BIGINT USING ("unitBasePrice"::bigint * 100),
  ALTER COLUMN "unitModifierTotal" TYPE BIGINT USING ("unitModifierTotal"::bigint * 100),
  ALTER COLUMN "unitTotal" TYPE BIGINT USING ("unitTotal"::bigint * 100),
  ALTER COLUMN "lineTotal" TYPE BIGINT USING ("lineTotal"::bigint * 100);
ALTER TABLE "OrderItemModifier"
  ALTER COLUMN "priceAdjustment" TYPE BIGINT USING ("priceAdjustment"::bigint * 100);
ALTER TABLE "OrderRefund"
  ALTER COLUMN "amount" TYPE BIGINT USING ("amount"::bigint * 100);
CREATE TABLE "MoneyStorage" ("id" INTEGER PRIMARY KEY CHECK ("id" = 1), "unit" TEXT NOT NULL CHECK ("unit" = 'EUR_CENTS'), "version" INTEGER NOT NULL CHECK ("version" = 1));
INSERT INTO "MoneyStorage" ("id", "unit", "version") VALUES (1, 'EUR_CENTS', 1);
COMMIT;
