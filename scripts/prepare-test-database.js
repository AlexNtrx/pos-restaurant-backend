const { spawnSync } = require("node:child_process");
const path = require("node:path");
const { PrismaClient } = require("@prisma/client");
const { getDatabaseUrls } = require("../test/database-env");

const main = async () => {
  const { testUrl } = getDatabaseUrls();
  const testDatabaseName = decodeURIComponent(testUrl.pathname.slice(1));
  const maintenanceUrl = new URL(testUrl);
  maintenanceUrl.pathname = "/postgres";

  const maintenance = new PrismaClient({
    datasourceUrl: maintenanceUrl.toString(),
  });

  try {
    const existing = await maintenance.$queryRawUnsafe(
      "SELECT datname FROM pg_database WHERE datname = $1",
      testDatabaseName,
    );

    if (existing.length === 0) {
      // EN: The name passes the local disposable allowlist before quoted database creation.
      // FI: Nimi läpäisee paikallisen kertakäyttölistan ennen lainattua tietokannan luontia.
      await maintenance.$executeRawUnsafe(
        `CREATE DATABASE "${testDatabaseName}"`,
      );
      console.log(`Created disposable database: ${testDatabaseName}`);
    } else {
      console.log(`Disposable database already exists: ${testDatabaseName}`);
    }
  } finally {
    await maintenance.$disconnect();
  }

  const testDatabase = new PrismaClient({ datasourceUrl: testUrl.toString() });
  try {
    const active = await testDatabase.$queryRawUnsafe(
      "SELECT current_database() AS name",
    );
    if (active[0]?.name !== testDatabaseName) {
      throw new Error(
        "Disposable database connectivity check used the wrong database.",
      );
    }
    console.log(`Verified active database: ${active[0].name}`);
  } finally {
    await testDatabase.$disconnect();
  }

  const prismaCli = path.resolve("node_modules", "prisma", "build", "index.js");
  const migration = spawnSync(
    process.execPath,
    [prismaCli, "migrate", "deploy"],
    {
      cwd: process.cwd(),
      env: {
        ...process.env,
        NODE_ENV: "test",
        DATABASE_URL: testUrl.toString(),
        DIRECT_URL: testUrl.toString(),
      },
      stdio: "inherit",
    },
  );
  if (migration.status !== 0) {
    throw new Error("Failed to apply migrations to the disposable database.");
  }

  console.log(`Applied migrations to: ${testDatabaseName}`);
};

main().catch((error) => {
  console.error(error.message);
  process.exitCode = 1;
});
