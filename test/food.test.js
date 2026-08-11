const { after, before, test } = require("node:test");
const assert = require("node:assert/strict");
const { randomUUID } = require("node:crypto");
const { once } = require("node:events");
const fs = require("node:fs/promises");
const path = require("node:path");
const jwt = require("jsonwebtoken");
const { PrismaClient } = require("@prisma/client");
const { createTestFixture, cleanupTestFixture } = require("./helpers");

const prisma = new PrismaClient();
let apiBaseUrl;
let apiServer;
let admin;
let regularUser;
let category;
const foodIds = [];
const uploadedFiles = [];
let fixture;

// Coordinates headers for behavior for this module.
const headersFor = (user) => ({
  Authorization: `Bearer ${jwt.sign({ id: user.id, level: user.level }, process.env.SECRET_KEY, { expiresIn: "5m" })}`,
  "Content-Type": "application/json",
});

// Creates food with the current contract.
const createFood = (body, user = admin) =>
  fetch(`${apiBaseUrl}/food/create`, {
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
  category = fixture.category;
});

after(async () => {
  if (foodIds.length)
    await prisma.food.deleteMany({ where: { id: { in: foodIds } } });
  await Promise.all(
    uploadedFiles.map((fileName) =>
      fs
        .unlink(path.join(process.cwd(), "uploads", fileName))
        .catch(() => undefined),
    ),
  );
  if (apiServer?.listening)
    await new Promise((resolve, reject) =>
      apiServer.close((error) => (error ? reject(error) : resolve())),
    );
  await prisma.$disconnect();
  await cleanupTestFixture(fixture);
});

test("food-management routes are admin-only and reject invalid pagination", async () => {
  const [listResponse, paginateResponse, createResponse, invalidPagination] =
    await Promise.all([
      fetch(`${apiBaseUrl}/food/list`, { headers: headersFor(regularUser) }),
      fetch(`${apiBaseUrl}/food/paginate`, {
        method: "POST",
        headers: headersFor(regularUser),
        body: JSON.stringify({ page: 1, itemsPerPage: 10 }),
      }),
      createFood({}, regularUser),
      fetch(`${apiBaseUrl}/food/paginate`, {
        method: "POST",
        headers: headersFor(admin),
        body: JSON.stringify({ page: 0, itemsPerPage: 101 }),
      }),
    ]);
  assert.equal(listResponse.status, 403);
  assert.equal(paginateResponse.status, 403);
  assert.equal(createResponse.status, 403);
  assert.equal(invalidPagination.status, 400);
});

test("food CRUD validates active category and preserves the requested image name", async () => {
  const name = `WF06 ${randomUUID()}`;
  const invalidResponse = await createFood({
    foodTypeId: category.id,
    name,
    remark: "",
    price: -1,
    img: "",
    foodType: "food",
  });
  assert.equal(invalidResponse.status, 400);

  const createResponse = await createFood({
    foodTypeId: category.id,
    name,
    remark: "Created",
    price: 25,
    img: "",
    foodType: "food",
  });
  assert.equal(createResponse.status, 201);
  const created = await prisma.food.findFirst({
    where: { name, status: "use" },
  });
  assert.ok(created);
  foodIds.push(created.id);

  const updateResponse = await fetch(`${apiBaseUrl}/food/update`, {
    method: "PUT",
    headers: headersFor(admin),
    body: JSON.stringify({
      id: created.id,
      foodTypeId: category.id,
      name,
      remark: "Updated",
      price: 30,
      img: "",
      foodType: "drink",
    }),
  });
  assert.equal(updateResponse.status, 200);
  const updated = await prisma.food.findUnique({ where: { id: created.id } });
  assert.deepEqual(
    {
      remark: updated.remark,
      price: updated.price,
      img: updated.img,
      foodType: updated.foodType,
    },
    { remark: "Updated", price: 30, img: "", foodType: "drink" },
  );

  const listResponse = await fetch(`${apiBaseUrl}/food/list`, {
    headers: headersFor(admin),
  });
  const list = await listResponse.json();
  assert.equal(listResponse.status, 200);
  assert.ok(
    list.results.some(
      (food) => food.id === created.id && food.FoodType?.id === category.id,
    ),
  );

  const deleteResponse = await fetch(
    `${apiBaseUrl}/food/remove/${created.id}`,
    { method: "DELETE", headers: headersFor(admin) },
  );
  assert.equal(deleteResponse.status, 200);
  assert.equal(
    (await prisma.food.findUnique({ where: { id: created.id } })).status,
    "delete",
  );
});

test("image upload requires one supported image and pagination returns a typed page", async () => {
  const noFileResponse = await fetch(`${apiBaseUrl}/food/upload`, {
    method: "POST",
    headers: { Authorization: headersFor(admin).Authorization },
  });
  assert.equal(noFileResponse.status, 400);

  const invalidForm = new FormData();
  invalidForm.append(
    "file",
    new Blob(["not an image"], { type: "text/plain" }),
    "bad.txt",
  );
  const invalidResponse = await fetch(`${apiBaseUrl}/food/upload`, {
    method: "POST",
    headers: { Authorization: headersFor(admin).Authorization },
    body: invalidForm,
  });
  assert.equal(invalidResponse.status, 400);

  const spoofedForm = new FormData();
  spoofedForm.append(
    "file",
    new Blob(["not an image"], { type: "image/png" }),
    "spoofed.png",
  );
  const spoofedResponse = await fetch(`${apiBaseUrl}/food/upload`, {
    method: "POST",
    headers: { Authorization: headersFor(admin).Authorization },
    body: spoofedForm,
  });
  assert.equal(spoofedResponse.status, 400);

  const pngBytes = Uint8Array.from([137, 80, 78, 71, 13, 10, 26, 10]);
  const validForm = new FormData();
  validForm.append(
    "file",
    new Blob([pngBytes], { type: "image/png" }),
    "food.png",
  );
  const uploadResponse = await fetch(`${apiBaseUrl}/food/upload`, {
    method: "POST",
    headers: { Authorization: headersFor(admin).Authorization },
    body: validForm,
  });
  const upload = await uploadResponse.json();
  assert.equal(uploadResponse.status, 201);
  assert.match(upload.fileName, /^[0-9a-f-]+\.png$/);
  uploadedFiles.push(upload.fileName);

  const paginationResponse = await fetch(`${apiBaseUrl}/food/paginate`, {
    method: "POST",
    headers: headersFor(admin),
    body: JSON.stringify({ page: 1, itemsPerPage: 10 }),
  });
  const pagination = await paginationResponse.json();
  assert.equal(paginationResponse.status, 200);
  assert.ok(Array.isArray(pagination.results));
  assert.ok(
    Number.isInteger(pagination.totalItems) &&
      Number.isInteger(pagination.totalPages),
  );
});
