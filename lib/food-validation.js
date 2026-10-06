const path = require("node:path");
const { positiveInteger } = require("./catalog-validation");

const MAX_PRICE = 10_000_000;
const validFoodTypes = new Set(["food", "drink"]);

const nonNegativeInteger = (value) => {
  const parsed = Number(value);
  return Number.isInteger(parsed) && parsed >= 0 && parsed <= MAX_PRICE
    ? parsed
    : null;
};

const normalizeText = (value) =>
  typeof value === "string" ? value.trim() : "";

// EN: Keep image references to plain filenames before persistence or filesystem cleanup.
// FI: Säilytä kuvaviitteet pelkkinä tiedostoniminä ennen tallennusta tai tiedostojärjestelmän siivousta.
const isSafeImageName = (value) =>
  typeof value === "string" &&
  value.length <= 160 &&
  (value === "" || (path.basename(value) === value && !value.includes("\0")));

// EN: Preserve numeric-string coercion, text normalization, error ordering, and optional detailImg compatibility at the request boundary.
// FI: Säilytä numeromerkkijonojen muunnos, tekstin normalisointi, virheiden järjestys ja valinnainen detailImg-yhteensopivuus pyyntörajan kohdalla.
const validateFood = (body) => {
  const foodTypeId = positiveInteger(body?.foodTypeId);
  const name = normalizeText(body?.name);
  const remark = normalizeText(body?.remark);
  const price = nonNegativeInteger(body?.price);
  const foodType = body?.foodType;
  const img = body?.img ?? "";
  const detailImg = body?.detailImg;

  if (!foodTypeId) return { error: "foodTypeId must be a positive integer" };
  if (!name || name.length > 120)
    return { error: "Name must be 1-120 characters" };
  if (remark.length > 500)
    return { error: "Remark must be at most 500 characters" };
  if (price === null)
    return { error: "Price must be a whole number from 0 to 10000000" };
  if (!validFoodTypes.has(foodType))
    return { error: "foodType must be food or drink" };
  if (!isSafeImageName(img)) return { error: "Invalid image filename" };
  if (detailImg !== undefined && !isSafeImageName(detailImg))
    return { error: "Invalid detail image filename" };

  // EN: Omitting detailImg keeps older clients compatible and preserves an existing detail image on update.
  // FI: detailImg-kentän pois jättäminen säilyttää vanhojen asiakkaiden yhteensopivuuden ja olemassa olevan lisätietokuvan päivityksessä.
  return {
    foodTypeId,
    name,
    remark,
    price,
    foodType,
    img,
    ...(detailImg === undefined ? {} : { detailImg }),
  };
};

module.exports = { validateFood, isSafeImageName };
