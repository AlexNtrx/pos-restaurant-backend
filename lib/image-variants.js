const sharp = require("sharp");
const fs = require("node:fs/promises");
const path = require("node:path");
const { randomUUID } = require("node:crypto");

const MAX_INPUT_PIXELS = 24_000_000;
const MAX_INPUT_EDGE = 8000;
const MAX_SOURCE_BYTES = 5 * 1024 * 1024;
const variants = {
  card: { width: 480, height: 360, quality: 75 },
  detail: { width: 1600, height: 1600, quality: 85 },
};
const pending = new Map();
const queue = [];
let active = 0;
sharp.cache({ memory: 32, files: 0, items: 32 });
sharp.concurrency(1);

class ImageProcessingError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

// EN: Share two processing slots between uploads and legacy variants; reject excess queued work rather than retaining unlimited buffers.
// FI: Jaa kaksi käsittelypaikkaa latausten ja vanhojen kuvien kesken; hylkää ylimääräiset jonotyöt rajattomien puskureiden sijaan.
const runImageJob = (task) =>
  new Promise((resolve, reject) => {
    const start = () => {
      active++;
      Promise.resolve()
        .then(task)
        .then(resolve, reject)
        .finally(() => {
          active--;
          queue.shift()?.();
        });
    };
    if (active < 2) start();
    else if (queue.length < 8) queue.push(start);
    else
      reject(
        new ImageProcessingError(
          429,
          "Image processing is busy; try again shortly",
        ),
      );
  });

const isSafeImageName = (filename) =>
  typeof filename === "string" &&
  filename.length <= 160 &&
  !filename.startsWith(".") &&
  /^[\w.-]+\.(?:jpe?g|png|webp|gif)$/i.test(filename);
const variantPath = (directory, filename, variant) =>
  path.join(directory, ".variants", "v1", variant, `${filename}.webp`);

// EN: Decode only the first frame, honour EXIF orientation, and bound pixels before resizing; originals stay untouched.
// FI: Pura vain ensimmäinen kehys, huomioi EXIF-suunta ja rajaa pikselit ennen koon muutosta; alkuperäiskuvat säilyvät ennallaan.
const openImage = async (data) => {
  const image = sharp(data, {
    limitInputPixels: MAX_INPUT_PIXELS,
    failOn: "warning",
    pages: 1,
  });
  try {
    const metadata = await image.metadata();
    if (
      !["jpeg", "png", "webp", "gif"].includes(metadata.format) ||
      !metadata.width ||
      !metadata.height ||
      metadata.width > MAX_INPUT_EDGE ||
      metadata.height > MAX_INPUT_EDGE ||
      metadata.width * metadata.height > MAX_INPUT_PIXELS
    )
      throw new Error("Unsupported image dimensions");
    return image;
  } catch {
    throw new ImageProcessingError(
      400,
      "Image is invalid or exceeds 24 megapixels / 8000 pixels per side",
    );
  }
};
const render = async (image, variant) => {
  try {
    const { width, height, quality } = variants[variant];
    return await image
      .clone()
      .rotate()
      .resize({ width, height, fit: "inside", withoutEnlargement: true })
      .webp({ quality })
      .timeout({ seconds: 15 })
      .toBuffer();
  } catch {
    throw new ImageProcessingError(
      400,
      "Image contents could not be decoded safely",
    );
  }
};

// EN: Publish completed derivatives atomically so concurrent readers never receive a partial WebP.
// FI: Julkaise valmiit johdannaiskuvat atomisesti, jotta rinnakkaiset lukijat eivät saa osittaista WebP-kuvaa.
const writeVariant = async (destination, data) => {
  await fs.mkdir(path.dirname(destination), { recursive: true });
  const temporary = `${destination}.${randomUUID()}.tmp`;
  try {
    await fs.writeFile(temporary, data, { flag: "wx" });
    await fs.rename(temporary, destination);
  } finally {
    await fs.unlink(temporary).catch((error) => {
      if (error.code !== "ENOENT") throw error;
    });
  }
};

const storeImageWithVariants = (file, { uploadDirectory, prefix = "" }) =>
  runImageJob(async () => {
    const image = await openImage(file.data);
    const card = await render(image, "card");
    const detail = await render(image, "detail");
    const filename = `${prefix}${randomUUID()}${path.extname(file.name).toLowerCase()}`;
    const original = path.join(uploadDirectory, filename);
    const outputs = Object.keys(variants).map((variant) =>
      variantPath(uploadDirectory, filename, variant),
    );
    await fs.mkdir(uploadDirectory, { recursive: true });
    try {
      await fs.writeFile(original, file.data, { flag: "wx" });
      await writeVariant(outputs[0], card);
      await writeVariant(outputs[1], detail);
      return filename;
    } catch (error) {
      await Promise.all(
        [original, ...outputs].map((filePath) =>
          fs.unlink(filePath).catch((failure) => {
            if (failure.code !== "ENOENT") throw failure;
          }),
        ),
      );
      throw error;
    }
  });

const ensureImageVariant = async (directory, filename, variant) => {
  if (!isSafeImageName(filename) || !Object.hasOwn(variants, variant))
    throw new ImageProcessingError(404, "Image not found");
  const source = path.join(directory, filename);
  const stat = await fs.lstat(source);
  if (!stat.isFile() || stat.size <= 0 || stat.size > MAX_SOURCE_BYTES)
    throw new ImageProcessingError(404, "Image not found");
  const destination = variantPath(directory, filename, variant);
  try {
    await fs.access(destination);
    return destination;
  } catch (error) {
    if (error.code !== "ENOENT") throw error;
  }
  const key = `${source}\0${variant}`;
  // EN: Repeated requests for the same legacy variant share one job; no bulk rewrite of existing originals occurs.
  // FI: Saman vanhan kuvaversion toistuvat pyynnöt jakavat yhden työn; alkuperäiskuvia ei kirjoiteta massana uudelleen.
  if (!pending.has(key)) {
    const job = runImageJob(async () => {
      const data = await fs.readFile(source);
      if (data.length > MAX_SOURCE_BYTES)
        throw new ImageProcessingError(404, "Image not found");
      const image = await openImage(data);
      await writeVariant(destination, await render(image, variant));
      return destination;
    }).finally(() => pending.delete(key));
    pending.set(key, job);
  }
  return pending.get(key);
};

// EN: Remove the source first, wait for its in-flight derivatives, then remove cache files; callers must check references first.
// FI: Poista ensin lähde, odota sen käynnissä olevat kuvaversiot ja poista sitten välimuistit; kutsujan on ensin tarkistettava viitteet.
const removeImageArtifacts = async (directory, filename) => {
  if (!isSafeImageName(filename)) return;
  const source = path.join(directory, filename);
  await fs.unlink(source).catch((error) => {
    if (error.code !== "ENOENT") throw error;
  });
  await Promise.allSettled(
    [...pending.entries()]
      .filter(([key]) => key.startsWith(`${source}\0`))
      .map(([, job]) => job),
  );
  await Promise.all(
    Object.keys(variants).map((variant) =>
      fs.unlink(variantPath(directory, filename, variant)).catch((error) => {
        if (error.code !== "ENOENT") throw error;
      }),
    ),
  );
};

module.exports = {
  ImageProcessingError,
  storeImageWithVariants,
  ensureImageVariant,
  removeImageArtifacts,
};
