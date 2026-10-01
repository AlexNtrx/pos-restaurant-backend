require("dotenv").config({ quiet: true });
// EN: Legacy data maintenance is never part of deployment and is disabled in production.
// FI: Vanhan datan ylläpito ei kuulu julkaisuun, ja se on estetty tuotannossa.
if (process.env.NODE_ENV === "production") {
  throw new Error("Password maintenance cannot run in production.");
}
const maintenanceUrl = new URL(process.env.DATABASE_URL);
if (
  !["postgres:", "postgresql:"].includes(maintenanceUrl.protocol) ||
  !["localhost", "127.0.0.1", "[::1]"].includes(maintenanceUrl.hostname) ||
  !/^db_next_workshop_pos(?:_test(?:_[a-z0-9_]+)?)?$/.test(
    decodeURIComponent(maintenanceUrl.pathname.slice(1)),
  ) ||
  maintenanceUrl.searchParams.has("host") ||
  maintenanceUrl.searchParams.has("options")
) {
  throw new Error(
    "Password maintenance requires the local development or disposable test database.",
  );
}
const { PrismaClient } = require("@prisma/client");
const { hashPassword, isPasswordHash } = require("../lib/password");

const prisma = new PrismaClient();

// Coordinates migrate passwords behavior for this module.
const migratePasswords = async () => {
  const users = await prisma.user.findMany({
    select: { id: true, password: true },
  });
  const legacyUsers = users.filter((user) => !isPasswordHash(user.password));

  await prisma.$transaction(async (tx) => {
    for (const user of legacyUsers) {
      await tx.user.update({
        where: { id: user.id },
        data: { password: await hashPassword(user.password) },
      });
    }
  });

  console.log(`Migrated ${legacyUsers.length} legacy password hash(es).`);
};

migratePasswords()
  .catch((error) => {
    console.error("Password migration failed:", error.message);
    process.exitCode = 1;
  })
  .finally(() => prisma.$disconnect());
