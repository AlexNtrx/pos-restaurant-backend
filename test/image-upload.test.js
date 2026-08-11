const { after, test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs/promises");
const os = require("node:os");
const path = require("node:path");
const {
  MAX_UPLOAD_BYTES,
  validateImageFile,
  storeImage,
} = require("../lib/image-upload");

const png = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);
let temporaryDirectory;

// Coordinates file behavior for this module.
const file = (overrides = {}) => ({
  name: "image.png",
  mimetype: "image/png",
  size: png.length,
  data: png,
  // Coordinates mv behavior for this module.
  mv: (_destination, callback) => callback(),
  ...overrides,
});

after(async () => {
  if (temporaryDirectory)
    await fs.rm(temporaryDirectory, { recursive: true, force: true });
});

test("image upload validation accepts signed supported images and rejects malformed inputs", () => {
  const options = { requiredMessage: "required", sizeMessage: "size" };
  assert.deepEqual(validateImageFile(file(), options), { extension: "png" });
  assert.deepEqual(validateImageFile(undefined, options), {
    error: "required",
  });
  assert.deepEqual(validateImageFile(file({ name: "image.exe" }), options), {
    error: "Only JPEG, PNG, WEBP, or GIF images are allowed",
  });
  assert.deepEqual(
    validateImageFile(file({ data: Buffer.from("spoof") }), options),
    { error: "Image contents do not match its file type" },
  );
  assert.deepEqual(
    validateImageFile(file({ size: MAX_UPLOAD_BYTES + 1 }), options),
    { error: "size" },
  );
});

test("image storage creates a safe UUID filename and propagates movement failures", async () => {
  temporaryDirectory = await fs.mkdtemp(
    path.join(os.tmpdir(), "pos-image-upload-"),
  );
  let destination;
  // Coordinates mv behavior for this module.
  const saved = await storeImage(
    file({
      mv: (target, callback) => {
        destination = target;
        callback();
      },
    }),
    { uploadDirectory: temporaryDirectory, prefix: "logo_" },
  );
  assert.match(saved, /^logo_[0-9a-f-]+\.png$/);
  assert.equal(destination, path.join(temporaryDirectory, saved));
  await assert.rejects(
    // Coordinates mv behavior for this module.
    storeImage(
      file({ mv: (_target, callback) => callback(new Error("disk failure")) }),
      { uploadDirectory: temporaryDirectory },
    ),
    /disk failure/,
  );
});
