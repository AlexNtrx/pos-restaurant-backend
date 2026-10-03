const { after, test } = require("node:test");
const assert = require("node:assert/strict");
const { readFileSync } = require("node:fs");
const path = require("node:path");
const { randomUUID } = require("node:crypto");
const { prisma } = require("./helpers");

after(() => prisma.$disconnect());

test("kassa migration preserves users, bills and order history and can be replayed", async () => {
  const migration = readFileSync(
    path.join(
      __dirname,
      "../prisma/migrations/20261002200000_kassa_role/migration.sql",
    ),
    "utf8",
  );
  // EN: Execute the reviewed migration body inside a rolled-back test transaction; do not change migration tracking.
  // FI: Suorita tarkistettu migraation sisältö peruttavassa testitransaktiossa muuttamatta migraatioiden seurantaa.
  const statements = migration
    .split(";")
    .map((statement) => statement.replace(/^--.*$/gm, "").trim())
    .filter(
      (statement) => statement && !["BEGIN", "COMMIT"].includes(statement),
    );
  const rollback = new Error("Rollback disposable migration fixture");
  await assert.rejects(
    prisma.$transaction(async (tx) => {
      const marker = `migration-${randomUUID()}`;
      const user = await tx.user.create({
        data: {
          name: marker,
          username: marker,
          password: "disposable-migration-fixture",
          level: "user",
        },
      });
      const bill = await tx.billSale.create({
        data: {
          userId: user.id,
          serviceType: "TAKEAWAY",
          amount: 20,
          payType: "bank",
          inputMoney: 20,
          returnMoney: 0,
        },
      });
      const order = await tx.order.create({
        data: {
          channel: "COUNTER",
          serviceType: "TAKEAWAY",
          createdByUserId: user.id,
          subtotal: 20,
          modifierTotal: 0,
          total: 20,
          idempotencyScope: marker,
          idempotencyKey: randomUUID(),
          idempotencyFingerprint: "0".repeat(64),
        },
      });
      const history = await tx.orderStatusHistory.create({
        data: {
          orderId: order.id,
          toStatus: order.status,
          version: order.version,
          actorType: "STAFF",
          actorUserId: user.id,
        },
      });
      for (let replay = 0; replay < 2; replay++) {
        for (const statement of statements)
          await tx.$executeRawUnsafe(statement);
        assert.deepEqual(
          await tx.user.findUniqueOrThrow({ where: { id: user.id } }),
          { ...user, level: "kassa" },
        );
        assert.deepEqual(
          await tx.billSale.findUniqueOrThrow({ where: { id: bill.id } }),
          bill,
        );
        assert.deepEqual(
          await tx.order.findUniqueOrThrow({ where: { id: order.id } }),
          order,
        );
        assert.deepEqual(
          await tx.orderStatusHistory.findUniqueOrThrow({
            where: { id: history.id },
          }),
          history,
        );
      }
      throw rollback;
    }),
    (error) => error === rollback,
  );
});
