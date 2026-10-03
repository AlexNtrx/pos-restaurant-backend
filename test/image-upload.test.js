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

const { png } = require("./image-fixture");
let temporaryDirectory;

// Coordinates file behavior for this module.
const file = (overrides = {}) => ({
  name: "image.png",
  mimetype: "image/png",
  size: png.length,
  data: png,
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
  assert.deepEqual(validateImageFile(file({ truncated: true }), options), {
    error: "size",
  });
});

test("image storage preserves originals, creates variants and propagates storage failures", async () => {
  temporaryDirectory = await fs.mkdtemp(
    path.join(os.tmpdir(), "pos-image-upload-"),
  );
  const saved = await storeImage(file(), {
    uploadDirectory: temporaryDirectory,
    prefix: "logo_",
  });
  assert.match(saved, /^logo_[0-9a-f-]+\.png$/);
  assert.deepEqual(
    await fs.readFile(path.join(temporaryDirectory, saved)),
    png,
  );
  const blocker = path.join(temporaryDirectory, "not-a-directory");
  await fs.writeFile(blocker, "blocked");
  await assert.rejects(
    storeImage(file(), { uploadDirectory: blocker }),
    (error) => ["EEXIST", "ENOTDIR"].includes(error.code),
  );
});
