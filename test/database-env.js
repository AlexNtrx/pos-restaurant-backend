const path = require("node:path");
const dotenv = require("dotenv");

const TEST_DATABASE_NAME = "db_next_workshop_pos_test";
const DEVELOPMENT_DATABASE_NAME = "db_next_workshop_pos";

// EN: Tests never derive a remote database target from production settings, even if only its name changes.
// FI: Testit eivät koskaan johda etätietokannan kohdetta tuotantoasetuksista, vaikka vain nimi vaihtuisi.
const getDatabaseUrls = () => {
  if (process.env.NODE_ENV === "production") {
    throw new Error("Test tools cannot run in production.");
  }
  dotenv.config({ path: path.resolve(".env"), quiet: true });
  if (process.env.NODE_ENV === "production") {
    throw new Error("Test tools cannot run in production.");
  }
  dotenv.config({ path: path.resolve(".env.test"), quiet: true });
  if (process.env.NODE_ENV === "production") {
    throw new Error("Test tools cannot run in production.");
  }
  let testUrl;
  try {
    if (process.env.TEST_DATABASE_URL) {
      testUrl = new URL(process.env.TEST_DATABASE_URL);
    } else {
      testUrl = new URL(process.env.DATABASE_URL);
      const sourceName = decodeURIComponent(testUrl.pathname.slice(1));
      if (
        sourceName !== DEVELOPMENT_DATABASE_NAME &&
        !/^db_next_workshop_pos_test(?:_[a-z0-9_]+)?$/.test(sourceName)
      ) {
        throw new Error();
      }
      if (sourceName === DEVELOPMENT_DATABASE_NAME)
        testUrl.pathname = `/${TEST_DATABASE_NAME}`;
    }
  } catch {
    throw new Error(
      "Configure TEST_DATABASE_URL for a local disposable test database.",
    );
  }
  if (
    !["postgres:", "postgresql:"].includes(testUrl.protocol) ||
    !["localhost", "127.0.0.1", "[::1]"].includes(testUrl.hostname) ||
    !/^db_next_workshop_pos_test(?:_[a-z0-9_]+)?$/.test(
      decodeURIComponent(testUrl.pathname.slice(1)),
    ) ||
    (testUrl.searchParams.has("schema") &&
      testUrl.searchParams.get("schema") !== "public") ||
    testUrl.searchParams.has("host") ||
    testUrl.searchParams.has("options")
  ) {
    throw new Error(
      "Backend tests require a loopback disposable test database with the public schema.",
    );
  }
  return { testUrl };
};

const activateTestDatabase = () => {
  const { testUrl } = getDatabaseUrls();
  // EN: Override both Prisma URLs before loading clients or CLI commands so migrations cannot escape isolation.
  // FI: Korvaa molemmat Prisma-URL:t ennen asiakas- tai CLI-latausta, jotta migraatiot eivät pääse eristyksen ulkopuolelle.
  process.env.DATABASE_URL = testUrl.toString();
  process.env.DIRECT_URL = testUrl.toString();
  process.env.NODE_ENV = "test";
  delete process.env.CORS_ORIGINS;
  return testUrl;
};

module.exports = { TEST_DATABASE_NAME, activateTestDatabase, getDatabaseUrls };
