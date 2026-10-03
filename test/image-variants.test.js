const { test, after, before } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs/promises");
const path = require("node:path");
const os = require("node:os");
const sharp = require("sharp");
const { png } = require("./image-fixture");
const {
  storeImageWithVariants,
  ensureImageVariant,
  removeImageArtifacts,
} = require("../lib/image-variants");
let directory;
before(async () => {
  directory = await fs.mkdtemp(path.join(os.tmpdir(), "pos-image-variants-"));
});
after(async () => {
  await fs.rm(directory, { recursive: true, force: true });
});
const file = (data, extension) => ({ name: `image.${extension}`, data });

test("upload variants preserve all supported original formats and render only the first animated frame", async () => {
  const other = await sharp({
    create: { width: 2, height: 2, channels: 4, background: "red" },
  })
    .png()
    .toBuffer();
  const animated = await sharp([png, other], { join: { animated: true } })
    .gif()
    .toBuffer();
  assert.equal((await sharp(animated, { animated: true }).metadata()).pages, 2);
  for (const [data, extension] of [
    [png, "png"],
    [await sharp(png).jpeg().toBuffer(), "jpg"],
    [await sharp(png).webp().toBuffer(), "webp"],
    [animated, "gif"],
  ]) {
    const filename = await storeImageWithVariants(file(data, extension), {
      uploadDirectory: directory,
    });
    assert.deepEqual(await fs.readFile(path.join(directory, filename)), data);
    const metadata = await sharp(
      await ensureImageVariant(directory, filename, "card"),
    ).metadata();
    assert.equal(metadata.format, "webp");
    assert.equal(metadata.width, 2);
    assert.equal(metadata.height, 2);
    assert.ok(!metadata.pages || metadata.pages === 1);
  }
});

test("image policy rejects corrupt pixels, excessive dimensions and pixel bombs without saving originals", async () => {
  const before = (await fs.readdir(directory)).sort();
  for (const data of [
    png.subarray(0, 40),
    Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
    await sharp({
      create: { width: 8001, height: 1, channels: 3, background: "red" },
    })
      .png()
      .toBuffer(),
    await sharp({
      create: { width: 5000, height: 5000, channels: 3, background: "red" },
    })
      .png()
      .toBuffer(),
  ])
    await assert.rejects(
      storeImageWithVariants(file(data, "png"), { uploadDirectory: directory }),
      { status: 400 },
    );
  assert.deepEqual((await fs.readdir(directory)).sort(), before);
});

test("legacy requests deduplicate conversion, respect EXIF orientation, and never rewrite originals", async () => {
  const original = await sharp({
    create: { width: 800, height: 400, channels: 3, background: "blue" },
  })
    .jpeg()
    .withMetadata({ orientation: 6 })
    .toBuffer();
  await fs.writeFile(path.join(directory, "legacy.jpg"), original);
  const paths = await Promise.all(
    Array.from({ length: 20 }, () =>
      ensureImageVariant(directory, "legacy.jpg", "card"),
    ),
  );
  assert.ok(paths.every((item) => item === paths[0]));
  const metadata = await sharp(paths[0]).metadata();
  assert.equal(metadata.width, 180);
  assert.equal(metadata.height, 360);
  const cachedStat = await fs.stat(paths[0]);
  assert.equal(
    (await fs.stat(await ensureImageVariant(directory, "legacy.jpg", "card")))
      .mtimeMs,
    cachedStat.mtimeMs,
  );
  assert.deepEqual(
    await fs.readFile(path.join(directory, "legacy.jpg")),
    original,
  );
  await removeImageArtifacts(directory, "legacy.jpg");
  await assert.rejects(fs.access(paths[0]), { code: "ENOENT" });
  await assert.rejects(ensureImageVariant(directory, "legacy.jpg", "card"), {
    code: "ENOENT",
  });
});

test("variants reduce transmitted bytes for a deterministic photo-like fixture and keep detail dimensions bounded", async () => {
  const width = 2400,
    height = 1600;
  const raw = Buffer.alloc(width * height * 3);
  let seed = 17;
  for (let pixel = 0; pixel < width * height; pixel++) {
    seed = (seed * 1664525 + 1013904223) >>> 0;
    const noise = seed & 31;
    raw[pixel * 3] = Math.min(255, ((pixel % width) / width) * 200 + noise);
    raw[pixel * 3 + 1] = Math.min(
      255,
      (Math.floor(pixel / width) / height) * 200 + noise,
    );
    raw[pixel * 3 + 2] = 80 + noise;
  }
  const original = await sharp(raw, { raw: { width, height, channels: 3 } })
    .jpeg({ quality: 95 })
    .toBuffer();
  await fs.writeFile(path.join(directory, "photo.jpg"), original);
  const sizes = { original: original.length };
  for (const [variant, maxWidth, maxHeight] of [
    ["card", 480, 360],
    ["detail", 1600, 1600],
  ]) {
    const bytes = await fs.readFile(
      await ensureImageVariant(directory, "photo.jpg", variant),
    );
    const metadata = await sharp(bytes).metadata();
    assert.ok(metadata.width <= maxWidth && metadata.height <= maxHeight);
    assert.ok(bytes.length < original.length);
    sizes[variant] = bytes.length;
  }
  console.log(
    JSON.stringify({
      fixture: "2400x1600 deterministic gradient/noise JPEG",
      bytes: sizes,
    }),
  );
});

test("variant paths cannot escape uploads or accept arbitrary transformations", async () => {
  for (const filename of [
    "../image.png",
    "..\\image.png",
    ".hidden.png",
    "bill-secret.pdf",
    "image.svg",
  ])
    await assert.rejects(ensureImageVariant(directory, filename, "card"), {
      status: 404,
    });
  await assert.rejects(
    ensureImageVariant(directory, "photo.jpg", "unbounded"),
    { status: 404 },
  );
});

test("concurrent distinct conversions have a bounded queue and recover after busy responses", async () => {
  const jobs = Array.from({ length: 12 }, () =>
    storeImageWithVariants(file(png, "png"), { uploadDirectory: directory }),
  );
  const results = await Promise.allSettled(jobs);
  assert.equal(
    results.filter((item) => item.status === "fulfilled").length,
    10,
  );
  assert.equal(
    results.filter(
      (item) => item.status === "rejected" && item.reason.status === 429,
    ).length,
    2,
  );
  assert.ok(
    await storeImageWithVariants(file(png, "png"), {
      uploadDirectory: directory,
    }),
  );
});
