const { centsToEuros } = require("./money");

// EN: This explicit list covers schema money fields and their read-model aliases; IDs, counts and versions never change units.
// FI: Tämä nimenomainen lista kattaa skeeman rahakentät ja lukumallien vastineet; tunnisteiden, lukumäärien ja versioiden yksiköt eivät muutu.
const MONEY_FIELDS = new Set([
  "price",
  "moneyAdded",
  "amount",
  "inputMoney",
  "returnMoney",
  "subtotal",
  "modifierTotal",
  "total",
  "unitBasePrice",
  "unitModifierTotal",
  "unitTotal",
  "lineTotal",
  "priceAdjustment",
  "baseAmount",
  "addedAmount",
  "totalAmount",
  "grossAmount",
  "refundedAmount",
  "pendingRefundAmount",
  "failedRefundAmount",
  "unpaidCancelledAmount",
  "paidCancelledAmount",
]);

const moneyDto = (value) => {
  if (value == null || typeof value !== "object" || value instanceof Date)
    return value;
  if (Array.isArray(value)) return value.map(moneyDto);
  return Object.fromEntries(
    Object.entries(value).map(([field, child]) => [
      field,
      MONEY_FIELDS.has(field) && typeof child === "bigint"
        ? centsToEuros(child)
        : moneyDto(child),
    ]),
  );
};
const sendMoney = (res, body) => res.send(moneyDto(body));

module.exports = { moneyDto, sendMoney };
