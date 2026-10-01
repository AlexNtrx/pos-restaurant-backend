const { test, after } = require("node:test");
const assert = require("node:assert/strict");
const { prisma, createTestFixture, cleanupTestFixture } = require("./helpers");

after(() => prisma.$disconnect());

test("required cart Food reference restricts hard deletion and permits soft deletion", async () => {
  const fixture = await createTestFixture();
  let cart;
  try {
    // EN: A detail-free row isolates this FK from SaleTempDetail and historical receipt constraints.
    // FI: Rivi ilman lisätietoja eristää tämän viitteen SaleTempDetail- ja kuittirajoitteista.
    cart = await prisma.saleTemp.create({
      data: {
        userId: fixture.admin.id,
        tableNo: 987654,
        foodId: fixture.food.id,
        qty: 1,
      },
    });
    const [constraint] = await prisma.$queryRaw`
      SELECT confdeltype::text AS "deleteAction", convalidated AS validated
      FROM pg_constraint
      WHERE conrelid = '"SaleTemp"'::regclass AND conname = 'SaleTemp_foodId_fkey'
    `;
    assert.deepEqual(constraint, { deleteAction: "r", validated: true });
    await assert.rejects(
      prisma.food.delete({ where: { id: fixture.food.id } }),
      (error) =>
        /SaleTemp_foodId_fkey/.test(error.message) &&
        (error.code === "P2003" || /23001/.test(error.message)),
    );
    assert.deepEqual(
      await prisma.saleTemp.findUnique({ where: { id: cart.id } }),
      cart,
    );
    await prisma.food.update({
      where: { id: fixture.food.id },
      data: { status: "delete" },
    });
    assert.deepEqual(
      await prisma.saleTemp.findUnique({ where: { id: cart.id } }),
      cart,
    );
  } finally {
    if (cart) await prisma.saleTemp.delete({ where: { id: cart.id } });
    await cleanupTestFixture(fixture);
  }
});
