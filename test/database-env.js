const path = require("node:path");
const dotenv = require("dotenv");

const TEST_DATABASE_NAME = "db_next_workshop_pos_test";
const DEVELOPMENT_DATABASE_NAME = "db_next_workshop_pos";

const loadConfiguredDatabaseUrl = () => {
  const envResult = dotenv.config({ path: path.resolve(".env"), quiet: true });
  if (envResult.error) {
    throw new Error("Test database setup requires the local .env settings.");
  }

  const sourceDatabaseUrl = process.env.DATABASE_URL;
  if (!sourceDatabaseUrl) {
    throw new Error("Test database setup requires DATABASE_URL.");
  }

  return new URL(sourceDatabaseUrl);
};

const getDatabaseUrls = () => {
  const sourceUrl = loadConfiguredDatabaseUrl();

  const sourceDatabaseName = decodeURIComponent(sourceUrl.pathname.slice(1));

  if (!sourceDatabaseName || sourceDatabaseName === TEST_DATABASE_NAME) {
    throw new Error(
      "DATABASE_URL must identify the normal development database before the test-only database name is applied.",
    );
  }

  const testUrl = new URL(sourceUrl);
  testUrl.pathname = `/${TEST_DATABASE_NAME}`;

  return { sourceUrl, testUrl };
};

const activateTestDatabase = () => {
  const configuredUrl = loadConfiguredDatabaseUrl();
  const configuredDatabaseName = decodeURIComponent(
    configuredUrl.pathname.slice(1),
  );

  // EN: Node test workers inherit the already-safe URL and may preload this guard more than once.
  // FI: Node-testityöntekijät perivät jo turvallisen URL-osoitteen ja voivat ladata tämän suojauksen useammin kuin kerran.
  if (configuredDatabaseName === TEST_DATABASE_NAME) {
    process.env.NODE_ENV = "test";
    return configuredUrl;
  }

  const { testUrl } = getDatabaseUrls();

  // EN: Tests replace the source database name before Prisma is loaded, so fixtures cannot reach development data.
  // FI: Testit korvaavat lähdetietokannan nimen ennen Prisman lataamista, joten testidata ei voi päätyä kehitystietokantaan.
  process.env.DATABASE_URL = testUrl.toString();
  process.env.NODE_ENV = "test";

  const activeDatabaseName = decodeURIComponent(
    new URL(process.env.DATABASE_URL).pathname.slice(1),
  );
  if (
    activeDatabaseName !== TEST_DATABASE_NAME ||
    activeDatabaseName === DEVELOPMENT_DATABASE_NAME
  ) {
    throw new Error("Backend tests refused a non-disposable database target.");
  }

  return testUrl;
};

module.exports = {
  TEST_DATABASE_NAME,
  activateTestDatabase,
  getDatabaseUrls,
};
