const { test } = require("node:test");
const assert = require("node:assert/strict");
const { randomUUID } = require("node:crypto");
const fs = require("node:fs");
const path = require("node:path");
const { spawnSync } = require("node:child_process");
const { PrismaClient } = require("@prisma/client");
const { getDatabaseUrls } = require("./database-env");
const { assertMoneyStorage } = require("../lib/money-storage");

const fields = {
  Food: ["price"],
  FoodSize: ["moneyAdded"],
  BillSale: ["amount", "inputMoney", "returnMoney"],
  BillSaleDetail: ["price", "moneyAdded"],
  Order: ["subtotal", "modifierTotal", "total"],
  OrderItem: ["unitBasePrice", "unitModifierTotal", "unitTotal", "lineTotal"],
  OrderItemModifier: ["priceAdjustment"],
  OrderRefund: ["amount"],
};
const migrationName = "20261010100000_money_cents";

test("isolated legacy migration preserves all 16 fields and identity; refuses double conversion and lossy rollback", async () => {
  const { testUrl } = getDatabaseUrls();
  // EN: Create a uniquely named loopback disposable database; never reset the configured test/development database.
  // FI: Luo yksilöllisesti nimetty paikallinen kertakäyttötietokanta; älä nollaa määritettyä testi- tai kehitystietokantaa.
  const name = `db_next_workshop_pos_test_money_${randomUUID().replaceAll("-", "").slice(0, 24)}`;
  const url = new URL(testUrl);
  url.pathname = `/${name}`;
  const admin = new PrismaClient({ datasourceUrl: testUrl.toString() });
  const db = new PrismaClient({ datasourceUrl: url.toString() });
  let created = false;
  const psql =
    process.env.TEST_PSQL_PATH ||
    (process.platform === "win32"
      ? "C:/Program Files/PostgreSQL/18/bin/psql.exe"
      : "psql");
  const sql = (input, success = true) => {
    const result = spawnSync(
      psql,
      [
        "-X",
        "-v",
        "ON_ERROR_STOP=1",
        "-h",
        url.hostname,
        "-p",
        url.port || "5432",
        "-U",
        decodeURIComponent(url.username),
        "-d",
        name,
      ],
      {
        input,
        encoding: "utf8",
        env: { ...process.env, PGPASSWORD: decodeURIComponent(url.password) },
      },
    );
    if (result.error) throw result.error;
    if (success) assert.equal(result.status, 0, result.stderr);
    else
      assert.notEqual(
        result.status,
        0,
        "Unsafe conversion unexpectedly succeeded",
      );
    return result.stderr;
  };
  const snapshot = async () => {
    const result = {};
    for (const table of Object.keys(fields))
      result[table] = await db.$queryRawUnsafe(
        `SELECT * FROM "${table}" ORDER BY id`,
      );
    return result;
  };
  try {
    await admin.$executeRawUnsafe(`CREATE DATABASE "${name}"`);
    created = true;
    assert.equal(
      (await db.$queryRawUnsafe("SELECT current_database() AS name"))[0].name,
      name,
    );
    const root = path.resolve("prisma/migrations");
    for (const migration of fs
      .readdirSync(root)
      .filter(
        (item) =>
          item < migrationName &&
          fs.statSync(path.join(root, item)).isDirectory(),
      )
      .sort())
      sql(fs.readFileSync(path.join(root, migration, "migration.sql"), "utf8"));
    await assert.rejects(assertMoneyStorage(db));
    sql(`INSERT INTO "User" (id,name,username,password) VALUES (1,'Synthetic','Synthetic','unused');
      INSERT INTO "FoodType" (id,name,remark) VALUES (1,'Synthetic','');
      INSERT INTO "Food" (id,name,img,remark,price,"foodTypeId") VALUES (1,'Synthetic','','',2147483647,1);
      INSERT INTO "FoodSize" (id,name,remark,"moneyAdded","foodTypeId") VALUES (1,'Synthetic','',2,1);
      INSERT INTO "BillSale" (id,amount,"inputMoney","returnMoney","payType","userId","idempotencyKey","checkoutFingerprint","tableNo") VALUES (1,13,20,7,'cash',1,'old-key','opaque-old-hash',1);
      INSERT INTO "BillSaleDetail" (id,"billSaleId","foodId","foodSizeId",price,"moneyAdded","foodName") VALUES (1,1,1,1,11,2,'Synthetic');
      INSERT INTO "Order" (id,channel,status,subtotal,"modifierTotal",total,"idempotencyScope","idempotencyKey","idempotencyFingerprint","updatedAt","billSaleId","tableNo") VALUES (1,'COUNTER','PAID',11,2,13,'old-scope','old-key',repeat('a',64),CURRENT_TIMESTAMP,1,1);
      INSERT INTO "OrderItem" (id,"orderId","foodId","foodName",quantity,"unitBasePrice","unitModifierTotal","unitTotal","lineTotal") VALUES (1,1,1,'Synthetic',1,11,2,13,13);
      INSERT INTO "OrderItemModifier" (id,"orderItemId",type,"foodSizeId",name,"priceAdjustment") VALUES (1,1,'SIZE',1,'Synthetic',2);
      INSERT INTO "OrderRefund" (id,"orderId","billSaleId","idempotencyKey",amount,method,reason,"reservedByUserId") VALUES (1,1,1,'old-refund-key',13,'cash','Synthetic',1);`);
    const before = await snapshot();
    const centsSql = fs.readFileSync(
      path.join(root, migrationName, "migration.sql"),
      "utf8",
    );
    const rollback = fs.readFileSync(
      path.resolve("scripts/rollback-money-cents.sql"),
      "utf8",
    );
    sql(centsSql);
    await db.$disconnect();
    await assertMoneyStorage(db);
    const after = await snapshot();
    for (const [table, columns] of Object.entries(fields)) {
      assert.equal(after[table].length, before[table].length);
      for (let i = 0; i < before[table].length; i++) {
        const expected = { ...before[table][i] };
        for (const field of columns)
          expected[field] = BigInt(expected[field]) * 100n;
        assert.deepEqual(after[table][i], expected);
      }
    }
    assert.match(sql(centsSql, false), /already exists/);
    assert.deepEqual(await snapshot(), after);
    sql('UPDATE "FoodSize" SET "moneyAdded" = 201 WHERE id = 1;');
    const fractional = await snapshot();
    assert.match(sql(rollback, false), /would lose cents/);
    assert.deepEqual(await snapshot(), fractional);
    await assertMoneyStorage(db);
    sql('UPDATE "FoodSize" SET "moneyAdded" = 200 WHERE id = 1;');
    sql('UPDATE "Food" SET "price" = 214748364800 WHERE id = 1;');
    assert.match(sql(rollback, false), /exceed INTEGER range/);
    sql('UPDATE "Food" SET "price" = 214748364700 WHERE id = 1;');
    sql(rollback);
    await db.$disconnect();
    assert.deepEqual(await snapshot(), before);
    await assert.rejects(assertMoneyStorage(db));
    sql(centsSql);
    await db.$disconnect();
    assert.deepEqual(await snapshot(), after);
  } finally {
    await db.$disconnect();
    if (created) await admin.$executeRawUnsafe(`DROP DATABASE "${name}"`);
    await admin.$disconnect();
  }
});
