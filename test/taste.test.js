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
let food;
let category;
const tasteIds = [];
const cartIds = [];
const detailIds = [];
let fixture;
// Coordinates headers for behavior for this module.
const headersFor = (user) => ({
  Authorization: `Bearer ${jwt.sign({ id: user.id, level: user.level }, process.env.SECRET_KEY, { expiresIn: "5m" })}`,
  "Content-Type": "application/json",
});
// Creates taste with the current contract.
const createTaste = (body, user = admin) =>
  fetch(`${apiBaseUrl}/taste/create`, {
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
  if (tasteIds.length)
    await prisma.taste.deleteMany({ where: { id: { in: tasteIds } } });
  if (apiServer?.listening)
    await new Promise((resolve, reject) =>
      apiServer.close((error) => (error ? reject(error) : resolve())),
    );
  await prisma.$disconnect();
  await cleanupTestFixture(fixture);
});

test("taste routes are admin-only and validate category fields", async () => {
  const [listResponse, createResponse, invalidResponse] = await Promise.all([
    fetch(`${apiBaseUrl}/taste/list`, { headers: headersFor(regularUser) }),
    createTaste(
      { foodTypeId: category.id, name: "Denied", remark: "" },
      regularUser,
    ),
    createTaste({ foodTypeId: category.id, name: "", remark: "" }),
  ]);
  assert.equal(listResponse.status, 403);
  assert.equal(createResponse.status, 403);
  assert.equal(invalidResponse.status, 400);
});

test("tastes reject active duplicates and update complete fields", async () => {
  const name = `WF09 ${randomUUID()}`;
  const createResponse = await createTaste({
    foodTypeId: category.id,
    name,
    remark: "Created",
  });
  assert.equal(createResponse.status, 201);
  const taste = await prisma.taste.findFirst({
    where: { foodTypeId: category.id, name, status: "use" },
  });
  assert.ok(taste);
  tasteIds.push(taste.id);
  const duplicateResponse = await createTaste({
    foodTypeId: category.id,
    name,
    remark: "",
  });
  assert.equal(duplicateResponse.status, 409);
  const updateResponse = await fetch(`${apiBaseUrl}/taste/update`, {
    method: "PUT",
    headers: headersFor(admin),
    body: JSON.stringify({
      id: taste.id,
      foodTypeId: category.id,
      name,
      remark: "Updated",
    }),
  });
  assert.equal(updateResponse.status, 200);
  assert.equal(
    (await prisma.taste.findUnique({ where: { id: taste.id } })).remark,
    "Updated",
  );
});

test("a taste selected in a cart cannot be removed", async () => {
  const name = `WF09 cart ${randomUUID()}`;
  const createResponse = await createTaste({
    foodTypeId: category.id,
    name,
    remark: "",
  });
  assert.equal(createResponse.status, 201);
  const taste = await prisma.taste.findFirst({
    where: { foodTypeId: category.id, name, status: "use" },
  });
  assert.ok(taste);
  tasteIds.push(taste.id);
  const cart = await prisma.saleTemp.create({
    data: {
      userId: admin.id,
      tableNo: 870000000 + (Date.now() % 100000000),
      foodId: food.id,
      qty: 1,
    },
  });
  cartIds.push(cart.id);
  const detail = await prisma.saleTempDetail.create({
    data: { saleTempId: cart.id, foodId: food.id, tasteId: taste.id },
  });
  detailIds.push(detail.id);
  const blockedResponse = await fetch(
    `${apiBaseUrl}/taste/remove/${taste.id}`,
    { method: "DELETE", headers: headersFor(admin) },
  );
  assert.equal(blockedResponse.status, 409);
  await prisma.saleTempDetail.delete({ where: { id: detail.id } });
  detailIds.splice(detailIds.indexOf(detail.id), 1);
  await prisma.saleTemp.delete({ where: { id: cart.id } });
  cartIds.splice(cartIds.indexOf(cart.id), 1);
  const removeResponse = await fetch(`${apiBaseUrl}/taste/remove/${taste.id}`, {
    method: "DELETE",
    headers: headersFor(admin),
  });
  assert.equal(removeResponse.status, 200);
  assert.equal(
    (await prisma.taste.findUnique({ where: { id: taste.id } })).status,
    "delete",
  );
});
