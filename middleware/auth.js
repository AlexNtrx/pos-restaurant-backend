const jwt = require("jsonwebtoken");
const prisma = require("../lib/prisma");

const ROLE_ADMIN = "admin";
const ROLE_USER = "user";
const ROLE_WAITER = "waiter";
const ROLE_KITCHEN = "kitchen";

// Loads token from request for the current workflow.
const getTokenFromRequest = (req) => {
  const authorizationHeader =
    req.headers.authorization || req.headers.Authorization;

  if (!authorizationHeader) return null;

  const parts = authorizationHeader.split(" ");
  if (parts.length === 2) {
    return parts[1];
  }

  if (authorizationHeader.toLowerCase().startsWith("bearer")) {
    return authorizationHeader.slice(6).trim();
  }

  return authorizationHeader;
};

// Enforces the existing authentication and session behavior.
const isAuthen = async (req, res, next) => {
  const token = getTokenFromRequest(req);

  if (!token) {
    return res.status(401).send({ error: "Unauthorized" });
  }

  let decoded;

  try {
    decoded = jwt.verify(token, process.env.SECRET_KEY);
  } catch (error) {
    return res.status(401).send({ error: "Unauthorized" });
  }

  const userId = Number(decoded.id);

  if (!Number.isInteger(userId) || userId <= 0) {
    return res.status(401).send({ error: "Unauthorized" });
  }

  try {
    const user = await prisma.user.findFirst({
      where: {
        id: userId,
        status: "use",
      },
      select: {
        id: true,
        name: true,
        level: true,
      },
    });

    if (
      !user ||
      ![ROLE_ADMIN, ROLE_USER, ROLE_WAITER, ROLE_KITCHEN].includes(user.level)
    ) {
      return res.status(401).send({ error: "Unauthorized" });
    }

    req.user = user;
    return next();
  } catch (error) {
    return res.status(500).send({ error: "Unable to verify session" });
  }
};

// Enforces allow roles ownership and authorization rules.
const allowRoles = (roles, errorMessage) => (req, res, next) => {
  if (!roles.includes(req.user.level)) {
    return res.status(403).send({
      error: errorMessage,
    });
  }

  return next();
};

const isAdmin = allowRoles([ROLE_ADMIN], "Only admin");
const isStaff = allowRoles([ROLE_ADMIN, ROLE_USER], "Forbidden");
const isServiceStaff = allowRoles(
  [ROLE_ADMIN, ROLE_USER, ROLE_WAITER],
  "Forbidden",
);

// EN: Kitchen can read Orders and prepare them without acquiring cashier or service permissions.
// FI: Keittiö voi lukea tilauksia ja valmistaa niitä saamatta kassan tai tarjoilijan oikeuksia.
const isOrderReader = allowRoles(
  [ROLE_ADMIN, ROLE_USER, ROLE_WAITER, ROLE_KITCHEN],
  "Forbidden",
);
const isKitchenStaff = allowRoles(
  [ROLE_ADMIN, ROLE_USER, ROLE_KITCHEN],
  "Forbidden",
);

module.exports = {
  isAdmin,
  isAuthen,
  isStaff,
  isServiceStaff,
  isOrderReader,
  isKitchenStaff,
};
