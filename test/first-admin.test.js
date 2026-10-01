const { after, test } = require("node:test");
const assert = require("node:assert/strict");
const { prisma } = require("./helpers");
const {
  createFirstAdmin,
  readAdminInput,
} = require("../scripts/create-first-admin");
const { verifyPassword } = require("../lib/password");

after(() => prisma.$disconnect());

test("first admin is opt-in, hashed, target-bound and refuses repeated provisioning", async () => {
  const [target] = await prisma.$queryRaw`SELECT current_database() AS name`;
  const env = {
    DATABASE_URL: process.env.DATABASE_URL,
    FIRST_ADMIN_EXPECTED_HOST: new URL(process.env.DATABASE_URL).hostname,
    FIRST_ADMIN_EXPECTED_DATABASE: target.name,
    FIRST_ADMIN_NAME: "Disposable bootstrap test",
    FIRST_ADMIN_USERNAME: `bootstrap-${Date.now()}`,
    FIRST_ADMIN_PASSWORD: "disposable-bootstrap-test-password",
  };
  const before = await prisma.user.count();
  assert.deepEqual(await createFirstAdmin(prisma, env), {
    mode: "dry-run",
    database: target.name,
    users: before,
  });
  await assert.rejects(
    createFirstAdmin(
      prisma,
      { ...env, FIRST_ADMIN_EXPECTED_DATABASE: "wrong-target" },
      true,
    ),
    /identity/,
  );
  await assert.rejects(
    createFirstAdmin(
      prisma,
      { ...env, FIRST_ADMIN_EXPECTED_HOST: "wrong-endpoint.neon.tech" },
      true,
    ),
    /host does not match/,
  );
  assert.throws(
    () => readAdminInput({ ...env, FIRST_ADMIN_PASSWORD: "too-short" }),
    /16-128/,
  );
  assert.equal(await prisma.user.count(), before);
  if (before > 0) {
    // EN: Existing disposable fixtures are never cleared to make bootstrap testing pass.
    // FI: Olemassa olevia testirivejä ei poisteta alustustestin läpäisemiseksi.
    await assert.rejects(
      createFirstAdmin(prisma, env, true),
      /empty User table/,
    );
    assert.equal(await prisma.user.count(), before);
    return;
  }
  let userId;
  try {
    const result = await createFirstAdmin(prisma, env, true);
    userId = result.userId;
    const user = await prisma.user.findUnique({ where: { id: userId } });
    assert.equal(user.level, "admin");
    assert.equal(user.status, "use");
    assert.ok(user.password.startsWith("scrypt$"));
    assert.ok(await verifyPassword(env.FIRST_ADMIN_PASSWORD, user.password));
    await assert.rejects(
      createFirstAdmin(prisma, env, true),
      /empty User table/,
    );
    assert.equal(await prisma.user.count(), 1);
  } finally {
    if (userId) await prisma.user.delete({ where: { id: userId } });
  }
});
