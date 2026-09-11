#!/usr/bin/env node
// End-to-end test for figma_parse_local_fig (extensions/figma.ts) — runs
// OUTSIDE pi with a fake ExtensionAPI. Isolated: exports go to a tmp dir
// (PI_FIGMA_EXPORT_DIR); the parsed fixture is a tiny committed .fig.
//
//   node scripts/figma-parse-e2e.mjs
//
// Covers:
//   1. explicit path   → parsed header, frame list, assets written to disk
//   2. frame filter    → subtree JSON with nested children
//   3. embed:false     → no inline image content
//   4. bad path        → loud error, never silent undefined propagation
//
// Exit code 0 = ALL ... PASSED.

import { existsSync, mkdirSync, readdirSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const pkgRoot = path.dirname(here);

const OUT = path.join(os.tmpdir(), `pi-figma-parse-e2e-${process.pid}`);
rmSync(OUT, { recursive: true, force: true });
process.env.PI_FIGMA_EXPORT_DIR = OUT;
process.env.PI_FIGMA_BRIDGE_PORT = String(30000 + (process.pid % 20000));

const mod = await import(path.join(pkgRoot, "extensions", "figma.ts"));
const tools = {};
mod.default({
  registerTool: (t) => (tools[t.name] = t),
  registerCommand: () => {},
  on: () => {},
});

let passed = 0;
let failed = 0;
function assert(cond, name, detail) {
  if (cond) {
    passed++;
    console.log(`PASSED ${name}`);
  } else {
    failed++;
    console.log(`FAILED ${name}${detail ? ` — ${detail}` : ""}`);
  }
}

const tool = tools.figma_parse_local_fig;
assert(typeof tool?.execute === "function", "tool registered");

const fixture = path.join(pkgRoot, "fixtures", "figma", "circle.fig");

// ---------- 1. explicit path ----------
const res = await tool.execute("e2e-1", { path: fixture, embed: false });
const text = res?.content?.[0]?.text ?? "";
assert(text.startsWith("parsed:"), "parse succeeds with explicit path", text.slice(0, 120));
assert(/top-level frames \(\d+\):/.test(text), "frame list present", text.slice(0, 200));
assert(res.details.frames >= 1 && Array.isArray(res.details.frameNames), "details carry frame metadata");
const assetsDir = res.details.assetsDir;
assert(existsSync(path.join(assetsDir, "thumbnail.png")), "thumbnail.png written to disk");
assert(existsSync(path.join(assetsDir, "images")), "images/ dir written to disk");
assert(!res.content.some((c) => c.type === "image"), "embed:false returns no inline image");

// ---------- 2. frame subtree ----------
const frameName = res.details.frameNames[0];
assert(!!frameName, "at least one named frame in fixture", JSON.stringify(res.details.frameNames));
const res2 = await tool.execute("e2e-2", { path: fixture, frame: frameName, embed: false });
const text2 = res2?.content?.[0]?.text ?? "";
assert(text2.includes("resolved node") && text2.includes(frameName), "subtree header for matched frame", text2.slice(-200));
assert(/- /.test(text2) && (/(text|fills):/.test(text2) || /INSTANCE|ELLIPSE|RECTANGLE/.test(text2)), "subtree contains rendered node lines", text2.slice(-300));
assert(res2.details.chosenFrame === frameName, "details.chosenFrame set");

// ---------- 3. frame miss is loud ----------
const res3 = await tool.execute("e2e-3", { path: fixture, frame: "definitely-not-a-frame-xyz", embed: false });
assert((res3?.content?.[0]?.text ?? "").includes("no top-level frame matching"), "unknown frame errors loudly");

// ---------- 4. bad path errors loudly ----------
const res4 = await tool.execute("e2e-4", { path: "/nonexistent/whatever.fig" });
assert((res4?.content?.[0]?.text ?? "").startsWith("error:"), "missing file errors loudly");

// ---------- summary ----------
console.log(`\nfigma-parse: ${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
console.log("ALL PARSE TESTS PASSED");