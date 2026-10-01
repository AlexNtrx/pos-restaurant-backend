const { activateTestDatabase } = require("./database-env");

activateTestDatabase();

// EN: Test credentials are synthetic and never inherited from development or production.
// FI: Testitunnukset ovat keinotekoisia, eikä niitä peritä kehityksestä tai tuotannosta.
process.env.SECRET_KEY =
  "disposable-test-only-auth-key-do-not-use-in-production";

// EN: Disposable tests use a fixed domain-separated QR key; production must configure its own secret.
// FI: Kertakäyttöiset testit käyttävät kiinteää erillistä QR-avainta; tuotannon on määritettävä oma salaisuutensa.
process.env.QR_TOKEN_SECRET =
  "619e07a2f8323ef59150174d88ac1b2958776123227fb81332ab30cb67e70421";
