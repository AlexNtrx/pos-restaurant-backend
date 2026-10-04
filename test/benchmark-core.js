const { performance } = require("node:perf_hooks");

const TARGET = "db_next_workshop_pos_test_performance";

// EN: Benchmark writes require the exact approved target, independently of the general test bootstrap.
// FI: Kuormatestin kirjoitukset vaativat täsmälleen hyväksytyn kohteen yleisestä testialustuksesta riippumatta.
function assertTarget(value) {
  const url = new URL(value);
  if (
    !["postgres:", "postgresql:"].includes(url.protocol) ||
    url.hostname !== "127.0.0.1" ||
    url.port !== "55432" ||
    decodeURIComponent(url.pathname.slice(1)) !== TARGET ||
    [...url.searchParams.keys()].some(
      (key) => !["schema", "connection_limit", "pool_timeout"].includes(key),
    ) ||
    (url.searchParams.has("schema") &&
      url.searchParams.get("schema") !== "public")
  )
    throw new Error(
      "Benchmark requires the approved loopback disposable target",
    );
  return url;
}

function percentile(values, fraction) {
  if (!values.length) return null;
  const sorted = [...values].sort((a, b) => a - b);
  return +sorted[Math.ceil(sorted.length * fraction) - 1].toFixed(2);
}

// EN: Store only static operation labels and error categories; never serialize URLs, payloads or exception messages.
// FI: Tallenna vain kiinteät operaationimet ja virheluokat; älä sarjoita URL-osoitteita, sisältöjä tai poikkeusviestejä.
class Metrics {
  constructor() {
    this.rows = new Map();
  }
  async measure(label, operation) {
    const row = this.rows.get(label) ?? {
      times: [],
      bytes: 0,
      statuses: {},
      failures: {},
    };
    this.rows.set(label, row);
    const start = performance.now();
    try {
      const result = await operation();
      row.bytes += result?.bytes ?? 0;
      const status = result?.status ?? "ok";
      row.statuses[status] = (row.statuses[status] ?? 0) + 1;
      return result;
    } catch (error) {
      const category =
        error.name === "TimeoutError" || error.name === "AbortError"
          ? "timeout"
          : Number.isInteger(error.status)
            ? `HTTP_${error.status}`
            : "assertion-or-runtime";
      row.failures[category] = (row.failures[category] ?? 0) + 1;
      throw error;
    } finally {
      row.times.push(performance.now() - start);
    }
  }
  summary() {
    return [...this.rows].map(([name, row]) => ({
      name,
      count: row.times.length,
      p50Ms: percentile(row.times, 0.5),
      p95Ms: percentile(row.times, 0.95),
      maxMs: percentile(row.times, 1),
      decodedBodyBytes: row.bytes,
      statuses: row.statuses,
      failures: row.failures,
    }));
  }
}

// EN: Bound both elapsed time and operations; stop assigning work after failure while draining in-flight operations.
// FI: Rajaa sekä kesto että operaatiot; lopeta uuden työn jako virheen jälkeen ja odota käynnissä olevat operaatiot.
async function closedLoop({
  concurrency,
  durationMs,
  maxOperations,
  operation,
  signal,
}) {
  if (
    ![concurrency, durationMs, maxOperations].every(Number.isInteger) ||
    concurrency < 1 ||
    concurrency > 10 ||
    durationMs < 1 ||
    durationMs > 120_000 ||
    maxOperations < 1 ||
    maxOperations > 1000
  )
    throw new Error("Invalid bounded workload");
  const start = performance.now();
  let assigned = 0,
    completed = 0,
    failure;
  await Promise.all(
    Array.from({ length: concurrency }, async () => {
      while (
        !failure &&
        !signal?.aborted &&
        performance.now() - start < durationMs &&
        assigned < maxOperations
      ) {
        const index = assigned++;
        try {
          await operation(index);
          completed++;
        } catch (error) {
          failure ??= error;
        }
      }
    }),
  );
  if (failure) throw failure;
  return {
    assigned,
    completed,
    elapsedMs: +(performance.now() - start).toFixed(1),
  };
}

module.exports = { assertTarget, percentile, Metrics, closedLoop };
