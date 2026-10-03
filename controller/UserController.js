const { Prisma } = require("@prisma/client");
const prisma = require("../lib/prisma");
const jwt = require("jsonwebtoken");
const dotenv = require("dotenv");
const {
  hashPassword,
  isPasswordHash,
  passwordValidationError,
  verifyPassword,
} = require("../lib/password");

dotenv.config();

const validLevels = new Set(["admin", "kassa", "waiter", "kitchen"]);
const safeUserSelect = { id: true, name: true, username: true, level: true };

// Coordinates positive integer behavior for this module.
const positiveInteger = (value) => {
  const parsed = Number(value);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : null;
};

// Coordinates normalize text behavior for this module.
const normalizeText = (value) =>
  typeof value === "string" ? value.trim() : "";

// Validates user fields before persistence.
const validateUserFields = ({ name, username, level }) => {
  const normalizedName = normalizeText(name);
  const normalizedUsername = normalizeText(username);

  if (!validLevels.has(level)) return { error: "Invalid user level" };
  if (!normalizedName || normalizedName.length > 100) {
    return { error: "Name must be 1-100 characters" };
  }
  if (!normalizedUsername || normalizedUsername.length > 64) {
    return { error: "Username must be 1-64 characters" };
  }

  return { name: normalizedName, username: normalizedUsername, level };
};

// Coordinates active username exists behavior for this module.
const activeUsernameExists = (client, username, excludeId) =>
  client.user.findFirst({
    where: {
      username,
      status: "use",
      ...(excludeId ? { id: { not: excludeId } } : {}),
    },
    select: { id: true },
  });

// Coordinates ensure admin remains behavior for this module.
const ensureAdminRemains = async (client, user, nextLevel = user.level) => {
  if (user.level !== "admin" || nextLevel === "admin") return null;

  const activeAdminCount = await client.user.count({
    where: { status: "use", level: "admin" },
  });
  return activeAdminCount <= 1 ? "At least one active admin is required" : null;
};

// Coordinates send known error behavior for this module.
const sendKnownError = (res, error) => {
  if (error?.code === "P2002") {
    res.status(409).send({ error: "Username is already in use" });
    return true;
  }
  if (error?.code === "P2025") {
    res.status(404).send({ error: "User not found" });
    return true;
  }
  if (error?.code === "P2034") {
    res.status(409).send({ error: "Account change conflicted; try again" });
    return true;
  }
  return false;
};

module.exports = {
  // Enforces the existing authentication and session behavior.
  signIn: async (req, res) => {
    try {
      const username = normalizeText(req.body?.username);
      const password = req.body?.password;
      if (!username || typeof password !== "string" || password.length === 0) {
        return res
          .status(400)
          .send({ error: "Username and password are required" });
      }

      const user = await prisma.user.findFirst({
        where: {
          username,
          status: "use",
          level: { in: ["admin", "kassa", "waiter", "kitchen"] },
        },
        select: { ...safeUserSelect, password: true },
      });
      if (!user || !(await verifyPassword(password, user.password))) {
        return res.status(401).send();
      }

      if (!isPasswordHash(user.password)) {
        await prisma.user.update({
          where: { id: user.id },
          data: { password: await hashPassword(password) },
        });
      }

      const token = jwt.sign(
        { id: user.id, name: user.name, level: user.level },
        process.env.SECRET_KEY,
        { expiresIn: "30d" },
      );
      return res.send({ token, name: user.name, id: user.id });
    } catch (error) {
      return res.status(500).send({ error: "Unable to sign in" });
    }
  },

  // Creates  with the current contract.
  create: async (req, res) => {
    const fields = validateUserFields(req.body || {});
    const passwordError = passwordValidationError(req.body?.password);
    if (fields.error || passwordError)
      return res.status(400).send({ error: fields.error || passwordError });

    try {
      const duplicate = await activeUsernameExists(prisma, fields.username);
      if (duplicate)
        return res.status(409).send({ error: "Username is already in use" });

      await prisma.user.create({
        data: { ...fields, password: await hashPassword(req.body.password) },
      });
      return res.status(201).send({ message: "success" });
    } catch (error) {
      if (sendKnownError(res, error)) return;
      return res.status(500).send({ error: "Unable to create user" });
    }
  },

  // Coordinates list behavior for this module.
  list: async (_req, res) => {
    try {
      const users = await prisma.user.findMany({
        select: safeUserSelect,
        where: { status: "use" },
        orderBy: { id: "asc" },
      });
      return res.send({ results: users });
    } catch {
      return res.status(500).send({ error: "Unable to list users" });
    }
  },

  // Updates  without changing user-visible behavior.
  update: async (req, res) => {
    const id = positiveInteger(req.body?.id);
    const fields = validateUserFields(req.body || {});
    const submittedPassword = req.body?.password;
    const passwordError =
      submittedPassword === undefined || submittedPassword === ""
        ? null
        : passwordValidationError(submittedPassword);
    if (!id || fields.error || passwordError) {
      return res.status(400).send({
        error: !id
          ? "Valid user id is required"
          : fields.error || passwordError,
      });
    }

    try {
      const result = await prisma.$transaction(
        async (tx) => {
          const user = await tx.user.findFirst({
            where: { id, status: "use" },
            select: safeUserSelect,
          });
          if (!user) return { error: "User not found", status: 404 };

          const duplicate = await activeUsernameExists(tx, fields.username, id);
          if (duplicate)
            return { error: "Username is already in use", status: 409 };

          const adminError = await ensureAdminRemains(tx, user, fields.level);
          if (adminError) return { error: adminError, status: 409 };

          const data = { ...fields };
          if (submittedPassword !== undefined && submittedPassword !== "") {
            data.password = await hashPassword(submittedPassword);
          }
          await tx.user.update({ where: { id }, data });
          return null;
        },
        { isolationLevel: Prisma.TransactionIsolationLevel.Serializable },
      );
      if (result)
        return res.status(result.status).send({ error: result.error });
      return res.send({ message: "success" });
    } catch (error) {
      if (sendKnownError(res, error)) return;
      return res.status(500).send({ error: "Unable to update user" });
    }
  },

  // Removes or clears  using the existing workflow.
  remove: async (req, res) => {
    const id = positiveInteger(req.params.id);
    if (!id)
      return res.status(400).send({ error: "Valid user id is required" });
    if (id === req.user.id)
      return res
        .status(400)
        .send({ error: "You cannot delete your own account" });

    try {
      const result = await prisma.$transaction(
        async (tx) => {
          const user = await tx.user.findFirst({
            where: { id, status: "use" },
            select: safeUserSelect,
          });
          if (!user) return { error: "User not found", status: 404 };

          const adminError = await ensureAdminRemains(tx, user, "delete");
          if (adminError) return { error: adminError, status: 409 };

          await tx.user.update({ where: { id }, data: { status: "delete" } });
          return null;
        },
        { isolationLevel: Prisma.TransactionIsolationLevel.Serializable },
      );
      if (result)
        return res.status(result.status).send({ error: result.error });
      return res.send({ message: "success" });
    } catch (error) {
      if (sendKnownError(res, error)) return;
      return res.status(500).send({ error: "Unable to remove user" });
    }
  },

  // Loads level by token for the current workflow.
  getLevelByToken: async (req, res) => res.send({ level: req.user.level }),
};
