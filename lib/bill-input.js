const dayjs = require("dayjs");
const utc = require("dayjs/plugin/utc");
const timezone = require("dayjs/plugin/timezone");
const BUSINESS_TIME_ZONE = "Europe/Helsinki";
dayjs.extend(utc);
dayjs.extend(timezone);

// Coordinates positive integer behavior for this module.
const positiveInteger = (value) => {
  const parsed = Number(value);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : null;
};

// Parses and validates date only responses.
const parseDateOnly = (value, fieldName) => {
  if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(value))
    return { error: `${fieldName} must be YYYY-MM-DD` };
  const [year, month, day] = value.split("-").map(Number);
  const validationDate = new Date(Date.UTC(year, month - 1, day));
  if (
    validationDate.getUTCFullYear() !== year ||
    validationDate.getUTCMonth() !== month - 1 ||
    validationDate.getUTCDate() !== day
  )
    return { error: `${fieldName} is invalid` };
  return {
    date: dayjs
      .tz(value, "YYYY-MM-DD", BUSINESS_TIME_ZONE)
      .startOf("day")
      .toDate(),
  };
};

// Coordinates cancellation reason behavior for this module.
const cancellationReason = (value) => {
  const reason = typeof value === "string" ? value.trim() : "";
  return reason.length >= 3 && reason.length <= 500 ? reason : null;
};

module.exports = {
  BUSINESS_TIME_ZONE,
  parseDateOnly,
  positiveInteger,
  cancellationReason,
};
