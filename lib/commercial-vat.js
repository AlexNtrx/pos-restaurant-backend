const { isDeepStrictEqual } = require("node:util");
const { checkedCents } = require("./money");
const {
  CommercialTaxError,
  ROUNDING_POLICY,
  validateCommercialContext,
} = require("./commercial-tax-policy");
const MAX_UNIT_LINES = 10000;
const invalid = (code, field) => {
  throw new CommercialTaxError(code, field);
};
const exactKeys = (value, keys, field) => {
  if (
    !value ||
    typeof value !== "object" ||
    Array.isArray(value) ||
    Object.keys(value).length !== keys.length ||
    keys.some((key) => !Object.hasOwn(value, key))
  )
    invalid("INVALID_COMMERCIAL_LINES", field);
};
const amount = (value, field) => {
  try {
    return checkedCents(value);
  } catch {
    return invalid("INVALID_COMMERCIAL_AMOUNT", field);
  }
};
const parseStoredAmount = (value, field) => {
  if (typeof value !== "string" || !/^(0|[1-9]\d{0,15})$/.test(value))
    invalid("INVALID_COMMERCIAL_SNAPSHOT", field);
  return amount(BigInt(value), field);
};
const verifyReferences = (lines) => {
  // EN: One reference must describe consistent policy terms and category rates; this checks consistency, not publication authenticity.
  // FI: Yhden viitteen on kuvattava yhtenäiset käytäntöehdot ja luokkakohtaiset verokannat; tämä tarkistaa johdonmukaisuuden, ei julkaisun aitoutta.
  const headers = new Map(),
    rates = new Map();
  for (const { context } of lines) {
    const { category, rateBps, taxPoint, ...header } = context;
    const key = context.policyRevisionId;
    const headerSignature = JSON.stringify(header),
      rateKey = `${key}:${category}`;
    if (
      (headers.has(key) && headers.get(key) !== headerSignature) ||
      (rates.has(rateKey) && rates.get(rateKey) !== rateBps)
    )
      invalid("COMMERCIAL_POLICY_REFERENCE_MISMATCH", "context");
    headers.set(key, headerSignature);
    rates.set(rateKey, rateBps);
  }
};
const registeredBreakdown = (lines) => {
  const groups = new Map(),
    taxes = Array(lines.length).fill(0n);
  lines.forEach((line, index) => {
    const { category, rateBps } = line.context;
    const key = `${category}:${rateBps}`;
    if (!groups.has(key)) groups.set(key, { category, rateBps, indexes: [] });
    groups.get(key).indexes.push(index);
  });
  const breakdown = [...groups.values()]
    .sort(
      (a, b) =>
        a.rateBps - b.rateBps ||
        (a.category < b.category ? -1 : a.category > b.category ? 1 : 0),
    )
    .map((group) => {
      const rate = BigInt(group.rateBps),
        divisor = 10000n + rate;
      const gross = group.indexes.reduce(
        (sum, i) => sum + lines[i].grossCents,
        0n,
      );
      const tax = (gross * rate * 2n + divisor) / (divisor * 2n);
      const units = group.indexes.map((index) => ({
        index,
        floor: (lines[index].grossCents * rate) / divisor,
        remainder: (lines[index].grossCents * rate) % divisor,
      }));
      let left = tax - units.reduce((sum, unit) => sum + unit.floor, 0n);
      // EN: Round the final bill/category/rate group once; retain each original revision/event while allocating stable per-unit cents.
      // FI: Pyöristä lopullinen lasku-, luokka- ja verokantaryhmä kerran; säilytä kunkin rivin alkuperäinen versio ja tapahtuma jakaessasi senttejä vakaasti.
      units.sort((a, b) =>
        a.remainder === b.remainder
          ? a.index - b.index
          : a.remainder > b.remainder
            ? -1
            : 1,
      );
      for (const unit of units) {
        taxes[unit.index] = unit.floor + (left > 0n ? 1n : 0n);
        if (left > 0n) left--;
      }
      return {
        category: group.category,
        rateBps: group.rateBps,
        grossCents: gross.toString(),
        netCents: (gross - tax).toString(),
        taxCents: tax.toString(),
      };
    });
  return { groups: breakdown, taxes };
};
// EN: Unit gross prices are immutable inputs; this pure calculator has no current-policy, payment, database or clock dependency.
// FI: Annoskohtaiset bruttohinnat ovat muuttumattomia syötteitä; tämä puhdas laskin ei riipu nykyisestä käytännöstä, maksuista, tietokannasta tai kellosta.
const finalizeCommercialVat = (values, total) => {
  if (
    !Array.isArray(values) ||
    !values.length ||
    values.length > MAX_UNIT_LINES
  )
    invalid("INVALID_COMMERCIAL_LINES", "lines");
  const gross = amount(total, "total");
  const lines = Array.from(values, (value, index) => {
    exactKeys(value, ["context", "grossCents"], `lines.${index}`);
    return {
      context: validateCommercialContext(value.context),
      grossCents: amount(value.grossCents, `lines.${index}.grossCents`),
    };
  });
  const sum = amount(
    lines.reduce((total, line) => total + line.grossCents, 0n),
    "lineSum",
  );
  if (sum !== gross) invalid("INVALID_COMMERCIAL_AMOUNT", "totalMismatch");
  const vatStatus = lines[0].context.vatStatus;
  if (lines.some((line) => line.context.vatStatus !== vatStatus))
    invalid("MIXED_COMMERCIAL_TREATMENT", "vatStatus");
  verifyReferences(lines);
  const registered = vatStatus === "REGISTERED";
  const { groups, taxes } = registered
    ? registeredBreakdown(lines)
    : { groups: [], taxes: null };
  const tax = registered ? taxes.reduce((sum, value) => sum + value, 0n) : null;
  // EN: Non-registration is an explicit treatment with absent VAT amounts, never a zero-rate or unknown legacy snapshot.
  // FI: Rekisteröimättömyys on nimenomainen käsittely puuttuvilla ALV-määrillä, ei nollaverokanta tai tuntematon vanha tallenne.
  return {
    schemaVersion: 1,
    mode: "COMMERCIAL",
    kind: "SALE",
    vatStatus,
    currency: "EUR",
    roundingPolicy: ROUNDING_POLICY,
    policyRevisionIds: [
      ...new Set(lines.map((line) => line.context.policyRevisionId)),
    ].sort((a, b) => a - b),
    grossCents: gross.toString(),
    netCents: registered ? (gross - tax).toString() : null,
    taxCents: registered ? tax.toString() : null,
    groups,
    lines: lines.map((line, index) => ({
      context: line.context,
      grossCents: line.grossCents.toString(),
      netCents: registered ? (line.grossCents - taxes[index]).toString() : null,
      taxCents: registered ? taxes[index].toString() : null,
    })),
  };
};
const validateCommercialSaleSnapshot = (snapshot) => {
  try {
    exactKeys(
      snapshot,
      [
        "schemaVersion",
        "mode",
        "kind",
        "vatStatus",
        "currency",
        "roundingPolicy",
        "policyRevisionIds",
        "grossCents",
        "netCents",
        "taxCents",
        "groups",
        "lines",
      ],
      "snapshot",
    );
    if (
      snapshot.kind !== "SALE" ||
      !Array.isArray(snapshot.lines) ||
      !snapshot.lines.length ||
      snapshot.lines.length > MAX_UNIT_LINES
    )
      invalid("INVALID_COMMERCIAL_SNAPSHOT", "kind/lines");
    const lines = Array.from(snapshot.lines, (line, index) => {
      exactKeys(
        line,
        ["context", "grossCents", "netCents", "taxCents"],
        `lines.${index}`,
      );
      return {
        context: line.context,
        grossCents: parseStoredAmount(
          line.grossCents,
          `lines.${index}.grossCents`,
        ),
      };
    });
    const validated = finalizeCommercialVat(
      lines,
      parseStoredAmount(snapshot.grossCents, "grossCents"),
    );
    // EN: Reconcile the original stored snapshot internally; never reconstruct a refund using today's catalog or policy.
    // FI: Täsmäytä alkuperäinen tallenne sisäisesti; älä koskaan muodosta palautusta nykyisen valikon tai käytännön avulla.
    if (!isDeepStrictEqual(snapshot, validated))
      invalid("INVALID_COMMERCIAL_SNAPSHOT", "reconciliation");
    return validated;
  } catch {
    return invalid("INVALID_COMMERCIAL_SNAPSHOT", "snapshot");
  }
};
const refundCommercialVat = (snapshot) => {
  // EN: A full refund retains original context and absent VAT fields; a refund snapshot cannot be inverted into another sale.
  // FI: Täysi palautus säilyttää alkuperäisen kontekstin ja puuttuvat ALV-kentät; palautustallennetta ei voi kääntää toiseksi myynniksi.
  const original = validateCommercialSaleSnapshot(snapshot);
  const negate = (value) =>
    value === null ? null : (-BigInt(value)).toString();
  const negateAmounts = (value) => ({
    ...value,
    grossCents: negate(value.grossCents),
    netCents: negate(value.netCents),
    taxCents: negate(value.taxCents),
  });
  return {
    ...negateAmounts(original),
    kind: "FULL_REFUND",
    groups: original.groups.map(negateAmounts),
    lines: original.lines.map(negateAmounts),
  };
};
module.exports = {
  finalizeCommercialVat,
  validateCommercialSaleSnapshot,
  refundCommercialVat,
};
