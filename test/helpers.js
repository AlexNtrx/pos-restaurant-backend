const { once } = require("node:events");
const { randomUUID } = require("node:crypto");
const jwt = require("jsonwebtoken");
const { PrismaClient } = require("@prisma/client");
const { hashPassword } = require("../lib/password");

const prisma = new PrismaClient();

// Coordinates start api server behavior for this module.
const startApiServer = async () => {
  const { app } = require("../server");
  const server = app.listen(0, "127.0.0.1");
  if (!server.listening) await once(server, "listening");
  const origin = `http://127.0.0.1:${server.address().port}`;
  return { server, origin, apiBaseUrl: `${origin}/api` };
};

// Coordinates stop api server behavior for this module.
const stopApiServer = async (server) => {
  if (!server?.listening) return;
  await new Promise((resolve, reject) =>
    server.close((error) => (error ? reject(error) : resolve())),
  );
};

// Coordinates sign token behavior for this module.
const signToken = (user, expiresIn = "5m") =>
  jwt.sign(
    { id: user.id, name: "test-user", level: user.level },
    process.env.SECRET_KEY,
    { expiresIn },
  );

// Coordinates bearer behavior for this module.
const bearer = (token) => ({ Authorization: `Bearer ${token}` });

// Coordinates headers for behavior for this module.
const headersFor = (user) => ({
  ...bearer(signToken(user)),
  "Content-Type": "application/json",
});

// Creates test fixture with the current contract.
const createTestFixture = async () => {
  const marker = `test-${randomUUID()}`;
  const password = await hashPassword("test-password-1");
  const [admin, user] = await Promise.all([
    prisma.user.create({
      data: {
        name: `${marker}-admin`,
        username: `${marker}-admin`,
        password,
        level: "admin",
        status: "use",
      },
    }),
    prisma.user.create({
      data: {
        name: `${marker}-user`,
        username: `${marker}-user`,
        password,
        level: "user",
        status: "use",
      },
    }),
  ]);
  const category = await prisma.foodType.create({
    data: { name: `${marker}-category`, remark: "", status: "use" },
  });
  const otherCategory = await prisma.foodType.create({
    data: { name: `${marker}-other-category`, remark: "", status: "use" },
  });
  const [size, inactiveSize, taste, inactiveTaste, food] = await Promise.all([
    prisma.foodSize.create({
      data: {
        name: `${marker}-size`,
        remark: "",
        moneyAdded: 5,
        foodTypeId: category.id,
        status: "use",
      },
    }),
    prisma.foodSize.create({
      data: {
        name: `${marker}-inactive-size`,
        remark: "",
        moneyAdded: 9,
        foodTypeId: otherCategory.id,
        status: "delete",
      },
    }),
    prisma.taste.create({
      data: {
        name: `${marker}-taste`,
        remark: "",
        foodTypeId: category.id,
        status: "use",
      },
    }),
    prisma.taste.create({
      data: {
        name: `${marker}-inactive-taste`,
        remark: "",
        foodTypeId: otherCategory.id,
        status: "delete",
      },
    }),
    prisma.food.create({
      data: {
        name: `${marker}-food`,
        remark: "",
        price: 20,
        img: "",
        foodType: "food",
        foodTypeId: category.id,
        status: "use",
      },
    }),
  ]);
  return {
    marker,
    admin,
    user,
    category,
    otherCategory,
    size,
    inactiveSize,
    taste,
    inactiveTaste,
    food,
  };
};

// Manages cleanup test fixture while preserving cleanup behavior.
const cleanupTestFixture = async (fixture) => {
  if (!fixture) return;
  const userIds = [fixture.admin.id, fixture.user.id];
  const foodIds = [fixture.food.id];
  const categoryIds = [fixture.category.id, fixture.otherCategory.id];
  await prisma.$transaction(async (tx) => {
    // EN: Orders reference users, foods, and bills, so aggregate cleanup must run before legacy fixtures.
    // FI: Tilaukset viittaavat käyttäjiin, ruokiin ja laskuihin, joten aggregaatit poistetaan ennen vanhoja testitietoja.
    await tx.order.deleteMany({
      where: {
        OR: [
          { createdByUserId: { in: userIds } },
          { Items: { some: { foodId: { in: foodIds } } } },
        ],
      },
    });
    await tx.billSaleDetail.deleteMany({
      where: {
        OR: [
          { Food: { id: { in: foodIds } } },
          { BillSale: { userId: { in: userIds } } },
        ],
      },
    });
    await tx.billSale.deleteMany({ where: { userId: { in: userIds } } });
    await tx.saleTempDetail.deleteMany({
      where: {
        OR: [
          { Food: { id: { in: foodIds } } },
          { SaleTemp: { userId: { in: userIds } } },
        ],
      },
    });
    await tx.saleTemp.deleteMany({
      where: { OR: [{ userId: { in: userIds } }, { foodId: { in: foodIds } }] },
    });
    await tx.food.deleteMany({ where: { foodTypeId: { in: categoryIds } } });
    await tx.taste.deleteMany({ where: { foodTypeId: { in: categoryIds } } });
    await tx.foodSize.deleteMany({
      where: { foodTypeId: { in: categoryIds } },
    });
    await tx.foodType.deleteMany({ where: { id: { in: categoryIds } } });
    await tx.user.deleteMany({ where: { id: { in: userIds } } });
  });
};

// Coordinates begin organization fixture behavior for this module.
const beginOrganizationFixture = async () => {
  const original = await prisma.organization.findFirst({
    orderBy: { id: "asc" },
  });
  if (original)
    await prisma.organization.delete({ where: { id: original.id } });
  const marker = `test-${randomUUID()}`;
  const organization = await prisma.organization.create({
    data: {
      name: `${marker}-organization`,
      address: "Test address",
      phone: "123",
      email: "",
      website: "",
      bankNo: "",
      logo: "",
      taxCode: "TEST",
    },
  });
  return { organization, original };
};

// Coordinates restore organization fixture behavior for this module.
const restoreOrganizationFixture = async (fixture) => {
  if (!fixture) return;
  await prisma.organization
    .delete({ where: { id: fixture.organization.id } })
    .catch(() => undefined);
  if (fixture.original)
    await prisma.organization.create({ data: fixture.original });
};

module.exports = {
  prisma,
  startApiServer,
  stopApiServer,
  signToken,
  bearer,
  headersFor,
  createTestFixture,
  cleanupTestFixture,
  beginOrganizationFixture,
  restoreOrganizationFixture,
};
