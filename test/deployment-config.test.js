const assert = require("node:assert/strict");
const { test } = require("node:test");
const { spawnSync } = require("node:child_process");
const { randomBytes } = require("node:crypto");
const {
  getCorsOrigins,
  getPort,
  validateRuntimeEnvironment,
  validateDatabaseEnvironment,
} = require("../lib/environment");

const productionEnv = () => ({
  NODE_ENV: "production",
  DATABASE_URL:
    "postgresql://fixture:fixture@ep-fixture-pooler.eu-central-1.aws.neon.tech/neondb?sslmode=require&connection_limit=5&connect_timeout=15",
  DIRECT_URL:
    "postgresql://fixture:fixture@ep-fixture.eu-central-1.aws.neon.tech/neondb?sslmode=require&connect_timeout=15",
  SECRET_KEY: randomBytes(32).toString("hex"),
  QR_TOKEN_SECRET: randomBytes(32).toString("hex"),
  CORS_ORIGINS: "https://pos.example.com",
  PORT: "10000",
});

test("production config accepts distinct secrets, bounded pooled runtime and direct migrations", () => {
  const env = productionEnv();
  validateRuntimeEnvironment(env);
  assert.equal(getPort(env), 10000);
  assert.deepEqual(getCorsOrigins(env), ["https://pos.example.com"]);
});

test("production rejects missing SSL, unbounded pools, mismatched migration targets and test databases", () => {
  const baseline = productionEnv();
  for (const patch of [
    {
      DATABASE_URL: baseline.DATABASE_URL.replace(
        "sslmode=require",
        "sslmode=disable",
      ),
    },
    {
      DIRECT_URL: baseline.DIRECT_URL.replace(
        "sslmode=require",
        "sslmode=disable",
      ),
    },
    {
      DATABASE_URL: baseline.DATABASE_URL.replace(
        "connection_limit=5",
        "connection_limit=0",
      ),
    },
    { DATABASE_URL: baseline.DATABASE_URL.replace("&connection_limit=5", "") },
    { DIRECT_URL: baseline.DATABASE_URL },
    { DIRECT_URL: baseline.DIRECT_URL.replace("neondb", "other") },
    { DIRECT_URL: baseline.DIRECT_URL.replace("ep-fixture.", "ep-other.") },
    {
      DATABASE_URL: baseline.DATABASE_URL.replace(
        "neondb",
        "db_next_workshop_pos_test",
      ),
    },
    { DIRECT_URL: "postgresql://fixture:fixture@localhost:5432/neondb" },
  ]) {
    assert.throws(() => validateDatabaseEnvironment({ ...baseline, ...patch }));
  }
});

test("production rejects unsafe CORS, missing secrets and invalid Render ports", () => {
  const baseline = productionEnv();
  for (const patch of [
    { CORS_ORIGINS: "" },
    { CORS_ORIGINS: "*" },
    { CORS_ORIGINS: "http://pos.example.com" },
    { CORS_ORIGINS: "https://localhost:3000" },
    { CORS_ORIGINS: "https://pos.example.com/path" },
    { SECRET_KEY: "short" },
    { QR_TOKEN_SECRET: "short" },
    { QR_TOKEN_SECRET: baseline.SECRET_KEY },
    { PORT: "0" },
    { PORT: "65536" },
    { PORT: "not-a-port" },
  ]) {
    assert.throws(() => validateRuntimeEnvironment({ ...baseline, ...patch }));
  }
});

test("test entry points refuse production before loading fixtures or maintenance clients", () => {
  for (const script of [
    "test/bootstrap.js",
    "scripts/prepare-test-database.js",
    "scripts/migrate-passwords.js",
  ]) {
    const result = spawnSync(process.execPath, [script], {
      env: { ...process.env, ...productionEnv() },
      encoding: "utf8",
    });
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /cannot run in production/);
    assert.doesNotMatch(result.stderr, /fixture:fixture/);
  }
});

test("test DB isolation overrides direct URL and rejects remote and non-disposable targets", () => {
  const code =
    'const {activateTestDatabase}=require("./test/database-env");activateTestDatabase();if(process.env.DATABASE_URL!==process.env.DIRECT_URL)process.exit(2);';
  const env = {
    ...process.env,
    NODE_ENV: "test",
    DATABASE_URL: productionEnv().DATABASE_URL,
    DIRECT_URL: productionEnv().DIRECT_URL,
  };
  for (const target of [
    "postgresql://fixture:fixture@ep-fixture.eu-central-1.aws.neon.tech/db_next_workshop_pos_test",
    "postgresql://fixture:fixture@localhost:5432/neondb",
    "postgresql://fixture:fixture@localhost:5432/db_next_workshop_pos_test?host=remote.example.com",
  ]) {
    const result = spawnSync(process.execPath, ["-e", code], {
      env: { ...env, TEST_DATABASE_URL: target },
      encoding: "utf8",
    });
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /disposable/);
  }
  const result = spawnSync(process.execPath, ["-e", code], {
    env: {
      ...env,
      TEST_DATABASE_URL:
        "postgresql://fixture:fixture@localhost:5432/db_next_workshop_pos_test",
    },
    encoding: "utf8",
  });
  assert.equal(result.status, 0, result.stderr);
});

test("legacy password maintenance refuses remote databases even without the production flag", () => {
  const env = { ...process.env, ...productionEnv(), NODE_ENV: "development" };
  const result = spawnSync(process.execPath, ["scripts/migrate-passwords.js"], {
    env,
    encoding: "utf8",
  });
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /local development or disposable test database/);
});

test("production HTTP setup handles CORS preflight, readiness and connection failure without real DB access", async () => {
  const previousEnv = { ...process.env };
  const prismaPath = require.resolve("../lib/prisma");
  const previousPrisma = require.cache[prismaPath];
  let connected = false;
  let failDatabase = false;
  const prisma = {
    async $connect() {
      if (failDatabase) throw new Error("fixture failure");
      connected = true;
    },
    async $disconnect() {},
    async $queryRaw() {
      if (failDatabase) throw new Error("fixture failure");
      return [{ value: 1 }];
    },
  };
  require.cache[prismaPath] = {
    id: prismaPath,
    filename: prismaPath,
    loaded: true,
    exports: prisma,
  };
  Object.assign(process.env, productionEnv());
  let server;
  try {
    const { app, startServer } = require("../server");
    server = await startServer(0);
    assert.equal(connected, true);
    const origin = `http://127.0.0.1:${server.address().port}`;
    const preflight = await fetch(`${origin}/api/user/getLevelByToken`, {
      method: "OPTIONS",
      headers: {
        Origin: "https://pos.example.com",
        "Access-Control-Request-Method": "GET",
        "Access-Control-Request-Headers": "authorization",
      },
    });
    assert.equal(preflight.status, 204);
    assert.equal(
      preflight.headers.get("access-control-allow-origin"),
      "https://pos.example.com",
    );
    assert.match(
      preflight.headers.get("access-control-allow-headers"),
      /authorization/,
    );
    const denied = await fetch(`${origin}/health`, {
      headers: { Origin: "https://untrusted.example.com" },
    });
    assert.equal(denied.headers.get("access-control-allow-origin"), null);
    const healthy = await fetch(`${origin}/health`);
    assert.equal(healthy.status, 200);
    assert.deepEqual(await healthy.json(), { status: "ok" });
    failDatabase = true;
    const unavailable = await fetch(`${origin}/health`);
    assert.equal(unavailable.status, 503);
    assert.deepEqual(await unavailable.json(), { status: "unavailable" });
    await assert.rejects(startServer(0), /fixture failure/);
    assert.ok(app);
  } finally {
    if (server) await new Promise((resolve) => server.close(resolve));
    process.env = previousEnv;
    if (previousPrisma) require.cache[prismaPath] = previousPrisma;
    else delete require.cache[prismaPath];
    delete require.cache[require.resolve("../server")];
  }
});
