const { randomUUID } = require("node:crypto");
const fs = require("node:fs/promises");
const path = require("node:path");

const MAX_UPLOAD_BYTES = 5 * 1024 * 1024;
const allowedUploadTypes = {
  "image/jpeg": new Set(["jpg", "jpeg"]),
  "image/png": new Set(["png"]),
  "image/webp": new Set(["webp"]),
  "image/gif": new Set(["gif"]),
};

// Validates has valid image signature before it is used.
const hasValidImageSignature = (mimeType, data) => {
  const bytes = Buffer.isBuffer(data) ? data : Buffer.from(data || []);
  if (mimeType === "image/jpeg")
    return (
      bytes.length >= 3 &&
      bytes[0] === 0xff &&
      bytes[1] === 0xd8 &&
      bytes[2] === 0xff
    );
  if (mimeType === "image/png")
    return (
      bytes.length >= 8 &&
      bytes
        .subarray(0, 8)
        .equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))
    );
  if (mimeType === "image/gif")
    return (
      bytes.length >= 6 &&
      (bytes.subarray(0, 6).toString("ascii") === "GIF87a" ||
        bytes.subarray(0, 6).toString("ascii") === "GIF89a")
    );
  return (
    mimeType === "image/webp" &&
    bytes.length >= 12 &&
    bytes.subarray(0, 4).toString("ascii") === "RIFF" &&
    bytes.subarray(8, 12).toString("ascii") === "WEBP"
  );
};

// Validates the uploaded image before storage.
const validateImageFile = (file, { requiredMessage, sizeMessage }) => {
  if (!file || Array.isArray(file)) return { error: requiredMessage };
  const extension = path
    .extname(file.name || "")
    .slice(1)
    .toLowerCase();
  if (!allowedUploadTypes[file.mimetype]?.has(extension))
    return { error: "Only JPEG, PNG, WEBP, or GIF images are allowed" };
  if (
    !Number.isInteger(file.size) ||
    file.size <= 0 ||
    file.size > MAX_UPLOAD_BYTES
  )
    return { error: sizeMessage };
  if (!hasValidImageSignature(file.mimetype, file.data))
    return { error: "Image contents do not match its file type" };
  return { extension };
};

// Coordinates store image behavior for this module.
const storeImage = async (file, { uploadDirectory, prefix = "" }) => {
  const extension = path
    .extname(file.name || "")
    .slice(1)
    .toLowerCase();
  const fileName = `${prefix}${randomUUID()}.${extension}`;
  await fs.mkdir(uploadDirectory, { recursive: true });
  await new Promise((resolve, reject) =>
    file.mv(path.join(uploadDirectory, fileName), (error) =>
      error ? reject(error) : resolve(),
    ),
  );
  return fileName;
};

module.exports = {
  MAX_UPLOAD_BYTES,
  validateImageFile,
  storeImage,
};
