const { after, before, test } = require("node:test");
const assert = require("node:assert/strict");
const { randomUUID } = require("node:crypto");
const { once } = require("node:events");
const jwt = require("jsonwebtoken");
const { PrismaClient } = require("@prisma/client");
const { createTestFixture, cleanupTestFixture } = require("./helpers");

const prisma = new PrismaClient();
let apiBaseUrl;
let apiServer;
let admin;
let regularUser;
const categoryIds = [];
const foodIds = [];
let fixture;

// Coordinates headers for behavior for this module.
const headersFor = (user) => ({
  Authorization: `Bearer ${jwt.sign({ id: user.id, level: user.level }, process.env.SECRET_KEY, { expiresIn: "5m" })}`,
  "Content-Type": "application/json",
});

// Creates category with the current contract.
const createCategory = (body, user = admin) =>
  fetch(`${apiBaseUrl}/foodtype/create`, {
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
});

after(async () => {
  if (foodIds.length)
    await prisma.food.deleteMany({ where: { id: { in: foodIds } } });
  if (categoryIds.length)
    await prisma.foodType.deleteMany({ where: { id: { in: categoryIds } } });
  if (apiServer?.listening)
    await new Promise((resolve, reject) =>
      apiServer.close((error) => (error ? reject(error) : resolve())),
    );
  await prisma.$disconnect();
  await cleanupTestFixture(fixture);
});

test("food-type routes are admin-only and validate required fields", async () => {
  const [listResponse, createResponse, invalidResponse] = await Promise.all([
    fetch(`${apiBaseUrl}/foodType/list`, { headers: headersFor(regularUser) }),
    createCategory({ name: "Denied", remark: "" }, regularUser),
    createCategory({ name: "", remark: "" }),
  ]);
  assert.equal(listResponse.status, 403);
  assert.equal(createResponse.status, 403);
  assert.equal(invalidResponse.status, 400);
});

test("food types reject active duplicates and can be updated", async () => {
  const name = `WF07 ${randomUUID()}`;
  const createResponse = await createCategory({ name, remark: "Created" });
  assert.equal(createResponse.status, 201);
  const category = await prisma.foodType.findFirst({
    where: { name, status: "use" },
  });
  assert.ok(category);
  categoryIds.push(category.id);

  const duplicateResponse = await createCategory({ name, remark: "Duplicate" });
  assert.equal(duplicateResponse.status, 409);

  const updateResponse = await fetch(`${apiBaseUrl}/foodtype/update`, {
    method: "PUT",
    headers: headersFor(admin),
    body: JSON.stringify({
      id: category.id,
      name: `${name} Updated`,
      remark: "Updated",
    }),
  });
  assert.equal(updateResponse.status, 200);
  const updated = await prisma.foodType.findUnique({
    where: { id: category.id },
  });
  assert.deepEqual(
    { name: updated.name, remark: updated.remark },
    { name: `${name} Updated`, remark: "Updated" },
  );
});

test("a category with active dependencies cannot be removed", async () => {
  const name = `WF07 dependency ${randomUUID()}`;
  const createResponse = await createCategory({ name, remark: "" });
  assert.equal(createResponse.status, 201);
  const category = await prisma.foodType.findFirst({
    where: { name, status: "use" },
  });
  assert.ok(category);
  categoryIds.push(category.id);
  const food = await prisma.food.create({
    data: {
      foodTypeId: category.id,
      name: `WF07 food ${randomUUID()}`,
      remark: "",
      price: 1,
      img: "",
      foodType: "food",
      status: "use",
    },
  });
  foodIds.push(food.id);

  const blockedResponse = await fetch(
    `${apiBaseUrl}/foodtype/remove/${category.id}`,
    { method: "DELETE", headers: headersFor(admin) },
  );
  assert.equal(blockedResponse.status, 409);

  await prisma.food.delete({ where: { id: food.id } });
  foodIds.splice(foodIds.indexOf(food.id), 1);
  const removeResponse = await fetch(
    `${apiBaseUrl}/foodtype/remove/${category.id}`,
    { method: "DELETE", headers: headersFor(admin) },
  );
  assert.equal(removeResponse.status, 200);
  assert.equal(
    (await prisma.foodType.findUnique({ where: { id: category.id } })).status,
    "delete",
  );
});
