const { PrismaClient } = require("@prisma/client");

// Production modules share one connection pool for the process lifetime.
const prisma = new PrismaClient();

module.exports = prisma;
