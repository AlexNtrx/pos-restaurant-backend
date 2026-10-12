const { addCents } = require("./money");
const { DEMO_PROFILE } = require("./vat-policy");

const validContext = (value) =>
  value?.profile === DEMO_PROFILE.profile &&
  value.policy === DEMO_PROFILE.policy &&
  Object.hasOwn(DEMO_PROFILE.rates, value.category) &&
  Number.isSafeInteger(value.rateBps) &&
  value.rateBps > 0 &&
  value.rateBps <= 10000;

// EN: Round once per final bill/rate, then allocate cents by largest remainder with stable unit-order ties.
// FI: Pyöristä kerran lopullista laskua ja verokantaa kohti, sitten jaa sentit suurimman jäännöksen mukaan vakaassa annosjärjestyksessä.
const finalizeBillVat = (lines, amount) => {
  const gross = lines.map((line) => addCents(line.price, line.moneyAdded));
  if (gross.reduce((sum, value) => addCents(sum, value), 0n) !== amount)
    throw new RangeError("Bill lines and gross total differ");
  // EN: Old or mixed unknown snapshots stay unknown; never reprice from today's catalog or show a partial tax total.
  // FI: Vanhat tai osittain tuntemattomat tallenteet pysyvät tuntemattomina; älä hinnoittele nykyisestä luettelosta tai näytä osittaista verosummaa.
  if (!lines.length || lines.some((line) => !validContext(line.vatSnapshot)))
    return {
      lines: lines.map(({ vatSnapshot, ...line }) => line),
      vatData: {},
    };
  const groups = new Map();
  lines.forEach((line, index) => {
    const { category, rateBps } = line.vatSnapshot;
    const key = `${category}:${rateBps}`;
    if (!groups.has(key)) groups.set(key, { category, rateBps, indexes: [] });
    groups.get(key).indexes.push(index);
  });
  const taxByUnit = new Map();
  const breakdown = [...groups.values()]
    .sort(
      (a, b) => a.rateBps - b.rateBps || a.category.localeCompare(b.category),
    )
    .map((group) => {
      const rate = BigInt(group.rateBps);
      const divisor = 10000n + rate;
      const groupGross = group.indexes.reduce(
        (sum, index) => addCents(sum, gross[index]),
        0n,
      );
      const tax = (groupGross * rate * 2n + divisor) / (divisor * 2n);
      const units = group.indexes.map((index) => ({
        index,
        floor: (gross[index] * rate) / divisor,
        remainder: (gross[index] * rate) % divisor,
      }));
      let left = tax - units.reduce((sum, unit) => sum + unit.floor, 0n);
      units.sort((a, b) =>
        a.remainder === b.remainder
          ? a.index - b.index
          : a.remainder > b.remainder
            ? -1
            : 1,
      );
      for (const unit of units) {
        taxByUnit.set(unit.index, unit.floor + (left > 0n ? 1n : 0n));
        if (left > 0n) left -= 1n;
      }
      return {
        category: group.category,
        rateBps: group.rateBps,
        grossCents: groupGross.toString(),
        netCents: (groupGross - tax).toString(),
        taxCents: tax.toString(),
      };
    });
  const tax = breakdown.reduce(
    (sum, group) => sum + BigInt(group.taxCents),
    0n,
  );
  const vatSnapshot = {
    profile: lines[0].vatSnapshot.profile,
    policy: lines[0].vatSnapshot.policy,
    currency: "EUR",
    grossCents: amount.toString(),
    netCents: (amount - tax).toString(),
    taxCents: tax.toString(),
    groups: breakdown,
  };
  return {
    vatData: { vatSnapshot },
    lines: lines.map((line, index) => ({
      ...line,
      vatSnapshot: {
        ...line.vatSnapshot,
        grossCents: gross[index].toString(),
        netCents: (gross[index] - taxByUnit.get(index)).toString(),
        taxCents: taxByUnit.get(index).toString(),
      },
    })),
  };
};

// EN: A full refund negates original tax snapshots; only COMPLETED refunds count as money returned.
// FI: Täysi palautus kääntää alkuperäiset verotallenteet negatiivisiksi; vain COMPLETED-palautukset lasketaan palautetuksi rahaksi.
const refundVat = (snapshot) => {
  if (!snapshot) return {};
  const negate = (value) => ({
    ...value,
    grossCents: (-BigInt(value.grossCents)).toString(),
    netCents: (-BigInt(value.netCents)).toString(),
    taxCents: (-BigInt(value.taxCents)).toString(),
  });
  return {
    vatSnapshot: { ...negate(snapshot), groups: snapshot.groups.map(negate) },
  };
};

module.exports = { finalizeBillVat, refundVat };
