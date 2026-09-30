// EN: Preserve the catalog endpoints' existing Number coercion, including numeric strings.
// FI: Säilytä luettelon päätepisteiden nykyinen Number-muunnos, myös numeromerkkijonoille.
const positiveInteger = (value) => {
  const parsed = Number(value);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : null;
};

// EN: Use the caller's client so transaction-scoped validation stays inside its transaction.
// FI: Käytä kutsujan asiakasta, jotta transaktion validointi pysyy samassa transaktiossa.
const activeCategoryExists = (client, id) =>
  client.foodType.findFirst({
    where: { id, status: "use" },
    select: { id: true },
  });

module.exports = { positiveInteger, activeCategoryExists };
