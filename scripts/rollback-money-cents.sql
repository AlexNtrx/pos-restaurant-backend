-- EN: Offline rollback only before fractional writes. Stop every writer and restore matching legacy code/migration history before reopening.
-- FI: Offline-palautus vain ennen senttikirjoituksia. Pysäytä kaikki kirjoittajat ja palauta vastaava vanha koodi/migraatiohistoria ennen avaamista.
BEGIN;
LOCK TABLE "Food", "FoodSize", "BillSale", "BillSaleDetail", "Order", "OrderItem", "OrderItemModifier", "OrderRefund", "MoneyStorage" IN ACCESS EXCLUSIVE MODE;
DO $$
DECLARE
  item RECORD;
  invalid BOOLEAN;
  alterations TEXT;
BEGIN
  IF (SELECT COUNT(*) FROM "MoneyStorage" WHERE "id" = 1 AND "unit" = 'EUR_CENTS' AND "version" = 1) <> 1 THEN
    RAISE EXCEPTION 'Expected cents unit marker';
  END IF;
  FOR item IN SELECT * FROM (VALUES
    ('Food', 'price'), ('FoodSize', 'moneyAdded'),
    ('BillSale', 'amount'), ('BillSale', 'inputMoney'), ('BillSale', 'returnMoney'),
    ('BillSaleDetail', 'price'), ('BillSaleDetail', 'moneyAdded'),
    ('Order', 'subtotal'), ('Order', 'modifierTotal'), ('Order', 'total'),
    ('OrderItem', 'unitBasePrice'), ('OrderItem', 'unitModifierTotal'), ('OrderItem', 'unitTotal'), ('OrderItem', 'lineTotal'),
    ('OrderItemModifier', 'priceAdjustment'), ('OrderRefund', 'amount')
  ) AS fields(table_name, column_name) LOOP
    IF NOT EXISTS (SELECT 1 FROM information_schema.columns c WHERE c.table_schema = 'public'
      AND c.table_name = item.table_name AND c.column_name = item.column_name AND c.data_type = 'bigint') THEN
      RAISE EXCEPTION 'Expected sixteen BIGINT money columns';
    END IF;
    EXECUTE format('SELECT EXISTS (SELECT 1 FROM %I WHERE %I %% 100 <> 0 OR %I / 100 NOT BETWEEN -2147483648 AND 2147483647)',
      item.table_name, item.column_name, item.column_name) INTO invalid;
    IF invalid THEN
      RAISE EXCEPTION 'Rollback would lose cents or exceed INTEGER range: %.%', item.table_name, item.column_name;
    END IF;
  END LOOP;
  -- EN: Convert each model together so monetary equations remain valid throughout ALTER TABLE.
  -- FI: Muunna kunkin mallin kentät yhdessä, jotta rahayhtälöt säilyvät ALTER TABLE -operaation ajan.
  FOR item IN SELECT table_name, array_agg(column_name ORDER BY ordinal_position) AS columns
    FROM information_schema.columns WHERE table_schema = 'public' AND data_type = 'bigint'
      AND (table_name, column_name) IN (
        ('Food', 'price'), ('FoodSize', 'moneyAdded'),
        ('BillSale', 'amount'), ('BillSale', 'inputMoney'), ('BillSale', 'returnMoney'),
        ('BillSaleDetail', 'price'), ('BillSaleDetail', 'moneyAdded'),
        ('Order', 'subtotal'), ('Order', 'modifierTotal'), ('Order', 'total'),
        ('OrderItem', 'unitBasePrice'), ('OrderItem', 'unitModifierTotal'), ('OrderItem', 'unitTotal'), ('OrderItem', 'lineTotal'),
        ('OrderItemModifier', 'priceAdjustment'), ('OrderRefund', 'amount'))
    GROUP BY table_name LOOP
    SELECT string_agg(format('ALTER COLUMN %I TYPE INTEGER USING ((%I / 100)::integer)', name, name), ', ')
      INTO alterations FROM unnest(item.columns) AS name;
    EXECUTE format('ALTER TABLE %I %s', item.table_name, alterations);
  END LOOP;
END $$;
DROP TABLE "MoneyStorage";
COMMIT;
