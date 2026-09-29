const { after, before, test } = require("node:test");
const assert = require("node:assert/strict");
const { randomUUID } = require("node:crypto");
const {
  prisma,
  startApiServer,
  stopApiServer,
  createTestFixture,
  cleanupTestFixture,
  headersFor,
} = require("./helpers");
const { openSession, closeSession } = require("../lib/table-service");

let server;
let apiBaseUrl;
let fixture;
let originalPolicy;
const tableIds = [];

const request = (path, method = "GET", body, user) =>
  fetch(`${apiBaseUrl}${path}`, {
    method,
    headers: {
      "Content-Type": "application/json",
      ...(user ? headersFor(user) : {}),
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });

const makeTable = async () => {
  const table = await prisma.restaurantTable.create({
    data: {
      tableNo: 10000 + Math.floor(Math.random() * 100000),
      name: `Service call ${randomUUID()}`,
    },
  });
  tableIds.push(table.id);
  return { table, access: await openSession(prisma, table.id) };
};

before(async () => {
  ({ server, apiBaseUrl } = await startApiServer());
  fixture = await createTestFixture();
  originalPolicy = await prisma.qrPolicy.findUnique({ where: { id: 1 } });
  await prisma.qrPolicy.upsert({
    where: { id: 1 },
    create: { id: 1, mode: "ORDERING" },
    update: { mode: "ORDERING" },
  });
});

after(async () => {
  await prisma.serviceCall.deleteMany({
    where: { TableSession: { restaurantTableId: { in: tableIds } } },
  });
  await prisma.tableSession.deleteMany({
    where: { restaurantTableId: { in: tableIds } },
  });
  await prisma.restaurantTable.deleteMany({ where: { id: { in: tableIds } } });
  if (originalPolicy)
    await prisma.qrPolicy.update({
      where: { id: 1 },
      data: { mode: originalPolicy.mode },
    });
  else await prisma.qrPolicy.deleteMany({ where: { id: 1 } });
  await stopApiServer(server);
  await cleanupTestFixture(fixture);
});

test("QR call is scoped to its table and concurrent retries create one active call", async () => {
  const first = await makeTable();
  const second = await makeTable();
  const path = `/qr/${first.access.token}/service-call`;

  assert.equal((await request("/qr/invalid/service-call")).status, 404);
  assert.equal(
    (await request(path, "POST", { tableNo: second.table.tableNo })).status,
    400,
  );
  assert.equal(
    (await request(`/qr/${second.access.token}/service-call`)).status,
    200,
  );

  const responses = await Promise.all([
    request(path, "POST", {}),
    request(path, "POST", {}),
  ]);
  assert.deepEqual(
    responses.map((response) => response.status),
    [200, 200],
  );
  const calls = await Promise.all(responses.map((response) => response.json()));
  assert.equal(calls[0].result.id, calls[1].result.id);
  assert.equal(calls[0].result.tableNo, first.table.tableNo);
  assert.equal(
    await prisma.serviceCall.count({
      where: { tableSessionId: first.access.session.id },
    }),
    1,
  );
  const foreign = await request(`/qr/${second.access.token}/service-call`);
  assert.equal((await foreign.json()).result, null);
});

test("staff acknowledges and resolves with version checks; public retry is cooled down", async () => {
  const { access } = await makeTable();
  const path = `/qr/${access.token}/service-call`;
  const created = (await (await request(path, "POST", {})).json()).result;
  assert.equal((await request("/service-calls")).status, 401);

  const list = await request("/service-calls", "GET", undefined, fixture.user);
  assert.equal(list.status, 200);
  const call = (await list.json()).results.find((row) => row.id === created.id);
  assert.equal(call.status, "REQUESTED");
  assert.equal(call.version, 1);

  const actionPath = `/service-calls/${created.id}/status`;
  const actions = await Promise.all([
    request(
      actionPath,
      "PATCH",
      {
        expectedVersion: 1,
        nextStatus: "ACKNOWLEDGED",
      },
      fixture.user,
    ),
    request(
      actionPath,
      "PATCH",
      {
        expectedVersion: 1,
        nextStatus: "ACKNOWLEDGED",
      },
      fixture.admin,
    ),
  ]);
  assert.deepEqual(
    actions.map((response) => response.status).sort(),
    [200, 409],
  );
  const current = (await (await request(path)).json()).result;
  assert.equal(current.status, "ACKNOWLEDGED");
  const resolved = await request(
    actionPath,
    "PATCH",
    {
      expectedVersion: 2,
      nextStatus: "RESOLVED",
    },
    fixture.user,
  );
  assert.equal(resolved.status, 200);
  assert.equal((await resolved.json()).result.status, "RESOLVED");
  assert.equal((await request(path, "POST", {})).status, 429);

  await prisma.serviceCall.update({
    where: { id: created.id },
    data: { resolvedAt: new Date(Date.now() - 61_000) },
  });
  const next = await request(path, "POST", {});
  assert.equal(next.status, 200);
  assert.notEqual((await next.json()).result.id, created.id);
});

test("closing a table session resolves its active call and invalidates QR access", async () => {
  const { access } = await makeTable();
  const path = `/qr/${access.token}/service-call`;
  const created = (await (await request(path, "POST", {})).json()).result;
  await closeSession(prisma, access.session.id, access.session.tokenVersion);
  assert.equal((await request(path, "POST", {})).status, 404);
  const saved = await prisma.serviceCall.findUnique({
    where: { id: created.id },
  });
  assert.equal(saved.status, "RESOLVED");
  const queue = await request("/service-calls", "GET", undefined, fixture.user);
  assert.ok(!(await queue.json()).results.some((row) => row.id === created.id));
});

test("MENU_ONLY permits calling staff while DISABLED blocks new calls", async () => {
  const { access } = await makeTable();
  const path = `/qr/${access.token}/service-call`;
  try {
    await prisma.qrPolicy.update({
      where: { id: 1 },
      data: { mode: "MENU_ONLY" },
    });
    assert.equal((await request(path, "POST", {})).status, 200);
    await prisma.qrPolicy.update({
      where: { id: 1 },
      data: { mode: "DISABLED" },
    });
    const blocked = await request(path, "POST", {});
    assert.equal(blocked.status, 409);
    assert.equal((await blocked.json()).code, "SERVICE_UNAVAILABLE");
  } finally {
    await prisma.qrPolicy.update({
      where: { id: 1 },
      data: { mode: "ORDERING" },
    });
  }
});
