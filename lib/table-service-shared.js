const TERMINAL_ORDER_STATUSES = ["COMPLETED", "CANCELLED", "REJECTED"];

class TableError extends Error {
  constructor(status, code, message) {
    super(message);
    this.status = status;
    this.code = code;
  }
}

const positiveId = (value) => {
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed <= 0)
    throw new TableError(400, "INVALID_ID", "A positive ID is required");
  return parsed;
};

const knownConflict = (error) => {
  if (error instanceof TableError) return error;
  if (error?.code === "P2002" || error?.code === "P2034")
    return new TableError(
      409,
      "TABLE_CONFLICT",
      "Table or session changed; refresh and retry",
    );
  return error;
};

const withConflict = async (operation) => {
  try {
    return await operation();
  } catch (error) {
    throw knownConflict(error);
  }
};
module.exports = {
  TERMINAL_ORDER_STATUSES,
  TableError,
  positiveId,
  knownConflict,
  withConflict,
};
