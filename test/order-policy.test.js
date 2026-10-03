const { test } = require("node:test");
const assert = require("node:assert/strict");
const { authorizeTransition } = require("../lib/order-domain");
test("every staff role is blocked from cancellation after kitchen start", () => {
  for (const level of ["admin", "kassa", "waiter", "kitchen"])
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
test("kassa retains serving and early cancellation but no kitchen mutations or legacy role", () => {
  const actor = { type: "STAFF", userId: 1, level: "kassa" };
  for (const currentStatus of ["SUBMITTED", "CONFIRMED"])
    assert.equal(
      authorizeTransition({
        actor,
        currentStatus,
        nextStatus: "CANCELLED",
        reason: "Customer request",
      }),
      "Customer request",
    );
  assert.equal(
    authorizeTransition({
      actor,
      currentStatus: "READY",
      nextStatus: "SERVED",
    }),
    null,
  );
  for (const [currentStatus, nextStatus] of [
    ["CONFIRMED", "PREPARING"],
    ["PREPARING", "READY"],
  ])
    assert.throws(
      () => authorizeTransition({ actor, currentStatus, nextStatus }),
      (e) => e.code === "FORBIDDEN",
    );
  assert.throws(
    () =>
      authorizeTransition({
        actor: { ...actor, level: "user" },
        currentStatus: "READY",
        nextStatus: "SERVED",
      }),
    (e) => e.code === "FORBIDDEN",
  );
});
