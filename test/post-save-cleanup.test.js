const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { createRequire } = require("node:module");
const { afterEach, mock, test } = require("node:test");

// EN: Inject persistence and storage faults without accessing a database or deleting files.
// FI: Syötä tallennusvirheitä käyttämättä tietokantaa tai poistamatta tiedostoja.
function controller(name, prisma, removeImageArtifacts) {
  const file = path.resolve(__dirname, "../controller", name);
  const actualRequire = createRequire(file);
  const module = { exports: {} };
  const injectedRequire = (id) => {
    if (id === "../lib/prisma") return prisma;
    if (id === "../lib/image-variants") {
      return { ...actualRequire(id), removeImageArtifacts };
    }
    return actualRequire(id);
  };
  new Function("require", "module", "exports", fs.readFileSync(file, "utf8"))(
    injectedRequire,
    module,
    module.exports,
  );
  return module.exports;
}

function response() {
  return {
    statusCode: 200,
    body: null,
    status(code) {
      this.statusCode = code;
      return this;
    },
    send(body) {
      this.body = body;
      return this;
    },
  };
}

const foodBody = {
  id: 1,
  foodTypeId: 2,
  name: "Soup",
  price: 10,
  foodType: "food",
  img: "new.png",
  detailImg: "new-detail.png",
};
const organizationBody = {
  name: "Restaurant",
  address: "Street 1",
  phone: "123",
  taxCode: "TEST-1",
  logo: "new.png",
};

afterEach(() => mock.restoreAll());

test("food cleanup failure preserves save success and still cleans the second image", async () => {
  const log = mock.method(console, "error", () => {});
  const updated = mock.fn(async () => {});
  const count = mock.fn(async () => 0);
  const remove = mock.fn(async (_directory, image) => {
    assert.equal(updated.mock.callCount(), 1);
    if (image === "old.png")
      throw Object.assign(new Error("private path"), { code: "EACCES" });
  });
  const api = controller(
    "FoodController.js",
    {
      food: {
        findFirst: async () => ({
          img: "old.png",
          detailImg: "old-detail.png",
        }),
        update: updated,
        count,
      },
      foodType: { findFirst: async () => ({ id: 2 }) },
    },
    remove,
  );
  const res = response();
  await api.update({ body: foodBody }, res);
  assert.equal(res.statusCode, 200);
  assert.deepEqual(res.body, { message: "success" });
  assert.equal(count.mock.callCount(), 2);
  assert.deepEqual(count.mock.calls[0].arguments[0], {
    where: { OR: [{ img: "old.png" }, { detailImg: "old.png" }] },
  });
  assert.deepEqual(
    remove.mock.calls.map((call) => call.arguments[1]),
    ["old.png", "old-detail.png"],
  );
  assert.deepEqual(log.mock.calls[0].arguments, [
    "Post-save image cleanup failed",
    { resource: "food", code: "EACCES" },
  ]);
});

test("food cleanup retains shared images", async () => {
  const remove = mock.fn();
  const api = controller(
    "FoodController.js",
    {
      food: {
        findFirst: async () => ({ img: "shared.png", detailImg: "shared.png" }),
        update: async () => {},
        count: async () => 1,
      },
      foodType: { findFirst: async () => ({ id: 2 }) },
    },
    remove,
  );
  const res = response();
  await api.update({ body: foodBody }, res);
  assert.equal(res.statusCode, 200);
  assert.equal(remove.mock.callCount(), 0);
});

test("failed food persistence remains an error and never removes old images", async () => {
  const remove = mock.fn();
  const api = controller(
    "FoodController.js",
    {
      food: {
        findFirst: async () => ({ img: "old.png" }),
        update: async () => {
          throw new Error("database failed");
        },
        count: mock.fn(),
      },
      foodType: { findFirst: async () => ({ id: 2 }) },
    },
    remove,
  );
  const res = response();
  await api.update({ body: foodBody }, res);
  assert.equal(res.statusCode, 500);
  assert.equal(remove.mock.callCount(), 0);
});

test("organization cleanup failure preserves committed success and Serializable isolation", async () => {
  const log = mock.method(console, "error", () => {});
  let committed = false;
  const api = controller(
    "OrganizationController.js",
    {
      $transaction: async (save, options) => {
        assert.equal(options.isolationLevel, "Serializable");
        const result = await save({
          organization: {
            findFirst: async () => ({ id: 1, logo: "old.png" }),
            update: async () => {},
          },
        });
        committed = true;
        return result;
      },
    },
    async () => {
      assert.equal(committed, true);
      throw Object.assign(new Error("private path"), { code: "EACCES" });
    },
  );
  const res = response();
  await api.create({ body: organizationBody }, res);
  assert.equal(res.statusCode, 200);
  assert.deepEqual(res.body, { message: "success" });
  assert.deepEqual(log.mock.calls[0].arguments[1], {
    resource: "organization",
    code: "EACCES",
  });
});

for (const [code, expectedStatus] of [
  ["P2034", 409],
  ["P2002", 409],
  ["OTHER", 500],
]) {
  test(`organization persistence ${code} retains its error response without cleanup`, async () => {
    const remove = mock.fn();
    const api = controller(
      "OrganizationController.js",
      {
        $transaction: async () => {
          throw Object.assign(new Error("database failed"), { code });
        },
      },
      remove,
    );
    const res = response();
    await api.create({ body: organizationBody }, res);
    assert.equal(res.statusCode, expectedStatus);
    assert.equal(remove.mock.callCount(), 0);
  });
}
