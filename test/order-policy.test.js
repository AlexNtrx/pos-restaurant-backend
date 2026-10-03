const { test } = require("node:test");
const assert = require("node:assert/strict");
const { authorizeTransition } = require("../lib/order-domain");
test("every staff role is blocked from cancellation after kitchen start", () => {
  for (const level of ["admin", "user", "waiter", "kitchen"])
    for (const currentStatus of [
      "PREPARING",
      "READY",
      "SERVED",
      "PAID",
      "COMPLETED",
      "CANCELLED",
    ])
      assert.throws(
        () =>
          authorizeTransition({
            actor: { type: "STAFF", userId: 1, level },
            currentStatus,
            nextStatus: "CANCELLED",
            reason: "Customer request",
          }),
        (e) => e.code === "ORDER_NOT_CANCELLABLE",
      );
});
