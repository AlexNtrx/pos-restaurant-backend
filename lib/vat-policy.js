const { OrderDomainError } = require("./order-domain");

// EN: Opt-in demo configuration is versioned; captured rates survive catalog or runtime changes.
// FI: Valinnainen demokäytäntö on versioitu; tallennetut verokannat säilyvät luettelon tai ajonaikaisten muutosten jälkeen.
const DEMO_PROFILE = Object.freeze({
  profile: "FI_RESTAURANT_DEMO_V1",
  policy: "GROSS_GROUP_HALF_UP_V1",
  rates: Object.freeze({ FOOD_NON_ALCOHOLIC: 1350, ALCOHOL: 2550 }),
});
const isTaxCategory = (value) => Object.hasOwn(DEMO_PROFILE.rates, value);
const captureVat = (category) => {
  if (process.env.VAT_DEMO_ENABLED !== "true") return undefined;
  if (!isTaxCategory(category))
    throw new OrderDomainError(
      409,
      "VAT_CATEGORY_REQUIRED",
      "Tuotteen ALV-luokka puuttuu. Pyydä ylläpitäjää täydentämään se.",
    );
  return {
    profile: DEMO_PROFILE.profile,
    policy: DEMO_PROFILE.policy,
    category,
    rateBps: DEMO_PROFILE.rates[category],
  };
};

module.exports = { DEMO_PROFILE, isTaxCategory, captureVat };
