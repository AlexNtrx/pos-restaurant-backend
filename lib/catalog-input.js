const { positiveInteger } = require("./catalog-validation");
const { eurosToCents } = require("./money");

// Validates food-type fields before persistence.
const validateCategory = (body) => {
  const name = typeof body?.name === "string" ? body.name.trim() : "";
  const remark = typeof body?.remark === "string" ? body.remark.trim() : "";
  if (!name || name.length > 100)
    return { error: "Name must be 1-100 characters" };
  if (remark.length > 500)
    return { error: "Remark must be at most 500 characters" };
  return { name, remark };
};

const MAX_MONEY_ADDED = 10_000_000;

// Coordinates valid money behavior for this module.
const validMoney = (value) => {
  const parsed = eurosToCents(value);
  return parsed !== null && parsed <= BigInt(MAX_MONEY_ADDED) * 100n
    ? parsed
    : null;
};

// Validates size fields before persistence.
const validateSize = (body) => {
  const foodTypeId = positiveInteger(body?.foodTypeId);
  const name = typeof body?.name === "string" ? body.name.trim() : "";
  const remark = typeof body?.remark === "string" ? body.remark.trim() : "";
  const moneyAdded = validMoney(body?.moneyAdded);
  if (!foodTypeId) return { error: "foodTypeId must be a positive integer" };
  if (!name || name.length > 100)
    return { error: "Name must be 1-100 characters" };
  if (remark.length > 500)
    return { error: "Remark must be at most 500 characters" };
  if (moneyAdded === null)
    return {
      error:
        "moneyAdded must be EUR from 0 to 10000000 with at most two decimal places",
    };
  return { foodTypeId, name, remark, moneyAdded };
};

// Validates taste fields before persistence.
const validateTaste = (body) => {
  const foodTypeId = positiveInteger(body?.foodTypeId);
  const name = typeof body?.name === "string" ? body.name.trim() : "";
  const remark = typeof body?.remark === "string" ? body.remark.trim() : "";
  if (!foodTypeId) return { error: "foodTypeId must be a positive integer" };
  if (!name || name.length > 100)
    return { error: "Name must be 1-100 characters" };
  if (remark.length > 500)
    return { error: "Remark must be at most 500 characters" };
  return { foodTypeId, name, remark };
};

module.exports = { validateCategory, validateSize, validateTaste };
