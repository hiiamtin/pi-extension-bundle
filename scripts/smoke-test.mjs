#!/usr/bin/env node
// Smoke test for pi extensions in this package.
//
// RUN THIS AFTER EVERY `pi` UPGRADE before real use:
//   node scripts/smoke-test.mjs
//
// What it does:
//   1. Prints the installed pi version (the calling convention depends on it).
//   2. Loads every extension and captures registered tools via a fake API.
//   3. Calls each tool's execute() using BOTH pi calling conventions
//      (legacy execute(params) and modern execute(toolCallId, params))
//      with minimal args, asserting the tool either succeeds or fails LOUDLY
//      (never with silent undefined-propagation errors like HTTP 422).
//
// Exit code 0 = all tools behave under both conventions.

import { createRequire } from "node:module";
import { execSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const pkgRoot = path.dirname(here);

// --- installed pi version -------------------------------------------------
let piVersion = "unknown";
try {
  const req = createRequire(path.join(pkgRoot, "noop.js"));
  piVersion = req("@earendil-works/pi-coding-agent/package.json").version;
} catch {
  try { piVersion = execSync("pi --version").toString().trim(); } catch {}
}
console.log(`installed pi version: ${piVersion}`);

// --- fake ExtensionAPI capturing tools ------------------------------------
const registered = {};
const fakePi = {
  registerTool: (t) => { registered[t.name] = t; },
  registerCommand: () => {},
  on: () => {}, // lifecycle hooks not needed for tool smoke testing
};

// --- load every extension file --------------------------------------------
// Auto-discovers *.ts in extensions/ (or override by passing filenames as args).
const files = process.argv.slice(2).length
  ? process.argv.slice(2)
  : execSync(`ls ${path.join(pkgRoot, "extensions")}/*.ts`, { encoding: "utf8" })
      .split("\n")
      .filter(Boolean)
      .map((p) => path.basename(p));
for (const f of files) {
  const mod = await import(path.join(pkgRoot, "extensions", f));
  mod.default(fakePi);
}
const names = Object.keys(registered);
console.log(`registered tools: ${names.join(", ") || "(none)"}`);
if (names.length === 0) process.exit(1);

// --- minimal valid args per tool ------------------------------------------
const MIN_ARGS = {
  web_search: { query: "pi extension smoke test", numResults: 1 },
  quota_check: {},
  web_fetch: { url: "https://example.com" },
};

let failures = 0;
function looksLikeParamLoss(text) {
  // Signatures of the classic undefined-propagation failure mode.
  return /HTTP 4\d\d/.test(text) && /(Field required|Invalid request body)/i.test(text);
}

for (const name of names) {
  const tool = registered[name];
  const args = MIN_ARGS[name] ?? {};
  for (const conv of ["legacy", "modern"]) {
    let res;
    try {
      res = conv === "modern"
        ? await tool.execute("smoke-call-id", structuredClone(args), new AbortController().signal, undefined, {})
        : await tool.execute(structuredClone(args));
    } catch (e) {
      console.log(`FAIL ${name} [${conv}] threw: ${e.message}`);
      failures++;
      continue;
    }
    const text = res?.content?.[0]?.text ?? "";
    if (looksLikeParamLoss(text)) {
      console.log(`FAIL ${name} [${conv}] param loss: ${text.slice(0, 140)}`);
      failures++;
    } else if (/missing or empty required parameter/.test(text) && Object.keys(args).length > 0) {
      console.log(`FAIL ${name} [${conv}] rejected valid args: ${text.slice(0, 120)}`);
      failures++;
    } else {
      console.log(`ok   ${name} [${conv}] -> ${text.split("\n")[0].slice(0, 90)}`);
    }
  }
}

console.log(failures === 0 ? "\nALL OK" : `\n${failures} FAILURE(S)`);
process.exit(failures === 0 ? 0 : 1);
