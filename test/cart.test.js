const { after, before, test } = require("node:test");
const assert = require("node:assert/strict");
const {
  prisma,
  startApiServer,
  stopApiServer,
  signToken,
  bearer,
  createTestFixture,
  cleanupTestFixture,
} = require("./helpers");

let apiBaseUrl;
let apiServer;
let owner;
let otherUser;
let food;
let ownerToken;
let otherToken;
const tableNo = 900000 + (Date.now() % 90000);
const otherTableNo = tableNo + 1;
let fixture;

// Coordinates json request behavior for this module.
const jsonRequest = (token, body) => ({
  headers: { ...bearer(token), "Content-Type": "application/json" },
  body: JSON.stringify(body),
});
// Coordinates cart url behavior for this module.
const cartUrl = (table) => `${apiBaseUrl}/saleTemp/list/?tableNo=${table}`;

// Removes or clears test carts using the existing workflow.
const clearTestCarts = async () => {
  await prisma.$transaction(async (tx) => {
    await tx.saleTempDetail.deleteMany({
      where: { SaleTemp: { tableNo: { in: [tableNo, otherTableNo] } } },
    });
    await tx.saleTemp.deleteMany({
      where: { tableNo: { in: [tableNo, otherTableNo] } },
    });
  });
};

before(async () => {
  const started = await startApiServer();
  apiServer = started.server;
  apiBaseUrl = started.apiBaseUrl;

  fixture = await createTestFixture();
  owner = fixture.admin;
  otherUser = fixture.user;
  food = fixture.food;
  ownerToken = signToken(owner);
  otherToken = signToken(otherUser);
  await clearTestCarts();
});

after(async () => {
  await clearTestCarts();
  await stopApiServer(apiServer);
  await cleanupTestFixture(fixture);
  await prisma.$disconnect();
});

test("cart list requires a positive table number", async () => {
  const response = await fetch(`${apiBaseUrl}/saleTemp/list/`, {
    headers: bearer(ownerToken),
  });
  assert.equal(response.status, 400);
});

test("concurrent adds use authenticated identity and preserve one line/detail invariant", async () => {
  const responses = await Promise.all(
    Array.from({ length: 5 }, () =>
      fetch(`${apiBaseUrl}/saleTemp/create`, {
        method: "POST",
        ...jsonRequest(ownerToken, {
          tableNo,
          foodId: food.id,
          userId: otherUser.id,
        }),
      }),
    ),
  );
  assert.ok(responses.every((response) => response.status === 200));

  const [ownerResponse, otherResponse, otherTableResponse] = await Promise.all([
    fetch(cartUrl(tableNo), { headers: bearer(ownerToken) }),
    fetch(cartUrl(tableNo), { headers: bearer(otherToken) }),
    fetch(cartUrl(otherTableNo), { headers: bearer(ownerToken) }),
  ]);
  const ownerCart = await ownerResponse.json();
  assert.equal(ownerCart.results.length, 1);
  assert.equal(ownerCart.results[0].qty, 5);
  assert.equal(ownerCart.results[0].saleTempDetails.length, 5);
  assert.equal(ownerCart.summary.baseAmount, food.price * 5);
  assert.equal(ownerCart.summary.total, food.price * 5);
  assert.deepEqual((await otherResponse.json()).results, []);
  assert.deepEqual((await otherTableResponse.json()).results, []);
});

test("direct IDs cannot read or mutate another user's cart", async () => {
  const cart = await prisma.saleTemp.findUnique({
    where: {
      userId_tableNo_foodId: { userId: owner.id, tableNo, foodId: food.id },
    },
    include: { saleTempDetails: true },
  });
  assert.ok(cart);

  const [infoResponse, qtyResponse, detailResponse] = await Promise.all([
    fetch(`${apiBaseUrl}/saleTemp/info/${cart.id}`, {
      headers: bearer(otherToken),
    }),
    fetch(`${apiBaseUrl}/saleTemp/updateQty`, {
      method: "PUT",
      ...jsonRequest(otherToken, { id: cart.id, qty: 1 }),
    }),
    fetch(`${apiBaseUrl}/saleTemp/unSelectTaste`, {
      method: "PUT",
      ...jsonRequest(otherToken, {
        saleTempDetailId: cart.saleTempDetails[0].id,
      }),
    }),
  ]);
  assert.equal(infoResponse.status, 404);
  assert.equal(qtyResponse.status, 404);
  assert.equal(detailResponse.status, 404);
});

test("quantity changes remain transactional with exactly one detail per unit", async () => {
  const cart = await prisma.saleTemp.findUnique({
    where: {
      userId_tableNo_foodId: { userId: owner.id, tableNo, foodId: food.id },
    },
  });
  const response = await fetch(`${apiBaseUrl}/saleTemp/updateQty`, {
    method: "PUT",
    ...jsonRequest(ownerToken, { id: cart.id, qty: 2 }),
  });
  assert.equal(response.status, 200);
  const updated = await prisma.saleTemp.findUnique({
    where: { id: cart.id },
    include: { saleTempDetails: true },
  });
  assert.equal(updated.qty, 2);
  assert.equal(updated.saleTempDetails.length, 2);
});

test("taste and size writes reject inactive or cross-type options and totals use valid server prices", async () => {
  const cart = await prisma.saleTemp.findUnique({
    where: {
      userId_tableNo_foodId: { userId: owner.id, tableNo, foodId: food.id },
    },
    include: { saleTempDetails: true },
  });
  const {
    inactiveTaste: invalidTaste,
    inactiveSize: invalidSize,
    size: validSize,
  } = fixture;
  const detailId = cart.saleTempDetails[0].id;

  const [tasteResponse, sizeResponse] = await Promise.all([
    fetch(`${apiBaseUrl}/saleTemp/selectTaste`, {
      method: "PUT",
      ...jsonRequest(ownerToken, {
        saleTempDetailId: detailId,
        tasteId: invalidTaste.id,
      }),
    }),
    fetch(`${apiBaseUrl}/saleTemp/selectSize`, {
      method: "PUT",
      ...jsonRequest(ownerToken, {
        saleTempDetailId: detailId,
        sizeId: invalidSize.id,
      }),
    }),
  ]);
  assert.equal(tasteResponse.status, 400);
  assert.equal(sizeResponse.status, 400);
  const unchangedDetail = await prisma.saleTempDetail.findUnique({
    where: { id: detailId },
  });
  assert.equal(unchangedDetail.tasteId, null);
  assert.equal(unchangedDetail.foodSizeId, null);

  const validResponse = await fetch(`${apiBaseUrl}/saleTemp/selectSize`, {
    method: "PUT",
    ...jsonRequest(ownerToken, {
      saleTempDetailId: detailId,
      sizeId: validSize.id,
    }),
  });
  assert.equal(validResponse.status, 200);
  const body = await (
    await fetch(cartUrl(tableNo), { headers: bearer(ownerToken) })
  ).json();
  assert.equal(body.summary.addedAmount, validSize.moneyAdded);
  assert.equal(body.summary.total, food.price * 2 + validSize.moneyAdded);

  const clearSizeResponse = await fetch(`${apiBaseUrl}/saleTemp/selectSize`, {
    method: "PUT",
    ...jsonRequest(ownerToken, { saleTempDetailId: detailId, sizeId: null }),
  });
  assert.equal(clearSizeResponse.status, 200);
});

test("food filters return active foods with a consistent response shape", async () => {
  for (const filter of ["all", "food", "drink"]) {
    const response = await fetch(`${apiBaseUrl}/food/filter/${filter}`, {
      headers: bearer(ownerToken),
    });
    assert.equal(response.status, 200);
    const body = await response.json();
    assert.ok(Array.isArray(body.results));
    assert.ok(body.results.every((item) => item.status === "use"));
    if (filter !== "all")
      assert.ok(body.results.every((item) => item.foodType === filter));
  }
});

test("clear removes only the authenticated user's selected table", async () => {
  const response = await fetch(`${apiBaseUrl}/saleTemp/removeAll`, {
    method: "DELETE",
    ...jsonRequest(ownerToken, { tableNo, userId: otherUser.id }),
  });
  assert.equal(response.status, 200);
  assert.equal(
    await prisma.saleTemp.count({ where: { userId: owner.id, tableNo } }),
    0,
  );
});
