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
