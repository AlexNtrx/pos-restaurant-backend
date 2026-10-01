const { isIP } = require("node:net");

const isLoopback = (host) =>
  host === "localhost" ||
  host.endsWith(".localhost") ||
  host === "[::1]" ||
  host === "0.0.0.0" ||
  /^127\./.test(host);

const databaseUrl = (value, name) => {
  let url;
  try {
    url = new URL(value);
  } catch {
    throw new Error(`${name} must be a PostgreSQL connection URL.`);
  }
  if (
    !["postgres:", "postgresql:"].includes(url.protocol) ||
    !url.username ||
    !url.password ||
    url.pathname.length <= 1 ||
    url.hash
  ) {
    throw new Error(
      `${name} must include PostgreSQL credentials and a database.`,
    );
  }
  return url;
};

// EN: Production uses a pooled Neon runtime URL and a direct migration URL for the same database.
// FI: Tuotanto käyttää poolattua Neon-ajonaikaista URL:ia ja suoraa migraatio-URL:ia samaan tietokantaan.
const validateDatabaseEnvironment = (env = process.env) => {
  const runtime = databaseUrl(env.DATABASE_URL, "DATABASE_URL");
  if (env.NODE_ENV !== "production") {
    env.DIRECT_URL ||= env.DATABASE_URL;
    databaseUrl(env.DIRECT_URL, "DIRECT_URL");
    return;
  }
  const direct = databaseUrl(env.DIRECT_URL, "DIRECT_URL");
  for (const [name, url] of [
    ["DATABASE_URL", runtime],
    ["DIRECT_URL", direct],
  ]) {
    if (
      isLoopback(url.hostname) ||
      !url.hostname.endsWith(".neon.tech") ||
      url.searchParams.get("sslmode") !== "require" ||
      /(?:^|_)test(?:_|$)/i.test(decodeURIComponent(url.pathname.slice(1)))
    ) {
      throw new Error(
        `${name} must target production Neon with sslmode=require.`,
      );
    }
  }
  if (
    !runtime.hostname.includes("-pooler.") ||
    direct.hostname.includes("-pooler.") ||
    runtime.hostname.replace("-pooler.", ".") !== direct.hostname ||
    runtime.pathname !== direct.pathname ||
    runtime.port !== direct.port ||
    (runtime.searchParams.get("schema") || "public") !==
      (direct.searchParams.get("schema") || "public")
  ) {
    throw new Error(
      "DATABASE_URL and DIRECT_URL must target the same Neon database using pooled and direct hosts.",
    );
  }
  const limit = runtime.searchParams.get("connection_limit");
  if (!limit || !/^[1-9]\d*$/.test(limit)) {
    throw new Error(
      "DATABASE_URL requires an explicit positive connection_limit.",
    );
  }
};

const getCorsOrigins = (env = process.env) => {
  const origins = (env.CORS_ORIGINS || "")
    .split(",")
    .map((value) => value.trim())
    .filter(Boolean);
  if (env.NODE_ENV === "production" && origins.length === 0) {
    throw new Error("CORS_ORIGINS is required in production.");
  }
  for (const origin of origins) {
    let url;
    try {
      url = new URL(origin);
    } catch {
      throw new Error("CORS_ORIGINS must contain exact frontend origins.");
    }
    if (
      !["http:", "https:"].includes(url.protocol) ||
      url.origin !== origin ||
      url.username ||
      url.password ||
      (env.NODE_ENV === "production" &&
        (url.protocol !== "https:" ||
          isLoopback(url.hostname) ||
          isIP(url.hostname)))
    ) {
      throw new Error(
        "CORS_ORIGINS must contain exact HTTPS frontend origins in production.",
      );
    }
  }
  return origins;
};

const getPort = (env = process.env) => {
  const port = Number(env.PORT || 3001);
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    throw new Error("PORT must be an integer between 1 and 65535.");
  }
  return port;
};

const validateRuntimeEnvironment = (env = process.env) => {
  validateDatabaseEnvironment(env);
  getPort(env);
  getCorsOrigins(env);
  if (env.NODE_ENV === "production") {
    if (!env.SECRET_KEY || Buffer.byteLength(env.SECRET_KEY) < 32) {
      throw new Error("SECRET_KEY requires at least 32 bytes in production.");
    }
    if (
      !/^[a-f0-9]{64}$/i.test(env.QR_TOKEN_SECRET || "") ||
      env.QR_TOKEN_SECRET === env.SECRET_KEY
    ) {
      throw new Error(
        "QR_TOKEN_SECRET must be an independent 64-character hex secret.",
      );
    }
  }
};

module.exports = {
  getCorsOrigins,
  getPort,
  validateDatabaseEnvironment,
  validateRuntimeEnvironment,
};
