const { PrismaClient } = require("@prisma/client");

// EN: All API modules share one pool per process; disconnect only during server shutdown.
// FI: Kaikki API-moduulit jakavat yhden poolin prosessissa; sulje se vain palvelimen sammutuksessa.
const prisma = new PrismaClient();

module.exports = prisma;
