const { test } = require("node:test");
const assert = require("node:assert/strict");
const { once } = require("node:events");
const { gzipSync } = require("node:zlib");
const express = require("express");
const bodyParser = require("body-parser");
const proxyAddress = require("proxy-addr");

// EN: Malformed compressed bodies must not terminate the process before authentication or routing.
// FI: Virheelliset pakatut pyynnöt eivät saa pysäyttää prosessia ennen tunnistusta tai reititystä.
test("HTTP parsing survives compressed trailing bytes and continues accepting valid JSON", async (t) => {
  const app = express();
  app.use(bodyParser.json());
  app.use(bodyParser.urlencoded({ extended: true }));
  app.post("/parse", (req, res) => res.json(req.body));
  app.use((_error, _req, res, _next) =>
    res.status(400).json({ error: "Invalid body" }),
  );
  const server = app.listen(0, "127.0.0.1");
  await once(server, "listening");
  t.after(() => new Promise((resolve) => server.close(resolve)));
  const url = `http://127.0.0.1:${server.address().port}/parse`;
  const response = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json", "Content-Encoding": "gzip" },
    body: Buffer.concat([
      gzipSync(Buffer.from('{"value":1}')),
      Buffer.from([0x13, 0x37]),
    ]),
  });
  assert.ok([200, 400].includes(response.status));
  await response.text();
  await new Promise(setImmediate);
  const valid = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: '{"value":2}',
  });
  assert.equal(valid.status, 200);
  assert.deepEqual(await valid.json(), { value: 2 });
});

// EN: A short IPv4-mapped IPv6 prefix must not trust arbitrary IPv4 clients as proxies.
// FI: Lyhyt IPv4-kuvattu IPv6-etuliite ei saa luottaa kaikkiin IPv4-asiakkaisiin välityspalvelimina.
test("proxy subnet matching rejects an unrelated IPv4 client under an IPv6 prefix", () => {
  assert.equal(
    proxyAddress.compile("::ffff:10.0.0.0/8")("198.51.100.5"),
    false,
  );
  const trusted = proxyAddress.compile("10.0.0.0/8");
  assert.equal(trusted("10.1.2.3"), true);
  assert.equal(trusted("198.51.100.5"), false);
});
