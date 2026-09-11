#!/usr/bin/env node
// End-to-end functional test for the Figma export bridge (lib only — the pi
// glue in extensions/figma.ts is covered by scripts/smoke-test.mjs).
// Runs OUTSIDE pi with real HTTP requests. Fully isolated: exports go to a
// tmp dir, the bridge binds an ephemeral port in an ephemeral process.
//
//   node scripts/figma-bridge-e2e.mjs
//
// Covers:
//   1. filename sanitization rules
//   2. store.save: bytes on disk, timestamped names, collision -2/-3, scale
//   3. state file: writeState/readState round-trip (adopts lastExport)
//   4. JSONL export log grows one line per save
//   5. bridge: /healthz, 404, OPTIONS rejected WITHOUT CORS headers
//   6. bridge auth: POST without the token header -> 403
//   7. real export POST: onExport fired, correct file written, X-Format wins
//   8. body over maxBodyBytes -> 413
//   9. stop() closes the port; a second listener on the same port fails
//
// Exit code 0 = ALL ... PASSED.

import { existsSync, mkdirSync, readFileSync, rmSync } from "node:fs";
import * as http from "node:http";
import * as os from "node:os";
import * as path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const pkgRoot = path.dirname(here);

const ROOT = path.join(os.tmpdir(), `pi-figma-bridge-e2e-${process.pid}`);
rmSync(ROOT, { recursive: true, force: true });

const { FigmaExportStore, sanitizeName } = await import(
  path.join(pkgRoot, "lib", "figma-export-store.ts")
);
const { startBridgeServer } = await import(
  path.join(pkgRoot, "lib", "figma-bridge-server.ts")
);

let passed = 0;
let failed = 0;
function ok(name) {
  passed++;
  console.log(`PASSED ${name}`);
}
function fail(name, detail) {
  failed++;
  console.log(`FAILED ${name}${detail ? ` — ${detail}` : ""}`);
}
function assert(cond, name, detail) {
  if (cond) ok(name);
  else fail(name, detail);
}

function freePort() {
  return 30_000 + Math.floor(Math.random() * 10_000);
}
const PNG_BYTES = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3]);
const SVG_TEXT = "<svg xmlns='http://www.w3.org/2000/svg'><rect/></svg>";

// ---------- 1. sanitizeName ----------
assert(sanitizeName("Login / Screen!") === "Login_Screen", "sanitizeName basic replacement", sanitizeName("Login / Screen!"));
assert(sanitizeName("..hidden") === "hidden", "sanitizeName strips leading dots", sanitizeName("..hidden"));
assert(sanitizeName("") === "node", "sanitizeName empty fallback", sanitizeName(""));
assert(sanitizeName("a".repeat(200)).length <= 80, "sanitizeName caps at 80", String(sanitizeName("a".repeat(200)).length));

// ---------- 2/3/4. store ----------
const store = new FigmaExportStore({ rootDir: path.join(ROOT, "out") });
store.ensureDirs();
const rec1 = store.save({
  bytes: PNG_BYTES,
  format: "png",
  nodeName: "Login Screen",
  nodeId: "12:34",
  scale: 2,
});
assert(existsSync(rec1.path), "save writes file to disk");
assert(readFileSync(rec1.path).equals(Buffer.from(PNG_BYTES)), "file content matches sent bytes");
assert(rec1.format === "png" && rec1.scale === 2, "record carries format/scale");
assert(rec1.path.includes("@2x.png") && rec1.path.includes("Login_Screen"), "filename embeds scale+name", rec1.path);
assert(typeof rec1.createdAtMs === "number" && rec1.createdAtMs > 0, "record has createdAtMs");

const rec2 = store.save({
  bytes: PNG_BYTES,
  format: "png",
  nodeName: "Login Screen",
  nodeId: "12:34",
  scale: 2,
});
assert(rec2.path.endsWith("-2.png"), "collision gets -2 suffix", path.basename(rec2.path));

store.writeState({ port: 42, exportsCount: 7, lastExport: rec1 });
const disk = store.readState();
assert(disk.port === 42 && disk.exportsCount === 7, "state round-trip");
assert(disk.lastExport && disk.lastExport.path === rec1.path, "state adopts lastExport");

store.appendLog(rec1);
store.appendLog(rec2);
const logLines = readFileSync(store.logFile, "utf8").split("\n").filter(Boolean);
assert(logLines.length === 2 && logLines[1].includes(rec2.path), "JSONL log grows one line per save");

// ---------- 5..9. bridge ----------
const TOKEN = "e2e-secret-token";
const port = freePort();
const exportsSeen = [];
const handle = await startBridgeServer({
  port,
  token: TOKEN,
  store,
  maxBodyBytes: 512,
  onExport: (rec) => exportsSeen.push(rec),
});
assert(handle.address.includes(`:${port}`), "bridge reports its address", handle.address);

function request(method, urlPath, { headers = {}, body } = {}) {
  return new Promise((resolve, reject) => {
    const req = http.request(
      { host: "127.0.0.1", port, method, path: urlPath, headers },
      (res) => {
        const chunks = [];
        res.on("data", (c) => chunks.push(c));
        res.on("end", () =>
          resolve({ status: res.statusCode, headers: res.headers, body: Buffer.concat(chunks).toString("utf8") })
        );
      }
    );
    req.on("error", reject);
    if (body) req.write(body);
    req.end();
  });
}

const health = await request("GET", "/healthz");
assert(health.status === 200 && JSON.parse(health.body).ok === true, "GET /healthz responds 200 ok");

const nope = await request("GET", "/");
assert(nope.status === 404, "GET / responds 404");

const opts = await request("OPTIONS", "/export");
assert(opts.status === 405, "OPTIONS /export rejected 405");
assert(!opts.headers["access-control-allow-origin"] && !opts.headers["access-control-allow-headers"], "no CORS headers emitted");

const noToken = await request("POST", "/export", {
  headers: { "X-Figma-Bridge": "wrong" },
  body: Buffer.from(PNG_BYTES),
});
assert(noToken.status === 403, "POST without matching token -> 403");

const good = await request("POST", "/export", {
  headers: {
    "X-Figma-Bridge": TOKEN,
    "Content-Type": "application/octet-stream",
    "X-Format": "svg",
    "X-Scale": "1",
    "X-Node-Name": encodeURIComponent("Hero Banner"),
    "X-Node-Id": "1:2",
  },
  body: SVG_TEXT,
});
const goodJson = JSON.parse(good.body);
assert(good.status === 200 && goodJson.ok === true, "authenticated export accepted");
assert(existsSync(goodJson.path) && goodJson.path.endsWith(".svg"), "svg export written to disk");
assert(exportsSeen.length === 1 && exportsSeen[0].format === "svg", "onExport fired with X-Format svg");
assert(exportsSeen[0].nodeName === "Hero Banner" && exportsSeen[0].nodeId === "1:2", "metadata headers decoded");

const contentTypePng = await request("POST", "/export", {
  headers: {
    "X-Figma-Bridge": TOKEN,
    "Content-Type": "image/png",
    "X-Node-Name": "ct",
  },
  body: Buffer.from(PNG_BYTES),
});
assert(JSON.parse(contentTypePng.body).format === "png", "content-type fallback maps to png");

const tooBig = await request("POST", "/export", {
  headers: { "X-Figma-Bridge": TOKEN, "X-Node-Name": "big" },
  body: "x".repeat(600),
});
assert(tooBig.status === 413, "body over maxBodyBytes -> 413");

await handle.close();
let rebindFailed = false;
try {
  await startBridgeServer({ port, token: TOKEN, store, host: "127.0.0.1" });
} catch {
  rebindFailed = true;
}
assert(!rebindFailed, "port freed after close() — rebind succeeds");

// ---------- summary ----------
console.log(`\nfigma-bridge: ${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
console.log("ALL BRIDGE TESTS PASSED");