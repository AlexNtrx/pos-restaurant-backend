const MAX_CENTS = 9_223_372_036_854_775_807n;
const MAX_API_CENTS = BigInt(Number.MAX_SAFE_INTEGER);

// EN: Parse decimal EUR text without rounding; request bodies and fingerprints continue to use EUR.
// FI: Jäsennä euromäärä desimaalitekstistä pyöristämättä; pyynnöt ja tunnisteet käyttävät edelleen euroja.
const eurosToCents = (value, { signed = false } = {}) => {
  if (typeof value !== "number" && typeof value !== "string") return null;
  if (typeof value === "number" && !Number.isFinite(value)) return null;
  const text = String(value).trim();
  if (text.length > 32) return null;
  const match = /^(\-?)(\d+)(?:\.(\d{1,2}))?$/.exec(text);
  if (!match || (!signed && match[1])) return null;
  const cents =
    (BigInt(match[2]) * 100n + BigInt((match[3] ?? "").padEnd(2, "0"))) *
    (match[1] ? -1n : 1n);
  if (cents < -MAX_API_CENTS || cents > MAX_API_CENTS) return null;
  const wire = /^(\-?)(\d+)(?:\.(\d{1,2}))?$/.exec(String(Number(text)));
  if (!wire) return null;
  const wireCents =
    (BigInt(wire[2]) * 100n + BigInt((wire[3] ?? "").padEnd(2, "0"))) *
    (wire[1] ? -1n : 1n);
  return wireCents === cents ? cents : null;
};

const isEuroAmount = (value, options) =>
  typeof value === "number" && eurosToCents(value, options) !== null;

// EN: Never emit a JSON EUR number that changes cents when read back, including large signed report totals.
// FI: Älä palauta JSON-euromäärää, jonka senttiarvo muuttuu uudelleen luettaessa, myöskään suurissa etumerkillisissä raporttisummissa.
const centsToEuros = (cents) => {
  if (
    typeof cents !== "bigint" ||
    cents < -MAX_API_CENTS ||
    cents > MAX_API_CENTS
  )
    throw new RangeError("Money is outside the supported cents range");
  const absolute = cents < 0n ? -cents : cents;
  const value = Number(
    `${cents < 0n ? "-" : ""}${absolute / 100n}.${String(absolute % 100n).padStart(2, "0")}`,
  );
  if (eurosToCents(value, { signed: true }) !== cents)
    throw new RangeError("Money cannot be represented exactly by the EUR API");
  return value;
};

const checkedCents = (cents) => {
  centsToEuros(cents);
  if (cents < 0n) throw new RangeError("Money must be non-negative");
  return cents;
};
const addCents = (...amounts) =>
  checkedCents(amounts.reduce((sum, amount) => sum + checkedCents(amount), 0n));
const multiplyCents = (amount, quantity) => {
  if (!Number.isSafeInteger(quantity) || quantity < 0)
    throw new RangeError("Invalid money quantity");
  return checkedCents(checkedCents(amount) * BigInt(quantity));
};

module.exports = {
  eurosToCents,
  centsToEuros,
  isEuroAmount,
  checkedCents,
  addCents,
  multiplyCents,
  MAX_CENTS,
};
