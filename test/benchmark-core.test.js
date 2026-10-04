const { test } = require("node:test");
const assert = require("node:assert/strict");
const {
  assertTarget,
  percentile,
  Metrics,
  closedLoop,
} = require("./benchmark-core");

test("load writes reject remote, wrong database/port and connection overrides", () => {
  const target =
    "postgresql://test:secret@127.0.0.1:55432/db_next_workshop_pos_test_performance";
  assertTarget(target + "?connection_limit=10&schema=public");
  for (const value of [
    target.replace("127.0.0.1", "localhost"),
    target.replace("55432", "5432"),
    target.replace("_performance", ""),
    target + "?host=remote",
    target + "?options=x",
    target + "?schema=private",
  ]) {
    assert.throws(() => assertTarget(value));
  }
});

test("percentiles include tails and empty samples remain unavailable", () => {
  assert.equal(percentile([], 0.95), null);
  assert.equal(percentile([10, 1, 20, 2], 0.95), 20);
  assert.equal(percentile([10, 1, 20, 2], 0.5), 2);
});

test("deadline stops assigning work while the last operation drains", async () => {
  const result = await closedLoop({
    concurrency: 1,
    durationMs: 10,
    maxOperations: 1000,
    operation: async () => {
      await new Promise((resolve) => setTimeout(resolve, 30));
    },
  });
  assert.equal(result.assigned, 1);
  assert.equal(result.completed, 1);
});

test("maximum soak budget stays bounded and respects cancellation", async () => {
  const controller = new AbortController();
  controller.abort();
  const result = await closedLoop({
    concurrency: 2,
    durationMs: 600000,
    maxOperations: 10000,
    signal: controller.signal,
    operation: async () => assert.fail("Must not run"),
  });
  assert.equal(result.assigned, 0);
});

test("invalid load budgets reject before executing work", async () => {
  for (const overrides of [
    { concurrency: 11 },
    { concurrency: 0 },
    { durationMs: 600001 },
    { maxOperations: 10001 },
  ]) {
    await assert.rejects(
      closedLoop({
        concurrency: 1,
        durationMs: 10,
        maxOperations: 1,
        operation: async () => assert.fail("Must not run"),
        ...overrides,
      }),
    );
  }
});

test("bounded workers do not exceed concurrency or operation cap", async () => {
  let active = 0,
    peak = 0;
  const result = await closedLoop({
    concurrency: 3,
    durationMs: 1000,
    maxOperations: 17,
    operation: async () => {
      peak = Math.max(peak, ++active);
      await new Promise((r) => setTimeout(r, 2));
      active--;
    },
  });
  assert.equal(result.completed, 17);
  assert.equal(peak, 3);
});

test("failure drains workers and prevents new writes; cancellation stops work", async () => {
  let assigned = 0;
  await assert.rejects(
    closedLoop({
      concurrency: 2,
      durationMs: 1000,
      maxOperations: 100,
      operation: async () => {
        assigned++;
        throw new Error("private-token");
      },
    }),
  );
  assert.equal(assigned, 2);
  const controller = new AbortController();
  controller.abort();
  assert.equal(
    (
      await closedLoop({
        concurrency: 2,
        durationMs: 1000,
        maxOperations: 100,
        operation: async () => {},
        signal: controller.signal,
      })
    ).completed,
    0,
  );
});

test("metrics count failed latency without leaking exception messages or request bodies", async () => {
  const metrics = new Metrics();
  await metrics.measure("catalog", async () => ({ status: 200, bytes: 42 }));
  await assert.rejects(
    metrics.measure("catalog", async () => {
      throw Object.assign(new Error("secret-qr-url"), { status: 503 });
    }),
  );
  const [row] = metrics.summary();
  assert.equal(row.count, 2);
  assert.equal(row.decodedBodyBytes, 42);
  assert.equal(row.failures.HTTP_503, 1);
  assert.ok(!JSON.stringify(row).includes("secret-qr-url"));
});
