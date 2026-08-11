const {
  randomBytes,
  scrypt: scryptCallback,
  timingSafeEqual,
} = require("crypto");
const { promisify } = require("util");

const scrypt = promisify(scryptCallback);
const PASSWORD_PREFIX = "scrypt$";
const MIN_PASSWORD_LENGTH = 8;
const MAX_PASSWORD_LENGTH = 128;

// Coordinates password validation error behavior for this module.
const passwordValidationError = (password) => {
  if (typeof password !== "string") return "Password is required";
  if (
    password.length < MIN_PASSWORD_LENGTH ||
    password.length > MAX_PASSWORD_LENGTH
  ) {
    return `Password must be ${MIN_PASSWORD_LENGTH}-${MAX_PASSWORD_LENGTH} characters`;
  }
  return null;
};

// Validates is password hash before it is used.
const isPasswordHash = (value) =>
  typeof value === "string" && value.startsWith(PASSWORD_PREFIX);

// Coordinates hash password behavior for this module.
const hashPassword = async (password) => {
  const salt = randomBytes(16);
  const derivedKey = await scrypt(password, salt, 64);
  return `${PASSWORD_PREFIX}${salt.toString("base64")}$${Buffer.from(derivedKey).toString("base64")}`;
};

// Coordinates verify password behavior for this module.
const verifyPassword = async (password, storedPassword) => {
  if (typeof password !== "string" || typeof storedPassword !== "string")
    return false;

  if (!isPasswordHash(storedPassword)) {
    const provided = Buffer.from(password);
    const stored = Buffer.from(storedPassword);
    return (
      provided.length === stored.length && timingSafeEqual(provided, stored)
    );
  }

  const [, saltEncoded, hashEncoded] = storedPassword.split("$");
  if (!saltEncoded || !hashEncoded) return false;

  try {
    const storedHash = Buffer.from(hashEncoded, "base64");
    const derivedKey = await scrypt(
      password,
      Buffer.from(saltEncoded, "base64"),
      storedHash.length,
    );
    return (
      Buffer.from(derivedKey).length === storedHash.length &&
      timingSafeEqual(Buffer.from(derivedKey), storedHash)
    );
  } catch {
    return false;
  }
};

module.exports = {
  hashPassword,
  isPasswordHash,
  passwordValidationError,
  verifyPassword,
};
