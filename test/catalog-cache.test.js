const { after, before, test } = require("node:test");
const assert = require("node:assert/strict");
const http = require("node:http");
const { randomUUID } = require("node:crypto");
const {
  prisma,
  startApiServer,
  stopApiServer,
  createTestFixture,
  cleanupTestFixture,
  headersFor,
} = require("./helpers");
const {
  openSession,
  rotateToken,
  closeSession,
} = require("../lib/table-service");

let server, apiBaseUrl, fixture, policy, table, access;
const request = (route, headers = {}) =>
  new Promise((resolve, reject) => {
    http
      .get(`${apiBaseUrl}${route}`, { headers }, (response) => {
        const chunks = [];
        response.on("data", (chunk) => chunks.push(chunk));
        response.on("end", () =>
          resolve({
            status: response.statusCode,
            headers: response.headers,
            body: Buffer.concat(chunks).toString(),
          }),
        );
        response.on("error", reject);
      })
      .on("error", reject);
  });

before(async () => {
  ({ server, apiBaseUrl } = await startApiServer());
  fixture = await createTestFixture();
  policy = await prisma.qrPolicy.findUnique({ where: { id: 1 } });
  await prisma.qrPolicy.upsert({
    where: { id: 1 },
    create: { id: 1, mode: "ORDERING" },
    update: { mode: "ORDERING" },
  });
  table = await prisma.restaurantTable.create({
    data: {
      tableNo: 9000 + Math.floor(Math.random() * 1000),
      name: `cache-${randomUUID()}`,
    },
  });
  access = await openSession(prisma, table.id);
});
after(async () => {
  await prisma.tableSession.deleteMany({
    where: { restaurantTableId: table.id },
  });
  await prisma.restaurantTable.delete({ where: { id: table.id } });
  if (policy)
    await prisma.qrPolicy.update({
      where: { id: 1 },
      data: { mode: policy.mode },
    });
  else await prisma.qrPolicy.deleteMany({ where: { id: 1 } });
  await stopApiServer(server);
  await cleanupTestFixture(fixture);
});

test("catalog reads expose validators across origins and return bodyless 304 after authorization", async () => {
  for (const route of [
    "/food/list",
    "/food/filter/all",
    "/foodType/list",
    "/foodSize/list",
    "/taste/list",
    "/waiter/menu",
  ]) {
    const headers = {
      ...headersFor(fixture.admin),
      Origin: "http://localhost:3000",
    };
    const first = await request(route, headers);
    assert.equal(first.status, 200);
    assert.ok(first.headers.etag);
    assert.equal(first.headers["cache-control"], "no-store");
    assert.equal(first.headers["access-control-expose-headers"], "ETag");
    const unchanged = await request(route, {
      ...headers,
      "If-None-Match": first.headers.etag,
    });
    assert.equal(unchanged.status, 304);
    assert.equal(unchanged.body, "");
  }
});

test("conditional catalog reads still reject missing credentials and wrong roles", async () => {
  const first = await request("/food/list", headersFor(fixture.admin));
  assert.equal(
    (await request("/food/list", { "If-None-Match": first.headers.etag }))
      .status,
    401,
  );
  assert.equal(
    (
      await request("/food/list", {
        ...headersFor(fixture.user),
        "If-None-Match": first.headers.etag,
      })
    ).status,
    403,
  );
  const oldHeaders = headersFor(fixture.admin);
  await prisma.user.update({
    where: { id: fixture.admin.id },
    data: { level: "kassa" },
  });
  assert.equal(
    (
      await request("/food/list", {
        ...oldHeaders,
        "If-None-Match": first.headers.etag,
      })
    ).status,
    403,
  );
  await prisma.user.update({
    where: { id: fixture.admin.id },
    data: { level: "admin", status: "delete" },
  });
  assert.equal(
    (
      await request("/food/list", {
        ...oldHeaders,
        "If-None-Match": first.headers.etag,
      })
    ).status,
    401,
  );
  await prisma.user.update({
    where: { id: fixture.admin.id },
    data: { status: "use" },
  });
});

test("successful menu mutations change validators for prices, options, images and availability", async () => {
  let latest = await request(`/qr/${access.token}/menu`);
  const mutate = async (route, body) => {
    const response = await fetch(`${apiBaseUrl}${route}`, {
      method: "PUT",
      headers: headersFor(fixture.admin),
      body: JSON.stringify(body),
    });
    assert.equal(response.status, 200);
    const next = await request(`/qr/${access.token}/menu`, {
      "If-None-Match": latest.headers.etag,
    });
    assert.equal(next.status, 200);
    assert.notEqual(next.headers.etag, latest.headers.etag);
    latest = next;
  };
  const food = {
    id: fixture.food.id,
    foodTypeId: fixture.category.id,
    name: fixture.food.name,
    remark: "",
    price: 25,
    img: "replacement.webp",
    detailImg: "detail.webp",
    foodType: "food",
  };
  await mutate("/food/update", food);
  const category = JSON.parse(latest.body).result.categories.find(
    (row) => row.id === fixture.category.id,
  );
  assert.equal(category.food[0].price, 25);
  assert.equal(category.food[0].img, "replacement.webp");
  await mutate("/foodSize/update", {
    id: fixture.size.id,
    foodTypeId: fixture.category.id,
    name: fixture.size.name,
    remark: "",
    moneyAdded: 8,
  });
  await mutate("/taste/update", {
    id: fixture.taste.id,
    foodTypeId: fixture.category.id,
    name: `${fixture.marker}-changed`,
    remark: "",
  });
  await mutate("/foodType/update", {
    id: fixture.category.id,
    name: `${fixture.marker}-changed-category`,
    remark: "",
  });
  const removed = await fetch(`${apiBaseUrl}/food/remove/${fixture.food.id}`, {
    method: "DELETE",
    headers: headersFor(fixture.admin),
  });
  assert.equal(removed.status, 200);
  const unavailable = await request(`/qr/${access.token}/menu`, {
    "If-None-Match": latest.headers.etag,
  });
  assert.equal(unavailable.status, 200);
  assert.ok(
    !JSON.parse(unavailable.body).result.categories.some(
      (row) => row.id === fixture.category.id,
    ),
  );
  await prisma.food.update({
    where: { id: fixture.food.id },
    data: { status: "use", price: 20 },
  });
});

test("QR conditions recheck mode, token rotation and table session scope before reuse", async () => {
  const route = `/qr/${access.token}/menu`;
  const first = await request(route);
  assert.equal(first.headers["cache-control"], "no-store");
  assert.equal(
    (await request(route, { "If-None-Match": first.headers.etag })).status,
    304,
  );
  await prisma.qrPolicy.update({
    where: { id: 1 },
    data: { mode: "MENU_ONLY" },
  });
  const mode = await request(route, { "If-None-Match": first.headers.etag });
  assert.equal(mode.status, 200);
  assert.equal(JSON.parse(mode.body).result.state, "MENU_ONLY");
  await prisma.qrPolicy.update({
    where: { id: 1 },
    data: { mode: "DISABLED" },
  });
  assert.equal(
    (await request(route, { "If-None-Match": mode.headers.etag })).status,
    409,
  );
  await prisma.qrPolicy.update({
    where: { id: 1 },
    data: { mode: "ORDERING" },
  });
  const session = await prisma.tableSession.findFirst({
    where: { restaurantTableId: table.id },
  });
  const rotated = await rotateToken(prisma, session.id, session.tokenVersion);
  assert.equal(
    (await request(route, { "If-None-Match": first.headers.etag })).status,
    404,
  );
  const newRoute = `/qr/${rotated.token}/menu`;
  assert.equal((await request(newRoute)).status, 200);
  await closeSession(prisma, session.id, rotated.session.tokenVersion);
  assert.equal(
    (await request(newRoute, { "If-None-Match": first.headers.etag })).status,
    404,
  );
});
