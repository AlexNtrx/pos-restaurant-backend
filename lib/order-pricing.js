const { createHash } = require("node:crypto");
const { OrderDomainError, assertPositiveInteger } = require("./order-domain");

const CLIENT_FINANCIAL_FIELDS = new Set([
  "amount",
  "inputmoney",
  "linetotal",
  "modifierprice",
  "modifiertotal",
  "moneyadded",
  "price",
  "returnmoney",
  "subtotal",
  "total",
  "unitbaseprice",
  "unitprice",
  "unittotal",
]);

// EN: Financial fields are rejected instead of silently accepted, making tampering visible to callers.
// FI: Talouskentät hylätään hiljaisen hyväksymisen sijaan, jotta manipulointi näkyy kutsujalle.
const rejectClientFinancialAuthority = (value) => {
  if (!value || typeof value !== "object") return;
  for (const [key, child] of Object.entries(value)) {
    if (CLIENT_FINANCIAL_FIELDS.has(key.toLowerCase())) {
      throw new OrderDomainError(
        400,
        "CLIENT_FINANCIAL_AUTHORITY_REJECTED",
        `Client field ${key} is not accepted`,
      );
    }
    rejectClientFinancialAuthority(child);
  }
};

const nullablePositiveInteger = (value, field) =>
  value == null ? null : assertPositiveInteger(value, field);

const normalizeOrderIntent = (intent, { maxItems = 200 } = {}) => {
  rejectClientFinancialAuthority(intent);
  if (!intent || !["COUNTER", "QR"].includes(intent.channel)) {
    throw new OrderDomainError(
      400,
      "INVALID_CHANNEL",
      "channel must be COUNTER or QR",
    );
  }

  const tableNo = assertPositiveInteger(intent.tableNo, "tableNo");
  const tableSessionId = nullablePositiveInteger(
    intent.tableSessionId,
    "tableSessionId",
  );
  if (intent.channel === "QR" && tableSessionId == null) {
    throw new OrderDomainError(
      400,
      "QR_SESSION_REQUIRED",
      "QR orders require tableSessionId",
    );
  }
  if (!Array.isArray(intent.items) || intent.items.length === 0) {
    throw new OrderDomainError(
      400,
      "EMPTY_ORDER",
      "Order requires at least one item",
    );
  }
  if (intent.items.length > maxItems) {
    throw new OrderDomainError(
      400,
      "ORDER_TOO_LARGE",
      "Order has too many item groups",
    );
  }

  // EN: Equivalent selections are grouped before hashing so harmless item ordering cannot bypass idempotency.
  // FI: Vastaavat valinnat ryhmitellään ennen hajautusta, jotta rivijärjestys ei voi ohittaa idempotenssia.
  const grouped = new Map();
  for (const raw of intent.items) {
    const item = {
      foodId: assertPositiveInteger(raw?.foodId, "foodId"),
      quantity: assertPositiveInteger(raw?.quantity, "quantity"),
      foodSizeId: nullablePositiveInteger(raw?.foodSizeId, "foodSizeId"),
      tasteId: nullablePositiveInteger(raw?.tasteId, "tasteId"),
    };
    const key = `${item.foodId}:${item.foodSizeId ?? "-"}:${item.tasteId ?? "-"}`;
    const existing = grouped.get(key);
    if (existing) {
      existing.quantity += item.quantity;
      assertPositiveInteger(existing.quantity, "quantity");
    } else {
      grouped.set(key, item);
    }
  }

  const items = [...grouped.values()].sort(
    (left, right) =>
      left.foodId - right.foodId ||
      (left.foodSizeId ?? 0) - (right.foodSizeId ?? 0) ||
      (left.tasteId ?? 0) - (right.tasteId ?? 0),
  );
  return { channel: intent.channel, tableNo, tableSessionId, items };
};

const fingerprintOrderIntent = (intent) =>
  createHash("sha256").update(JSON.stringify(intent)).digest("hex");

// EN: Catalog records supply every persisted name and amount; the client contributes identifiers and quantity only.
// FI: Luettelotiedot tuottavat kaikki tallennettavat nimet ja summat; asiakas antaa vain tunnisteet ja määrän.
const buildOrderSnapshot = async (client, normalizedIntent) => {
  let restaurantTableId = null;
  if (normalizedIntent.tableSessionId != null) {
    const session = await client.tableSession.findUnique({
      where: { id: normalizedIntent.tableSessionId },
      include: { RestaurantTable: true },
    });
    if (!session || session.status !== "OPEN") {
      throw new OrderDomainError(
        409,
        "TABLE_SESSION_INACTIVE",
        "Table session is not open",
      );
    }
    if (
      session.RestaurantTable.status !== "use" ||
      session.RestaurantTable.tableNo !== normalizedIntent.tableNo
    ) {
      throw new OrderDomainError(
        409,
        "TABLE_SESSION_MISMATCH",
        "Table session does not match the active table",
      );
    }
    restaurantTableId = session.restaurantTableId;
  }

  const foodIds = [
    ...new Set(normalizedIntent.items.map((item) => item.foodId)),
  ];
  const sizeIds = [
    ...new Set(
      normalizedIntent.items.map((item) => item.foodSizeId).filter(Boolean),
    ),
  ];
  const tasteIds = [
    ...new Set(
      normalizedIntent.items.map((item) => item.tasteId).filter(Boolean),
    ),
  ];
  const [foods, sizes, tastes] = await Promise.all([
    client.food.findMany({ where: { id: { in: foodIds }, status: "use" } }),
    sizeIds.length
      ? client.foodSize.findMany({
          where: { id: { in: sizeIds }, status: "use" },
        })
      : [],
    tasteIds.length
      ? client.taste.findMany({
          where: { id: { in: tasteIds }, status: "use" },
        })
      : [],
  ]);
  const foodById = new Map(foods.map((food) => [food.id, food]));
  const sizeById = new Map(sizes.map((size) => [size.id, size]));
  const tasteById = new Map(tastes.map((taste) => [taste.id, taste]));

  let subtotal = 0;
  let modifierTotal = 0;
  const items = normalizedIntent.items.map((requested) => {
    const food = foodById.get(requested.foodId);
    if (!food || !Number.isSafeInteger(food.price) || food.price < 0) {
      throw new OrderDomainError(
        409,
        "FOOD_UNAVAILABLE",
        "Food is unavailable",
      );
    }
    const modifiers = [];
    let unitModifierTotal = 0;
    if (requested.foodSizeId != null) {
      const size = sizeById.get(requested.foodSizeId);
      if (!size || size.foodTypeId !== food.foodTypeId || size.moneyAdded < 0) {
        throw new OrderDomainError(
          409,
          "SIZE_UNAVAILABLE",
          "Food size is unavailable",
        );
      }
      unitModifierTotal += size.moneyAdded;
      modifiers.push({
        type: "SIZE",
        foodSizeId: size.id,
        tasteId: null,
        name: size.name,
        priceAdjustment: size.moneyAdded,
      });
    }
    if (requested.tasteId != null) {
      const taste = tasteById.get(requested.tasteId);
      if (!taste || taste.foodTypeId !== food.foodTypeId) {
        throw new OrderDomainError(
          409,
          "TASTE_UNAVAILABLE",
          "Taste is unavailable",
        );
      }
      modifiers.push({
        type: "TASTE",
        foodSizeId: null,
        tasteId: taste.id,
        name: taste.name,
        priceAdjustment: 0,
      });
    }
    const unitTotal = food.price + unitModifierTotal;
    const lineTotal = unitTotal * requested.quantity;
    if (![unitTotal, lineTotal].every(Number.isSafeInteger)) {
      throw new OrderDomainError(
        409,
        "TOTAL_OUT_OF_RANGE",
        "Order total is out of range",
      );
    }
    subtotal += food.price * requested.quantity;
    modifierTotal += unitModifierTotal * requested.quantity;
    return {
      foodId: food.id,
      foodName: food.name,
      quantity: requested.quantity,
      unitBasePrice: food.price,
      unitModifierTotal,
      unitTotal,
      lineTotal,
      modifiers,
    };
  });
  const total = subtotal + modifierTotal;
  if (![subtotal, modifierTotal, total].every(Number.isSafeInteger)) {
    throw new OrderDomainError(
      409,
      "TOTAL_OUT_OF_RANGE",
      "Order total is out of range",
    );
  }

  return {
    channel: normalizedIntent.channel,
    tableNo: normalizedIntent.tableNo,
    tableSessionId: normalizedIntent.tableSessionId,
    restaurantTableId,
    subtotal,
    modifierTotal,
    total,
    items,
  };
};

module.exports = {
  buildOrderSnapshot,
  fingerprintOrderIntent,
  normalizeOrderIntent,
  rejectClientFinancialAuthority,
};
