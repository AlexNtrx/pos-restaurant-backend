const { after, before, test } = require("node:test");
const assert = require("node:assert/strict");
const http = require("node:http");
const fs = require("node:fs/promises");
const path = require("node:path");
const {
  prisma,
  createTestFixture,
  cleanupTestFixture,
  headersFor,
  startApiServer,
  stopApiServer,
} = require("./helpers");
const { MAX_UPLOAD_BYTES } = require("../lib/image-upload");
const {
  MAX_UPLOAD_BODY_BYTES,
  MAX_CONCURRENT_UPLOADS,
} = require("../middleware/image-upload");

const boundary = "pos-upload-test-boundary";
const { png } = require("./image-fixture");
const { removeImageArtifacts } = require("../lib/image-variants");
const sharp = require("sharp");
const routes = ["/food/upload", "/organization/upload"];
const savedFiles = [];
let fixture, server, apiBaseUrl;

const filePart = (bytes = png, name = "file") =>
  Buffer.concat([
    Buffer.from(
      `--${boundary}\r\nContent-Disposition: form-data; name="${name}"; filename="image.png"\r\nContent-Type: image/png\r\n\r\n`,
    ),
    bytes,
    Buffer.from("\r\n"),
  ]);
const multipart = (...parts) =>
  Buffer.concat([...parts, Buffer.from(`--${boundary}--\r\n`)]);
const headers = (user = fixture.admin) => ({
  Authorization: headersFor(user).Authorization,
  "Content-Type": `multipart/form-data; boundary=${boundary}`,
});

// EN: Raw HTTP keeps chunked uploads and unfinished requests observable instead of buffering the complete client body.
// FI: Raaka HTTP mahdollistaa paloittaiset ja keskeneräiset pyynnöt ilman koko asiakaspyynnön puskurointia.
const request = (route, body, requestHeaders = headers()) =>
  new Promise((resolve, reject) => {
    const req = http.request(
      apiBaseUrl + route,
      {
        method: "POST",
        headers: { Connection: "keep-alive", ...requestHeaders },
        agent: false,
      },
      (res) => {
        let text = "";
        res.setEncoding("utf8");
        res.on("data", (chunk) => (text += chunk));
        res.on("end", () => {
          resolve({ status: res.statusCode, headers: res.headers, text });
          req.destroy();
        });
        res.on("error", reject);
      },
    );
    req.on("error", reject);
    req.setTimeout(5000, () =>
      req.destroy(new Error("Test request timed out")),
    );
    if (body === undefined) req.flushHeaders();
    else req.end(body);
  });

before(async () => {
  fixture = await createTestFixture();
  ({ server, apiBaseUrl } = await startApiServer());
});
after(async () => {
  await stopApiServer(server);
  await Promise.all(
    savedFiles.map((file) =>
      removeImageArtifacts(path.resolve("uploads"), file),
    ),
  );
  await cleanupTestFixture(fixture);
  await prisma.$disconnect();
  await require("../lib/prisma").$disconnect();
});

test("upload authorization responds before reading an unfinished or malformed multipart body", async () => {
  for (const route of routes) {
    for (const [requestHeaders, expected] of [
      [{ "Content-Type": "multipart/form-data" }, 401],
      [
        {
          Authorization: headersFor(fixture.user).Authorization,
          "Content-Type": "multipart/form-data",
          "Content-Length": MAX_UPLOAD_BODY_BYTES + 1,
        },
        403,
      ],
    ]) {
      const response = await request(route, undefined, requestHeaders);
      assert.equal(response.status, expected);
    }
  }
});

test("both upload routes preserve UUID storage and the inclusive 5 MiB file boundary", async () => {
  const largestImage = Buffer.alloc(MAX_UPLOAD_BYTES);
  png.copy(largestImage);
  for (const route of routes) {
    for (const bytes of [png, largestImage]) {
      const body = multipart(filePart(bytes));
      const response = await request(route, body, {
        ...headers(),
        "Content-Length": body.length,
      });
      assert.equal(response.status, 201, response.text);
      const { fileName } = JSON.parse(response.text);
      assert.match(fileName, /^(logo_)?[0-9a-f-]+\.png$/);
      savedFiles.push(fileName);
      const imageUrl =
        apiBaseUrl.replace(/\/api$/, "") + `/uploads/variants/card/${fileName}`;
      const image = await fetch(imageUrl);
      const derivativeBytes = Buffer.from(await image.arrayBuffer());
      assert.equal(image.status, 200);
      assert.equal(image.headers.get("content-type"), "image/webp");
      assert.match(image.headers.get("cache-control"), /max-age=86400/);
      assert.equal((await sharp(derivativeBytes).metadata()).width, 2);
      assert.equal(
        (
          await fetch(imageUrl, {
            headers: { "If-None-Match": image.headers.get("etag") },
            // EN: Request revalidation explicitly; Undici's default conditional request adds no-cache, which forces a fresh 200 response.
            // FI: Pyydä uudelleenvalidointia erikseen; Undicin oletusarvoinen ehdollinen pyyntö lisää no-cache-arvon, joka pakottaa uuden 200-vastauksen.
            cache: "no-cache",
          })
        ).status,
        304,
      );
      assert.deepEqual(
        await fs.readFile(path.resolve("uploads", fileName)),
        bytes,
      );
    }
  }
});

test("upload checks current account state and ignores a forged admin role claim", async () => {
  for (const route of routes) {
    const response = await request(route, undefined, {
      ...headers({ ...fixture.user, level: "admin" }),
      "Content-Type": "multipart/form-data",
    });
    assert.equal(response.status, 403);
  }
  await prisma.user.update({
    where: { id: fixture.admin.id },
    data: { status: "delete" },
  });
  try {
    for (const route of routes) {
      const response = await request(route, undefined, {
        ...headers(),
        "Content-Type": "multipart/form-data",
      });
      assert.equal(response.status, 401);
    }
  } finally {
    await prisma.user.update({
      where: { id: fixture.admin.id },
      data: { status: fixture.admin.status },
    });
  }
});

test("replacing the primary image preserves a file still used by the detail image", async () => {
  const upload = async () => {
    const response = await request(routes[0], multipart(filePart()));
    assert.equal(response.status, 201, response.text);
    const { fileName } = JSON.parse(response.text);
    savedFiles.push(fileName);
    return fileName;
  };
  const primary = await upload();
  const replacement = await upload();
  await prisma.food.update({
    where: { id: fixture.food.id },
    data: { img: primary, detailImg: primary },
  });
  const update = (detailImg) =>
    fetch(apiBaseUrl + "/food/update", {
      method: "PUT",
      headers: headersFor(fixture.admin),
      body: JSON.stringify({
        ...fixture.food,
        img: replacement,
        detailImg,
      }),
    });
  assert.equal((await update(primary)).status, 200);
  assert.deepEqual(await fs.readFile(path.resolve("uploads", primary)), png);
  assert.equal((await update("")).status, 200);
  await assert.rejects(fs.access(path.resolve("uploads", primary)), {
    code: "ENOENT",
  });
  assert.deepEqual(
    await fs.readFile(path.resolve("uploads", replacement)),
    png,
  );
});

test("oversized, multiple, unexpected, spoofed and truncated uploads never write files", async () => {
  const beforeFiles = (await fs.readdir("uploads")).sort();
  const oversized = Buffer.alloc(MAX_UPLOAD_BYTES + 1);
  png.copy(oversized);
  const cases = [
    [multipart(filePart(oversized)), headers(), 413],
    [Buffer.alloc(MAX_UPLOAD_BODY_BYTES + 1), headers(), 413],
    [multipart(filePart(), filePart()), headers(), 400],
    [multipart(filePart(png, "other")), headers(), 400],
    [
      multipart(
        filePart(),
        Buffer.from(
          `--${boundary}\r\nContent-Disposition: form-data; name="extra"\r\n\r\nvalue\r\n`,
        ),
      ),
      headers(),
      400,
    ],
    [multipart(filePart(Buffer.from("spoof"))), headers(), 400],
    [filePart(), headers(), 400],
    [
      multipart(filePart()),
      { ...headers(), "Content-Type": "multipart/form-data" },
      400,
    ],
    [
      Buffer.alloc(0),
      { ...headers(), "Content-Length": MAX_UPLOAD_BODY_BYTES + 1 },
      413,
    ],
  ];
  for (const route of routes)
    for (const [body, requestHeaders, expected] of cases) {
      const response = await request(route, body, requestHeaders).catch(
        (error) => {
          throw new Error(
            `${route}: expected ${expected}, body ${body.length}`,
            { cause: error },
          );
        },
      );
      assert.equal(response.status, expected, response.text);
      assert.equal(typeof JSON.parse(response.text).error, "string");
    }
  assert.deepEqual((await fs.readdir("uploads")).sort(), beforeFiles);
});

test("bounded concurrent uploads release every slot after client disconnect", async () => {
  const held = [];
  const incoming = [];
  const trackHeld = (req) => {
    if (req.headers["x-test-held-upload"] === "true") incoming.push(req);
  };
  server.on("request", trackHeld);
  try {
    for (let index = 0; index < MAX_CONCURRENT_UPLOADS; index++) {
      const req = http.request(apiBaseUrl + routes[index % routes.length], {
        method: "POST",
        headers: {
          ...headers(),
          Connection: "keep-alive",
          "X-Test-Held-Upload": "true",
        },
        agent: false,
      });
      req.on("error", () => {});
      held.push(req);
      req.write(filePart());
    }
    // EN: Wait until all authenticated requests reach the streaming parser; an early probe could occupy and release their fourth slot.
    // FI: Odota kaikkien tunnistettujen pyyntöjen siirtymistä parseriin; liian aikainen kokeilu voisi varata ja vapauttaa neljännen paikan.
    for (let attempt = 0; attempt < 200; attempt++) {
      if (
        incoming.length === MAX_CONCURRENT_UPLOADS &&
        incoming.every((req) => req.readableFlowing === true)
      )
        break;
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    assert.equal(incoming.length, MAX_CONCURRENT_UPLOADS);
    assert.ok(incoming.every((req) => req.readableFlowing === true));
    let response;
    for (let attempt = 0; attempt < 20; attempt++) {
      response = await request(routes[0], multipart(filePart()));
      if (response.status === 429) break;
      assert.equal(response.status, 201);
      savedFiles.push(JSON.parse(response.text).fileName);
    }
    assert.equal(response.status, 429);
    assert.equal(response.headers["retry-after"], "2");
  } finally {
    server.off("request", trackHeld);
    const closed = held.map((req) =>
      req.closed
        ? Promise.resolve()
        : new Promise((resolve) => req.once("close", resolve)),
    );
    held.forEach((req) => req.destroy());
    await Promise.all(closed);
  }
  let response;
  for (let attempt = 0; attempt < 20; attempt++) {
    response = await request(routes[1], multipart(filePart()));
    if (response.status !== 429) break;
  }
  assert.equal(response.status, 201, response.text);
  savedFiles.push(JSON.parse(response.text).fileName);
});
