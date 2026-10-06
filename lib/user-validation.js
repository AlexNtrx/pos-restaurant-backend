const validLevels = new Set(["admin", "kassa", "waiter", "kitchen"]);
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

module.exports = { positiveInteger, normalizeText, validateUserFields };
