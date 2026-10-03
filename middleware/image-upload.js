const busboy = require("busboy");
const { Transform } = require("node:stream");
const { MAX_UPLOAD_BYTES } = require("../lib/image-upload");

const MAX_UPLOAD_BODY_BYTES = MAX_UPLOAD_BYTES + 64 * 1024;
const MAX_CONCURRENT_UPLOADS = 4;
const UPLOAD_TIMEOUT_MS = 60_000;
let activeUploads = 0;

// EN: Mount after authentication/admin checks; bound the whole body, one file, and concurrent buffers before storage.
// FI: Liitä tunnistautumis- ja admin-tarkistusten jälkeen; rajaa koko pyyntö, yksi tiedosto ja rinnakkaiset puskurit ennen tallennusta.
const parseImageUpload = (req, res, next) => {
  if (!req.is("multipart/form-data")) return next();

  const reject = (status, error) => {
    // EN: Discard unread input without buffering; closing mid-write can reset the socket before the JSON error arrives.
    // FI: Hylkää lukematon sisältö puskuroimatta; sulkeminen kesken kirjoituksen voi nollata yhteyden ennen JSON-virheen saapumista.
    req.resume();
    res.status(status).send({ error });
  };
  if (Number(req.headers["content-length"]) > MAX_UPLOAD_BODY_BYTES)
    return reject(413, "Upload request is too large");
  if (activeUploads >= MAX_CONCURRENT_UPLOADS) {
    res.set("Retry-After", "2");
    return reject(429, "Too many uploads; try again shortly");
  }

  let parser;
  try {
    parser = busboy({
      headers: req.headers,
      limits: {
        // EN: Busboy fires at the limit itself; allow the existing inclusive 5 MiB boundary, rejecting the next byte.
        // FI: Busboy ilmoittaa rajasta jo rajalla; salli nykyinen 5 MiB:n koko ja hylkää seuraava tavu.
        fileSize: MAX_UPLOAD_BYTES + 1,
        files: 1,
        fields: 0,
        parts: 2,
        fieldSize: 1024,
      },
    });
  } catch {
    return reject(400, "Invalid multipart upload");
  }

  activeUploads++;
  let chunks = [];
  let fileInfo;
  let fileBytes = 0;
  let bodyBytes = 0;
  let failed = false;
  let parsed = false;
  let released = false;
  const body = new Transform({
    transform(chunk, _encoding, callback) {
      bodyBytes += chunk.length;
      if (bodyBytes > MAX_UPLOAD_BODY_BYTES) {
        fail(413, "Upload request is too large");
        return callback();
      }
      callback(null, chunk);
    },
  });
  const timer = setTimeout(
    () => fail(408, "Upload timed out"),
    UPLOAD_TIMEOUT_MS,
  );
  timer.unref();

  const stopParsing = () => {
    clearTimeout(timer);
    req.unpipe(body);
    body.unpipe(parser);
    chunks = [];
    // EN: Destroy after the current parser callback to avoid re-entering Busboy while it updates a file limit.
    // FI: Tuhoa nykyisen parserikutsun jälkeen, jotta Busboyn tiedostorajan päivitykseen ei palata kesken suorituksen.
    queueMicrotask(() => {
      body.destroy();
      parser.destroy();
    });
  };
  const release = () => {
    if (released) return;
    released = true;
    activeUploads--;
    clearTimeout(timer);
    req.off("aborted", onAbort);
    res.off("finish", release);
    res.off("close", onClose);
  };
  const onAbort = () => {
    failed = true;
    stopParsing();
    release();
  };
  const onClose = () => {
    if (!parsed) onAbort();
    else release();
  };
  const fail = (status, error) => {
    if (failed || parsed) return;
    failed = true;
    stopParsing();
    if (!res.destroyed && !res.headersSent) reject(status, error);
  };
  req.once("aborted", onAbort);
  res.once("finish", release);
  res.once("close", onClose);
  body.on("error", () => fail(400, "Invalid multipart upload"));
  parser.on("error", () => fail(400, "Invalid multipart upload"));
  parser.on("filesLimit", () => fail(400, "One image file is required"));
  parser.on("fieldsLimit", () => fail(400, "Only the file field is allowed"));
  parser.on("partsLimit", () => fail(400, "One image file is required"));
  parser.on("file", (name, file, info) => {
    file.on("error", () => fail(400, "Invalid multipart upload"));
    if (failed || name !== "file" || !info.filename) {
      file.resume();
      return fail(400, "One image file is required");
    }
    fileInfo = info;
    file.on("limit", () => fail(413, "Image must not exceed 5 MB"));
    file.on("data", (chunk) => {
      if (failed) return;
      fileBytes += chunk.length;
      if (fileBytes > MAX_UPLOAD_BYTES)
        return fail(413, "Image must not exceed 5 MB");
      chunks.push(chunk);
    });
  });
  parser.on("close", () => {
    if (failed) return;
    parsed = true;
    clearTimeout(timer);
    if (fileInfo) {
      const data = Buffer.concat(chunks, fileBytes);
      chunks = [];
      req.files = {
        file: {
          name: fileInfo.filename,
          mimetype: fileInfo.mimeType,
          size: fileBytes,
          data,
          truncated: false,
        },
      };
    }
    next();
  });
  req.pipe(body).pipe(parser);
};

module.exports = {
  parseImageUpload,
  MAX_UPLOAD_BODY_BYTES,
  MAX_CONCURRENT_UPLOADS,
};
