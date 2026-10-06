const { Prisma } = require("@prisma/client");
const prisma = require("./prisma");
const { hashPassword, passwordValidationError } = require("./password");
const { positiveInteger, validateUserFields } = require("./user-validation");
const { safeUserSelect, UserServiceError } = require("./user-service-shared");
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

// EN: The last active admin cannot lose the admin role; callers perform this check within their write transaction.
// FI: Viimeinen aktiivinen ylläpitäjä ei voi menettää rooliaan; kutsujat tarkistavat tämän kirjoitustransaktiossa.
const ensureAdminRemains = async (client, user, nextLevel = user.level) => {
  if (user.level !== "admin" || nextLevel === "admin") return null;

  const activeAdminCount = await client.user.count({
    where: { status: "use", level: "admin" },
  });
  return activeAdminCount <= 1 ? "At least one active admin is required" : null;
};

const create = async (request) => {
  const fields = validateUserFields(request.body || {});
  const passwordError = passwordValidationError(request.body?.password);
  if (fields.error || passwordError)
    throw new UserServiceError(400, { error: fields.error || passwordError });

  const duplicate = await activeUsernameExists(prisma, fields.username);
  if (duplicate)
    throw new UserServiceError(409, { error: "Username is already in use" });

  await prisma.user.create({
    data: { ...fields, password: await hashPassword(request.body.password) },
  });
  return { message: "success" };
};
const list = async (request) => {
  const users = await prisma.user.findMany({
    select: safeUserSelect,
    where: { status: "use" },
    orderBy: { id: "asc" },
  });
  return { results: users };
};
const update = async (request) => {
  const id = positiveInteger(request.body?.id);
  const fields = validateUserFields(request.body || {});
  const submittedPassword = request.body?.password;
  const passwordError =
    submittedPassword === undefined || submittedPassword === ""
      ? null
      : passwordValidationError(submittedPassword);
  if (!id || fields.error || passwordError) {
    throw new UserServiceError(400, {
      error: !id ? "Valid user id is required" : fields.error || passwordError,
    });
  }

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
    throw new UserServiceError(result.status, { error: result.error });
  return { message: "success" };
};
const remove = async (request) => {
  const id = positiveInteger(request.params.id);
  if (!id)
    throw new UserServiceError(400, { error: "Valid user id is required" });
  if (id === request.user.id)
    throw new UserServiceError(400, {
      error: "You cannot delete your own account",
    });

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
    throw new UserServiceError(result.status, { error: result.error });
  return { message: "success" };
};
module.exports = { create, list, update, remove };
