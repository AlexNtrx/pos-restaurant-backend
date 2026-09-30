const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

class OrderDomainError extends Error {
  constructor(status, code, message) {
    super(message);
    this.name = "OrderDomainError";
    this.status = status;
    this.code = code;
  }
}

const CAPABILITIES_BY_LEVEL = Object.freeze({
  kitchen: new Set(["ORDER_PREPARE", "ORDER_READY"]),
  waiter: new Set([
    "ORDER_CONFIRM",
    "ORDER_REJECT",
    "ORDER_SERVE",
    "ORDER_CANCEL",
  ]),
  user: new Set([
    "ORDER_CONFIRM",
    "ORDER_REJECT",
    "ORDER_PREPARE",
    "ORDER_READY",
    "ORDER_SERVE",
    "ORDER_CANCEL",
  ]),
  admin: new Set([
    "ORDER_CONFIRM",
    "ORDER_REJECT",
    "ORDER_PREPARE",
    "ORDER_READY",
    "ORDER_SERVE",
    "ORDER_CANCEL",
  ]),
});

const TRANSITION_CAPABILITY = Object.freeze({
  "SUBMITTED:CONFIRMED": "ORDER_CONFIRM",
  "SUBMITTED:REJECTED": "ORDER_REJECT",
  "SUBMITTED:CANCELLED": "ORDER_CANCEL",
  "CONFIRMED:PREPARING": "ORDER_PREPARE",
  "CONFIRMED:CANCELLED": "ORDER_CANCEL",
  "PREPARING:READY": "ORDER_READY",
  "PREPARING:CANCELLED": "ORDER_CANCEL",
  "READY:SERVED": "ORDER_SERVE",
  "READY:CANCELLED": "ORDER_CANCEL",
  "SERVED:CANCELLED": "ORDER_CANCEL",
  "PAID:COMPLETED": "SYSTEM_COMPLETE",
});

const STATUS_TIMESTAMP_FIELD = Object.freeze({
  CONFIRMED: "confirmedAt",
  REJECTED: "rejectedAt",
  PREPARING: "preparingAt",
  READY: "readyAt",
  SERVED: "servedAt",
  PAID: "paidAt",
  COMPLETED: "completedAt",
  CANCELLED: "cancelledAt",
});

const assertPositiveInteger = (value, field) => {
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new OrderDomainError(
      400,
      "INVALID_INPUT",
      `${field} must be a positive integer`,
    );
  }
  return value;
};

const assertIdempotencyKey = (value) => {
  if (typeof value !== "string" || !UUID_PATTERN.test(value)) {
    throw new OrderDomainError(
      400,
      "INVALID_IDEMPOTENCY_KEY",
      "idempotencyKey must be a UUID",
    );
  }
  return value.toLowerCase();
};

const normalizeReason = (value, required) => {
  const reason = typeof value === "string" ? value.trim() : "";
  if (required && (reason.length < 3 || reason.length > 500)) {
    throw new OrderDomainError(
      400,
      "INVALID_REASON",
      "reason must be 3-500 characters",
    );
  }
  return reason || null;
};

const assertStaffActor = (actor) => {
  if (
    actor?.type !== "STAFF" ||
    !Number.isSafeInteger(actor.userId) ||
    actor.userId <= 0 ||
    !CAPABILITIES_BY_LEVEL[actor.level]
  ) {
    throw new OrderDomainError(
      403,
      "FORBIDDEN",
      "Staff capability is required",
    );
  }
  return actor;
};

const authorizeTransition = ({ actor, currentStatus, nextStatus, reason }) => {
  const capability = TRANSITION_CAPABILITY[`${currentStatus}:${nextStatus}`];
  if (!capability) {
    throw new OrderDomainError(
      409,
      "INVALID_TRANSITION",
      `Cannot transition Order from ${currentStatus} to ${nextStatus}`,
    );
  }

  if (capability === "SYSTEM_COMPLETE") {
    if (actor?.type !== "SYSTEM") {
      throw new OrderDomainError(
        403,
        "FORBIDDEN",
        "System transition required",
      );
    }
  } else {
    assertStaffActor(actor);
    if (!CAPABILITIES_BY_LEVEL[actor.level].has(capability)) {
      throw new OrderDomainError(
        403,
        "FORBIDDEN",
        "Order capability is required",
      );
    }
    // EN: Waiters may cancel unpaid active orders except while the kitchen is preparing them.
    // FI: Tarjoilija saa perua maksamattoman aktiivisen tilauksen paitsi keittiön valmistelun aikana.
    if (
      actor.level === "waiter" &&
      nextStatus === "CANCELLED" &&
      currentStatus === "PREPARING"
    ) {
      throw new OrderDomainError(
        409,
        "ORDER_NOT_CANCELLABLE",
        "Waiters cannot cancel an Order while it is preparing",
      );
    }
  }

  return normalizeReason(
    reason,
    ["REJECTED", "CANCELLED"].includes(nextStatus),
  );
};

const actorHistoryData = (actor) => ({
  actorType: actor.type,
  actorUserId: actor.type === "STAFF" ? actor.userId : null,
});

module.exports = {
  OrderDomainError,
  STATUS_TIMESTAMP_FIELD,
  actorHistoryData,
  assertIdempotencyKey,
  assertPositiveInteger,
  assertStaffActor,
  authorizeTransition,
};
