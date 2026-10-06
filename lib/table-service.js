const {
  TableError,
  positiveId,
  withConflict,
  TERMINAL_ORDER_STATUSES,
} = require("./table-service-shared");
const {
  listTables,
  createTable,
  updateTable,
  deleteTable,
} = require("./table-admin-service");
const {
  createHash,
  createHmac,
  randomBytes,
  timingSafeEqual,
} = require("node:crypto");
const { Prisma } = require("@prisma/client");

const TOKEN_LIFETIME_MS = 24 * 60 * 60 * 1000;
const TOKEN_PATTERN = /^[A-Za-z0-9_-]{43}$/;

const expectedTokenVersion = (value) => {
  if (!Number.isSafeInteger(value) || value < 0)
    throw new TableError(
      400,
      "INVALID_TOKEN_VERSION",
      "A nonnegative token version is required",
    );
  return value;
};

const tokenHash = (token) => createHash("sha256").update(token).digest("hex");
// EN: A stable, separate key is required so staff can reconstruct the same QR; never fall back to another application secret.
// FI: Vakaa erillinen avain vaaditaan saman QR:n palauttamiseen; muuta sovelluksen salaisuutta ei käytetä varalla.
const qrKey = () => {
  const secret = process.env.QR_TOKEN_SECRET;
  if (typeof secret !== "string" || !/^[a-fA-F0-9]{64}$/.test(secret))
    throw new TableError(
      503,
      "QR_KEY_UNAVAILABLE",
      "QR token key is unavailable",
    );
  return Buffer.from(secret, "hex");
};

const deriveToken = (key, sessionId, version, nonce) =>
  createHmac("sha256", key)
    .update(`qr01:${sessionId}:${version}:${nonce}`)
    .digest("base64url");

const createAccess = (key, sessionId, version) => {
  const qrTokenNonce = randomBytes(32).toString("hex");
  const token = deriveToken(key, sessionId, version, qrTokenNonce);
  return {
    token,
    qrTokenHash: tokenHash(token),
    qrTokenNonce,
    qrTokenExpiresAt: new Date(Date.now() + TOKEN_LIFETIME_MS),
  };
};

// EN: A missing singleton is fail-closed so QR never becomes available by deployment alone.
// FI: Puuttuva yksittäisasetus sulkee QR:n turvallisesti, jotta käyttöönotto ei yksin avaa palvelua.
const getQrMode = async (prisma) =>
  (await prisma.qrPolicy.findUnique({ where: { id: 1 } }))?.mode ?? "DISABLED";

const setQrMode = async (prisma, mode) => {
  if (!["DISABLED", "MENU_ONLY", "ORDERING"].includes(mode))
    throw new TableError(400, "INVALID_QR_MODE", "Invalid QR mode");
  const policy = await prisma.qrPolicy.upsert({
    where: { id: 1 },
    create: { id: 1, mode },
    update: { mode },
  });
  return policy.mode;
};

// EN: The existing partial unique index is the final guard against two concurrent OPEN sessions.
// FI: Nykyinen osittainen yksilöllinen indeksi estää lopulta kaksi samanaikaista OPEN-istuntoa.
const openSession = (prisma, rawTableId) => {
  const restaurantTableId = positiveId(rawTableId);
  const key = qrKey();
  return withConflict(async () => {
    const { session, access } = await prisma.$transaction(
      async (tx) => {
        const table = await tx.restaurantTable.findUnique({
          where: { id: restaurantTableId },
          select: { id: true, status: true },
        });
        if (!table || table.status !== "use")
          throw new TableError(404, "TABLE_NOT_FOUND", "Table not found");
        const created = await tx.tableSession.create({
          data: {
            restaurantTableId,
          },
          select: { id: true },
        });
        const access = createAccess(key, created.id, 1);
        const session = await tx.tableSession.update({
          where: { id: created.id },
          data: {
            qrTokenHash: access.qrTokenHash,
            qrTokenNonce: access.qrTokenNonce,
            qrTokenExpiresAt: access.qrTokenExpiresAt,
            tokenVersion: 1,
          },
          select: {
            id: true,
            restaurantTableId: true,
            status: true,
            openedAt: true,
            qrTokenExpiresAt: true,
            tokenVersion: true,
          },
        });
        return { session, access };
      },
      { isolationLevel: Prisma.TransactionIsolationLevel.Serializable },
    );
    return { session, token: access.token, path: `/order/${access.token}` };
  });
};

const rotateToken = (prisma, rawSessionId, expectedVersion) => {
  const id = positiveId(rawSessionId);
  const version = expectedTokenVersion(expectedVersion);
  const key = qrKey();
  return withConflict(async () => {
    const { session, access } = await prisma.$transaction(
      async (tx) => {
        const current = await tx.tableSession.findUnique({
          where: { id },
          include: { RestaurantTable: { select: { status: true } } },
        });
        if (!current)
          throw new TableError(404, "SESSION_NOT_FOUND", "Session not found");
        if (
          current.status !== "OPEN" ||
          current.RestaurantTable.status !== "use"
        )
          throw new TableError(409, "SESSION_CLOSED", "Session is closed");
        const access = createAccess(key, id, version + 1);
        const updated = await tx.tableSession.updateMany({
          where: { id, status: "OPEN", tokenVersion: version },
          data: {
            qrTokenHash: access.qrTokenHash,
            qrTokenNonce: access.qrTokenNonce,
            qrTokenExpiresAt: access.qrTokenExpiresAt,
            tokenVersion: { increment: 1 },
          },
        });
        if (updated.count !== 1)
          throw new TableError(
            409,
            "STALE_TOKEN_VERSION",
            "Session token version is stale",
          );
        const session = await tx.tableSession.findUnique({
          where: { id },
          select: {
            id: true,
            restaurantTableId: true,
            status: true,
            openedAt: true,
            qrTokenExpiresAt: true,
            tokenVersion: true,
          },
        });
        return { session, access };
      },
      { isolationLevel: Prisma.TransactionIsolationLevel.Serializable },
    );
    return { session, token: access.token, path: `/order/${access.token}` };
  });
};

// EN: Reissuing verifies the derived token against the stored hash; a changed key or expired session fails closed.
// FI: Uudelleen näyttö vertaa johdettua tunnistetta tallennettuun tiivisteeseen; vaihtunut avain tai vanhentunut istunto sulkeutuu turvallisesti.
const reissueToken = async (prisma, rawSessionId) => {
  const id = positiveId(rawSessionId);
  const key = qrKey();
  const session = await prisma.tableSession.findUnique({
    where: { id },
    include: { RestaurantTable: { select: { status: true } } },
  });
  if (!session)
    throw new TableError(404, "SESSION_NOT_FOUND", "Session not found");
  if (session.status !== "OPEN" || session.RestaurantTable.status !== "use")
    throw new TableError(409, "SESSION_CLOSED", "Session is closed");
  if (!session.qrTokenExpiresAt || session.qrTokenExpiresAt <= new Date())
    throw new TableError(409, "QR_EXPIRED", "Rotate the expired QR token");
  if (!session.qrTokenNonce || !session.qrTokenHash)
    throw new TableError(503, "QR_KEY_MISMATCH", "QR token cannot be restored");
  const token = deriveToken(
    key,
    id,
    session.tokenVersion,
    session.qrTokenNonce,
  );
  const actual = Buffer.from(tokenHash(token), "hex");
  const stored = Buffer.from(session.qrTokenHash, "hex");
  if (stored.length !== actual.length || !timingSafeEqual(stored, actual))
    throw new TableError(503, "QR_KEY_MISMATCH", "QR token cannot be restored");
  return {
    session: {
      id: session.id,
      restaurantTableId: session.restaurantTableId,
      status: session.status,
      openedAt: session.openedAt,
      qrTokenExpiresAt: session.qrTokenExpiresAt,
      tokenVersion: session.tokenVersion,
    },
    token,
    path: `/order/${token}`,
  };
};

// EN: Closing invalidates access in the same transaction, and unpaid Orders prevent accidental orphaning.
// FI: Sulkeminen mitätöi pääsyn samassa transaktiossa, ja maksamattomat tilaukset estävät tahattoman orpoutumisen.
const closeSession = (prisma, rawSessionId, expectedVersion) => {
  const id = positiveId(rawSessionId);
  const version = expectedTokenVersion(expectedVersion);
  return withConflict(() =>
    prisma.$transaction(
      async (tx) => {
        const session = await tx.tableSession.findUnique({
          where: { id },
        });
        if (!session)
          throw new TableError(404, "SESSION_NOT_FOUND", "Session not found");
        if (session.status !== "OPEN")
          throw new TableError(409, "SESSION_CLOSED", "Session is closed");
        const pending = await tx.order.count({
          where: {
            tableSessionId: id,
            status: { notIn: TERMINAL_ORDER_STATUSES },
          },
        });
        if (pending)
          throw new TableError(
            409,
            "UNSETTLED_ORDERS",
            "Settle or cancel session orders before closing",
          );
        const updated = await tx.tableSession.updateMany({
          where: { id, status: "OPEN", tokenVersion: version },
          data: {
            status: "CLOSED",
            closedAt: new Date(),
            qrTokenHash: null,
            qrTokenNonce: null,
            qrTokenExpiresAt: null,
            tokenVersion: { increment: 1 },
          },
        });
        if (updated.count !== 1)
          throw new TableError(
            409,
            "STALE_TOKEN_VERSION",
            "Session token version is stale",
          );
        // EN: A closed table cannot leave a customer service call in the staff queue.
        // FI: Suljettu pöytä ei saa jättää asiakkaan palvelukutsua henkilökunnan jonoon.
        await tx.serviceCall.updateMany({
          where: {
            tableSessionId: id,
            status: { in: ["REQUESTED", "ACKNOWLEDGED"] },
          },
          data: {
            status: "RESOLVED",
            resolvedAt: new Date(),
            version: { increment: 1 },
          },
        });
        return tx.tableSession.findUnique({
          where: { id },
          select: {
            id: true,
            restaurantTableId: true,
            status: true,
            closedAt: true,
            tokenVersion: true,
          },
        });
      },
      { isolationLevel: Prisma.TransactionIsolationLevel.Serializable },
    ),
  );
};

// EN: A URL token never grants staff rights; future QR routes must resolve it and enforce the current mode per request.
// FI: URL-tunniste ei anna henkilökunnan oikeuksia; tulevien QR-reittien on tarkistettava se ja nykyinen tila jokaisella pyynnöllä.
const resolveQrAccess = async (prisma, token) => {
  if (typeof token !== "string" || !TOKEN_PATTERN.test(token)) return null;
  const session = await prisma.tableSession.findUnique({
    where: { qrTokenHash: tokenHash(token) },
    include: {
      RestaurantTable: { select: { tableNo: true, status: true } },
    },
  });
  if (
    !session ||
    session.status !== "OPEN" ||
    session.RestaurantTable.status !== "use" ||
    !session.qrTokenNonce ||
    !session.qrTokenExpiresAt ||
    session.qrTokenExpiresAt <= new Date()
  )
    return null;
  // EN: Key rotation or a missing key must also revoke public access, not only staff reissue.
  // FI: Avaimen vaihto tai puuttuminen mitätöi myös julkisen pääsyn, ei vain henkilökunnan uudelleennäyttöä.
  let key;
  try {
    key = qrKey();
  } catch {
    return null;
  }
  const derived = deriveToken(
    key,
    session.id,
    session.tokenVersion,
    session.qrTokenNonce,
  );
  if (!timingSafeEqual(Buffer.from(derived), Buffer.from(token))) return null;
  const mode = await getQrMode(prisma);
  // EN: Disabling new orders must not hide a previously submitted order from the same valid table token.
  // FI: Uusien tilausten estäminen ei saa piilottaa aiemmin lähetettyä tilausta saman voimassa olevan pöytätunnisteen haltijalta.
  if (mode === "DISABLED")
    return {
      state: "CLOSED",
      tableNo: session.RestaurantTable.tableNo,
      tableSessionId: session.id,
    };
  return {
    state: mode,
    tableNo: session.RestaurantTable.tableNo,
    tableSessionId: session.id,
  };
};

module.exports = {
  TableError,
  listTables,
  createTable,
  updateTable,
  deleteTable,
  getQrMode,
  setQrMode,
  openSession,
  rotateToken,
  reissueToken,
  closeSession,
  resolveQrAccess,
};
