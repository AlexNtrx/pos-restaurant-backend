// EN: Refuse traffic against legacy EUR storage; deployment must coordinate writers and the cents migration.
// FI: Hylkää liikenne vanhaan eurosäilöön; käyttöönoton on sovitettava kirjoittajat ja senttimigraatio yhteen.
const assertMoneyStorage = async (client) => {
  const rows = await client.$queryRawUnsafe(
    'SELECT "unit", "version" FROM "MoneyStorage" WHERE "id" = 1',
  );
  if (
    rows.length !== 1 ||
    rows[0].unit !== "EUR_CENTS" ||
    rows[0].version !== 1
  )
    throw new Error(
      "Incompatible money storage; apply the coordinated cents migration",
    );
};

module.exports = { assertMoneyStorage };
