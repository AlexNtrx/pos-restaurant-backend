const { PrismaClient } = require("@prisma/client");
const { hashPassword, passwordValidationError } = require("../lib/password");
const { validateDatabaseEnvironment } = require("../lib/environment");

const readAdminInput = (env) => {
  const name = env.FIRST_ADMIN_NAME?.trim();
  const username = env.FIRST_ADMIN_USERNAME?.trim();
  const password = env.FIRST_ADMIN_PASSWORD;
  if (!name || name.length > 100 || !username || username.length > 64) {
    throw new Error(
      "FIRST_ADMIN_NAME (1-100) and FIRST_ADMIN_USERNAME (1-64) are required.",
    );
  }
  if (passwordValidationError(password) || password.length < 16) {
    throw new Error(
      "FIRST_ADMIN_PASSWORD must be 16-128 characters; use a password manager.",
    );
  }
  return { name, username, password };
};

// EN: Offline opt-in bootstrap only; never called by build, migration or server startup.
// FI: Vain erikseen valittu offline-alustus; käännös, migraatio tai palvelin ei kutsu tätä.
const createFirstAdmin = async (prisma, env, apply = false) => {
  const expectedDatabase = env.FIRST_ADMIN_EXPECTED_DATABASE;
  const expectedHost = env.FIRST_ADMIN_EXPECTED_HOST;
  if (!expectedDatabase || !expectedHost)
    throw new Error(
      "FIRST_ADMIN_EXPECTED_DATABASE and FIRST_ADMIN_EXPECTED_HOST are required.",
    );
  if (new URL(env.DATABASE_URL).hostname !== expectedHost)
    throw new Error(
      "Database host does not match the approved bootstrap target.",
    );
  const [target] = await prisma.$queryRaw`SELECT current_database() AS name`;
  if (target.name !== expectedDatabase)
    throw new Error(
      "Database identity does not match the approved bootstrap target.",
    );
  if (!apply) {
    return {
      mode: "dry-run",
      database: target.name,
      users: await prisma.user.count(),
    };
  }
  const input = readAdminInput(env);
  const password = await hashPassword(input.password);
  return prisma.$transaction(
    async (tx) => {
      // EN: Exclude concurrent user writes and refuse every nonempty User table; never overwrite an account.
      // FI: Estä samanaikaiset käyttäjäkirjoitukset ja hylkää ei-tyhjä User-taulu; älä korvaa tiliä.
      await tx.$executeRaw`SET LOCAL lock_timeout = '5s'`;
      await tx.$executeRaw`LOCK TABLE "User" IN EXCLUSIVE MODE`;
      if (await tx.user.count())
        throw new Error(
          "First-admin bootstrap requires an empty User table; use existing admin/recovery procedures.",
        );
      const user = await tx.user.create({
        data: {
          name: input.name,
          username: input.username,
          password,
          level: "admin",
          status: "use",
        },
        select: { id: true },
      });
      return { mode: "created", database: target.name, userId: user.id };
    },
    { maxWait: 5000, timeout: 10000 },
  );
};

const main = async () => {
  require("dotenv").config({ quiet: true });
  const args = process.argv.slice(2);
  if (args.length > 1 || (args.length === 1 && args[0] !== "--apply")) {
    throw new Error("Usage: node scripts/create-first-admin.js [--apply]");
  }
  validateDatabaseEnvironment();
  const prisma = new PrismaClient();
  try {
    console.log(
      JSON.stringify(
        await createFirstAdmin(prisma, process.env, args[0] === "--apply"),
      ),
    );
  } finally {
    await prisma.$disconnect();
  }
};

if (require.main === module) {
  main().catch((error) => {
    // EN: Prisma diagnostics can contain connection details; output only controlled operator errors.
    // FI: Prisma-diagnoosi voi sisältää yhteystietoja; tulosta vain hallitut operaattorivirheet.
    console.error(
      error.code || error.name?.startsWith("Prisma")
        ? "Bootstrap database operation failed; inspect target and locks securely."
        : error.message,
    );
    process.exitCode = 1;
  });
}

module.exports = { createFirstAdmin, readAdminInput };
