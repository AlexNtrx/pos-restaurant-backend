const { after, before, test } = require("node:test");
const assert = require("node:assert/strict");
const { randomUUID } = require("node:crypto");
const { once } = require("node:events");
const jwt = require("jsonwebtoken");
const { PrismaClient } = require("@prisma/client");
const { createTestFixture, cleanupTestFixture } = require("./helpers");

const prisma = new PrismaClient();
let apiBaseUrl;
let admin;
let regularUser;
let category;
let food;
let apiServer;
const sizeIds = [];
const cartIds = [];
const detailIds = [];
let fixture;

// Coordinates headers for behavior for this module.
const headersFor = (user) => ({
  Authorization: `Bearer ${jwt.sign({ id: user.id, level: user.level }, process.env.SECRET_KEY, { expiresIn: "5m" })}`,
  "Content-Type": "application/json",
});
// Creates size with the current contract.
const createSize = (body, user = admin) =>
  fetch(`${apiBaseUrl}/foodSize/create`, {
    method: "POST",
    headers: headersFor(user),
    body: JSON.stringify(body),
  });

before(async () => {
  const { app } = require("../server");
  apiServer = app.listen(0, "127.0.0.1");
  if (!apiServer.listening) await once(apiServer, "listening");
  apiBaseUrl = `http://127.0.0.1:${apiServer.address().port}/api`;
  fixture = await createTestFixture();
  admin = fixture.admin;
  regularUser = fixture.user;
  food = fixture.food;
  category = fixture.category;
});

after(async () => {
  if (detailIds.length)
    await prisma.saleTempDetail.deleteMany({
      where: { id: { in: detailIds } },
    });
  if (cartIds.length)
    await prisma.saleTemp.deleteMany({ where: { id: { in: cartIds } } });
  if (sizeIds.length)
    await prisma.foodSize.deleteMany({ where: { id: { in: sizeIds } } });
  if (apiServer?.listening)
    await new Promise((resolve, reject) =>
      apiServer.close((error) => (error ? reject(error) : resolve())),
    );
  await prisma.$disconnect();
  await cleanupTestFixture(fixture);
});

test("food-size routes are admin-only and validate prices", async () => {
  const [listResponse, createResponse, invalidResponse] = await Promise.all([
    fetch(`${apiBaseUrl}/foodSize/list`, { headers: headersFor(regularUser) }),
    createSize(
      { foodTypeId: category.id, name: "Denied", remark: "", moneyAdded: 0 },
      regularUser,
    ),
    createSize({
      foodTypeId: category.id,
      name: "Invalid",
      remark: "",
      moneyAdded: -1,
    }),
  ]);
  assert.equal(listResponse.status, 403);
  assert.equal(createResponse.status, 403);
  assert.equal(invalidResponse.status, 400);
});

test("food sizes reject active duplicates and preserve complete edit fields", async () => {
  const name = `WF08 ${randomUUID()}`;
  const createResponse = await createSize({
    foodTypeId: category.id,
    name,
    remark: "Created",
    moneyAdded: 5,
  });
  assert.equal(createResponse.status, 201);
  const size = await prisma.foodSize.findFirst({
    where: { foodTypeId: category.id, name, status: "use" },
  });
  assert.ok(size);
  sizeIds.push(size.id);
  const duplicateResponse = await createSize({
    foodTypeId: category.id,
    name,
    remark: "",
    moneyAdded: 0,
  });
  assert.equal(duplicateResponse.status, 409);
  const updateResponse = await fetch(`${apiBaseUrl}/foodSize/update`, {
    method: "PUT",
    headers: headersFor(admin),
    body: JSON.stringify({
      id: size.id,
      foodTypeId: category.id,
      name,
      remark: "Updated",
      moneyAdded: 9,
    }),
  });
  assert.equal(updateResponse.status, 200);
  const updated = await prisma.foodSize.findUnique({ where: { id: size.id } });
  assert.deepEqual(
    {
      foodTypeId: updated.foodTypeId,
      remark: updated.remark,
      moneyAdded: updated.moneyAdded,
    },
    { foodTypeId: category.id, remark: "Updated", moneyAdded: 9 },
  );
});

test("a size selected in a cart cannot be removed", async () => {
  const name = `WF08 cart ${randomUUID()}`;
  const createResponse = await createSize({
    foodTypeId: category.id,
    name,
    remark: "",
    moneyAdded: 1,
  });
  assert.equal(createResponse.status, 201);
  const size = await prisma.foodSize.findFirst({
    where: { foodTypeId: category.id, name, status: "use" },
  });
  assert.ok(size);
  sizeIds.push(size.id);
  const tableNo = 800000000 + (Date.now() % 100000000);
  const cart = await prisma.saleTemp.create({
    data: { userId: admin.id, tableNo, foodId: food.id, qty: 1 },
  });
  cartIds.push(cart.id);
  const detail = await prisma.saleTempDetail.create({
    data: { saleTempId: cart.id, foodId: food.id, foodSizeId: size.id },
  });
  detailIds.push(detail.id);
  const blockedResponse = await fetch(
    `${apiBaseUrl}/foodSize/remove/${size.id}`,
    { method: "DELETE", headers: headersFor(admin) },
  );
  assert.equal(blockedResponse.status, 409);
  await prisma.saleTempDetail.delete({ where: { id: detail.id } });
  detailIds.splice(detailIds.indexOf(detail.id), 1);
  await prisma.saleTemp.delete({ where: { id: cart.id } });
  cartIds.splice(cartIds.indexOf(cart.id), 1);
  const removeResponse = await fetch(
    `${apiBaseUrl}/foodSize/remove/${size.id}`,
    { method: "DELETE", headers: headersFor(admin) },
  );
  assert.equal(removeResponse.status, 200);
  assert.equal(
    (await prisma.foodSize.findUnique({ where: { id: size.id } })).status,
    "delete",
  );
});
