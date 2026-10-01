const { spawnSync } = require("node:child_process");
const path = require("node:path");
require("dotenv").config({ quiet: true });
const { validateDatabaseEnvironment } = require("../lib/environment");

// EN: This entry point exposes only non-resetting migration commands; startup never migrates or seeds.
// FI: Tämä käynnistyspiste sallii vain nollaamattomat migraatiokomennot; palvelimen käynnistys ei migroi eikä alusta dataa.
try {
  const action = process.argv[2] || "deploy";
  if (!["deploy", "status", "validate", "generate"].includes(action)) {
    throw new Error("Unsupported Prisma deployment command.");
  }
  validateDatabaseEnvironment();
  const args = ["deploy", "status"].includes(action)
    ? ["migrate", action]
    : [action];
  const result = spawnSync(
    process.execPath,
    [path.resolve("node_modules/prisma/build/index.js"), ...args],
    { env: process.env, stdio: "inherit" },
  );
  if (result.error) throw new Error("Unable to start Prisma CLI.");
  process.exitCode = result.status ?? 1;
} catch (error) {
  console.error(error.message);
  process.exitCode = 1;
}
