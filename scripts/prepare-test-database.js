const { spawnSync } = require("node:child_process");
const path = require("node:path");
const { PrismaClient } = require("@prisma/client");
const { TEST_DATABASE_NAME, getDatabaseUrls } = require("../test/database-env");

const main = async () => {
  const { sourceUrl, testUrl } = getDatabaseUrls();
  const maintenanceUrl = new URL(sourceUrl);
  maintenanceUrl.pathname = "/postgres";

  const maintenance = new PrismaClient({
    datasourceUrl: maintenanceUrl.toString(),
  });

  try {
    const existing = await maintenance.$queryRawUnsafe(
      "SELECT datname FROM pg_database WHERE datname = $1",
      TEST_DATABASE_NAME,
    );

    if (existing.length === 0) {
      // EN: The database name is a constant, never client input, and creation runs through the maintenance database.
      // FI: Tietokannan nimi on vakio, ei koskaan asiakassyöte, ja luonti tehdään ylläpitotietokannan kautta.
      await maintenance.$executeRawUnsafe(
        `CREATE DATABASE "${TEST_DATABASE_NAME}"`,
      );
      console.log(`Created disposable database: ${TEST_DATABASE_NAME}`);
    } else {
      console.log(`Disposable database already exists: ${TEST_DATABASE_NAME}`);
    }
  } finally {
    await maintenance.$disconnect();
  }

  const testDatabase = new PrismaClient({ datasourceUrl: testUrl.toString() });
  try {
    const active = await testDatabase.$queryRawUnsafe(
      "SELECT current_database() AS name",
    );
    if (active[0]?.name !== TEST_DATABASE_NAME) {
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
      env: { ...process.env, DATABASE_URL: testUrl.toString() },
      stdio: "inherit",
    },
  );
  if (migration.status !== 0) {
    throw new Error("Failed to apply migrations to the disposable database.");
  }

  console.log(`Applied migrations to: ${TEST_DATABASE_NAME}`);
};

main().catch((error) => {
  console.error(error.message);
  process.exitCode = 1;
});
