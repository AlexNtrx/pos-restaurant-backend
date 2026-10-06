const assert = require("node:assert/strict");
const { test } = require("node:test");
const { validateFood } = require("../lib/food-validation");

test("food validation preserves coercion, normalization, and optional detail image", () => {
  const result = validateFood({
    foodTypeId: "7",
    name: " Soup ",
    remark: " Fresh ",
    price: "125",
    foodType: "food",
    img: "soup.png",
  });

  assert.deepEqual(result, {
    foodTypeId: 7,
    name: "Soup",
    remark: "Fresh",
    price: 125,
    foodType: "food",
    img: "soup.png",
  });
  assert.equal(Object.hasOwn(result, "detailImg"), false);
});

test("food validation preserves field error order and rejects unsafe image names", () => {
  const base = {
    foodTypeId: 7,
    name: "Soup",
    remark: "Fresh",
    price: 125,
    foodType: "food",
    img: "soup.png",
  };

  assert.deepEqual(validateFood({ ...base, name: "", price: -1 }), {
    error: "Name must be 1-120 characters",
  });
  assert.deepEqual(validateFood({ ...base, img: "../soup.png" }), {
    error: "Invalid image filename",
  });
  assert.deepEqual(validateFood({ ...base, detailImg: "../soup-detail.png" }), {
    error: "Invalid detail image filename",
  });
});
