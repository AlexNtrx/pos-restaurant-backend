const prisma = require("./prisma");
const jwt = require("jsonwebtoken");
const { hashPassword, isPasswordHash, verifyPassword } = require("./password");
const { normalizeText } = require("./user-validation");
const { safeUserSelect, UserServiceError } = require("./user-service-shared");
const signIn = async (request) => {
  const username = normalizeText(request.body?.username);
  const password = request.body?.password;
  if (!username || typeof password !== "string" || password.length === 0) {
    throw new UserServiceError(400, {
      error: "Username and password are required",
    });
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
    throw new UserServiceError(401, undefined);
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
  return { token, name: user.name, id: user.id };
};
module.exports = { signIn };
