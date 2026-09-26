const { after, before, test } = require("node:test");
const assert = require("node:assert/strict");
const { createHash, randomUUID } = require("node:crypto");
const {
  prisma,
  startApiServer,
  stopApiServer,
  headersFor,
  createTestFixture,
  cleanupTestFixture,
} = require("./helpers");
const { resolveQrAccess } = require("../lib/table-service");

let fixture;
let server;
let apiBaseUrl;
let originalPolicy;
const tableIds = [];

const request = (path, method = "GET", body, user = fixture.admin) =>
  fetch(`${apiBaseUrl}${path}`, {
    method,
    headers: headersFor(user),
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });

const createTable = async () => {
  const tableNo = Math.floor(Math.random() * 9000) + 1001;
  const response = await request("/tables", "POST", {
    tableNo,
    name: `QR test ${randomUUID()}`,
  });
  assert.equal(response.status, 201);
  const { result } = await response.json();
  tableIds.push(result.id);
  return result;
};

before(async () => {
  ({ server, apiBaseUrl } = await startApiServer());
  fixture = await createTestFixture();
  originalPolicy = await prisma.qrPolicy.findUnique({ where: { id: 1 } });
});

after(async () => {
  if (tableIds.length) {
    await prisma.order.deleteMany({
      where: { restaurantTableId: { in: tableIds } },
    });
    await prisma.tableSession.deleteMany({
      where: { restaurantTableId: { in: tableIds } },
    });
    await prisma.restaurantTable.deleteMany({
      where: { id: { in: tableIds } },
    });
  }
  if (originalPolicy)
    await prisma.qrPolicy.update({
      where: { id: 1 },
      data: { mode: originalPolicy.mode },
    });
  else await prisma.qrPolicy.deleteMany({ where: { id: 1 } });
  await stopApiServer(server);
  await cleanupTestFixture(fixture);
});

test("table CRUD requires staff/admin roles and preserves history by soft deletion", async () => {
  const anonymous = await fetch(`${apiBaseUrl}/tables`);
  assert.equal(anonymous.status, 401);
  const denied = await request(
    "/tables",
    "POST",
    { tableNo: 123, name: "Denied" },
    fixture.user,
  );
  assert.equal(denied.status, 403);
  const invalid = await request("/tables", "POST", {
    tableNo: "2",
    name: "Invalid",
  });
  assert.equal(invalid.status, 400);

  const table = await createTable();
  const list = await request("/tables", "GET", undefined, fixture.user);
  assert.equal(list.status, 200);
  const listed = (await list.json()).results.find((row) => row.id === table.id);
  assert.equal(listed.tableNo, table.tableNo);
  assert.equal(listed.openSession, null);

  const updateDenied = await request(
    `/tables/${table.id}`,
    "PUT",
    { name: "Denied" },
    fixture.user,
  );
  assert.equal(updateDenied.status, 403);
  const update = await request(`/tables/${table.id}`, "PUT", {
    name: "Window table",
  });
  assert.equal(update.status, 200);
  assert.equal((await update.json()).result.name, "Window table");

  const duplicate = await request("/tables", "POST", {
    tableNo: table.tableNo,
  });
  assert.equal(duplicate.status, 409);
  const deleteDenied = await request(
    `/tables/${table.id}`,
    "DELETE",
    undefined,
    fixture.user,
  );
  assert.equal(deleteDenied.status, 403);
  const removed = await request(`/tables/${table.id}`, "DELETE");
  assert.equal(removed.status, 200);
  assert.equal(
    (await prisma.restaurantTable.findUnique({ where: { id: table.id } }))
      .status,
    "delete",
  );
});

test("one open session receives a hashed 24-hour token and rotation revokes the old token", async () => {
  const table = await createTable();
  const [first, second] = await Promise.all([
    request(`/tables/${table.id}/sessions`, "POST", {}),
    request(`/tables/${table.id}/sessions`, "POST", {}),
  ]);
  assert.deepEqual([first.status, second.status].sort(), [201, 409]);
  const opened = (await (first.status === 201 ? first : second).json()).result;
  assert.match(opened.token, /^[A-Za-z0-9_-]{43}$/);
  assert.equal(opened.path, `/order/${opened.token}`);
  assert.equal(opened.session.tokenVersion, 1);
  assert.equal(
    new Date(opened.session.qrTokenExpiresAt).getTime() - Date.now() >
      23 * 60 * 60 * 1000,
    true,
  );
  const stored = await prisma.tableSession.findUnique({
    where: { id: opened.session.id },
  });
  assert.equal(
    stored.qrTokenHash,
    createHash("sha256").update(opened.token).digest("hex"),
  );
  assert.equal(JSON.stringify(stored).includes(opened.token), false);
  assert.match(stored.qrTokenNonce, /^[a-f0-9]{64}$/);
  const listed = (await (await request("/tables")).json()).results.find(
    (row) => row.id === table.id,
  );
  assert.equal(listed.openSession.id, opened.session.id);
  assert.equal(JSON.stringify(listed).includes("qrTokenHash"), false);
  assert.equal(JSON.stringify(listed).includes("qrTokenNonce"), false);
  const qrAnonymous = await fetch(
    `${apiBaseUrl}/table-sessions/${opened.session.id}/qr`,
  );
  assert.equal(qrAnonymous.status, 401);
  const reissued = await request(
    `/table-sessions/${opened.session.id}/qr`,
    "GET",
    undefined,
    fixture.user,
  );
  assert.equal(reissued.status, 200);
  assert.equal(reissued.headers.get("cache-control"), "no-store");
  assert.equal((await reissued.json()).result.token, opened.token);
  const originalKey = process.env.QR_TOKEN_SECRET;
  try {
    process.env.QR_TOKEN_SECRET = "0".repeat(64);
    const changedKey = await request(`/table-sessions/${opened.session.id}/qr`);
    assert.equal(changedKey.status, 503);
    assert.equal((await changedKey.json()).code, "QR_KEY_MISMATCH");
    assert.equal(await resolveQrAccess(prisma, opened.token), null);
    delete process.env.QR_TOKEN_SECRET;
    const missingKey = await request(`/table-sessions/${opened.session.id}/qr`);
    assert.equal(missingKey.status, 503);
    assert.equal((await missingKey.json()).code, "QR_KEY_UNAVAILABLE");
    assert.equal(await resolveQrAccess(prisma, opened.token), null);
  } finally {
    process.env.QR_TOKEN_SECRET = originalKey;
  }

  const rotate = await request(
    `/table-sessions/${opened.session.id}/rotate-token`,
    "POST",
    { expectedVersion: 1 },
    fixture.user,
  );
  assert.equal(rotate.status, 200);
  const rotated = (await rotate.json()).result;
  assert.notEqual(rotated.token, opened.token);
  assert.equal(rotated.session.tokenVersion, 2);
  const reissuedAfterRotate = await request(
    `/table-sessions/${opened.session.id}/qr`,
  );
  assert.equal((await reissuedAfterRotate.json()).result.token, rotated.token);
  assert.equal(await resolveQrAccess(prisma, opened.token), null);
  assert.deepEqual(await resolveQrAccess(prisma, rotated.token), {
    state: "CLOSED",
    tableNo: table.tableNo,
    tableSessionId: opened.session.id,
  });
  const stale = await request(
    `/table-sessions/${opened.session.id}/rotate-token`,
    "POST",
    { expectedVersion: 1 },
  );
  assert.equal(stale.status, 409);
  const deleteOpen = await request(`/tables/${table.id}`, "DELETE");
  assert.equal(deleteOpen.status, 409);

  const close = await request(
    `/table-sessions/${opened.session.id}/close`,
    "POST",
    { expectedVersion: 2 },
    fixture.user,
  );
  assert.equal(close.status, 200);
  assert.equal(await resolveQrAccess(prisma, rotated.token), null);
  const closed = await prisma.tableSession.findUnique({
    where: { id: opened.session.id },
  });
  assert.equal(closed.status, "CLOSED");
  assert.equal(closed.qrTokenHash, null);
  assert.equal(closed.qrTokenNonce, null);
  assert.equal(closed.qrTokenExpiresAt, null);
  assert.equal(
    (await request(`/table-sessions/${opened.session.id}/qr`)).status,
    409,
  );
});

test("QR mode is backend-controlled and closing refuses unsettled Orders", async () => {
  const table = await createTable();
  const open = await request(`/tables/${table.id}/sessions`, "POST", {});
  assert.equal(open.status, 201);
  const { session, token } = (await open.json()).result;
  const denied = await request(
    "/qr-mode",
    "PUT",
    { mode: "ORDERING" },
    fixture.user,
  );
  assert.equal(denied.status, 403);
  const invalid = await request("/qr-mode", "PUT", { mode: "OPEN" });
  assert.equal(invalid.status, 400);
  assert.equal(
    (await (await request("/qr-mode")).json()).result.mode,
    "DISABLED",
  );

  for (const mode of ["MENU_ONLY", "ORDERING", "DISABLED"]) {
    const set = await request("/qr-mode", "PUT", { mode });
    assert.equal(set.status, 200);
    assert.equal((await set.json()).result.mode, mode);
    assert.equal(
      (await resolveQrAccess(prisma, token)).state,
      mode === "DISABLED" ? "CLOSED" : mode,
    );
  }
  await request("/qr-mode", "PUT", { mode: "ORDERING" });
  await prisma.tableSession.update({
    where: { id: session.id },
    data: { qrTokenExpiresAt: new Date(Date.now() - 1000) },
  });
  assert.equal(await resolveQrAccess(prisma, token), null);
  assert.equal((await request(`/table-sessions/${session.id}/qr`)).status, 409);

  const order = await prisma.order.create({
    data: {
      channel: "QR",
      status: "SUBMITTED",
      restaurantTableId: table.id,
      tableSessionId: session.id,
      tableNo: table.tableNo,
      subtotal: 20,
      modifierTotal: 0,
      total: 20,
      idempotencyScope: `qr-test:${session.id}`,
      idempotencyKey: randomUUID(),
      idempotencyFingerprint: createHash("sha256")
        .update(randomUUID())
        .digest("hex"),
    },
  });
  const blocked = await request(`/table-sessions/${session.id}/close`, "POST", {
    expectedVersion: 1,
  });
  assert.equal(blocked.status, 409);
  assert.equal((await blocked.json()).code, "UNSETTLED_ORDERS");
  await prisma.order.update({
    where: { id: order.id },
    data: { status: "CANCELLED", cancelledAt: new Date() },
  });
  const closed = await request(`/table-sessions/${session.id}/close`, "POST", {
    expectedVersion: 1,
  });
  assert.equal(closed.status, 200);
  assert.equal(await resolveQrAccess(prisma, token), null);
});
