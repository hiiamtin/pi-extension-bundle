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
import { existsSync, mkdirSync, rmSync, symlinkSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const pkgRoot = path.dirname(here);

// isolate bg-task test tasks from the real state dir (~/.pi/agent/bg-tasks)
import os from "node:os";
process.env.PI_BG_STATE_DIR = path.join(os.tmpdir(), `pi-bg-smoke-${process.pid}`);

// --- installed pi version -------------------------------------------------
let piVersion = "unknown";
try {
  const req = createRequire(path.join(pkgRoot, "noop.js"));
  piVersion = req("@earendil-works/pi-coding-agent/package.json").version;
} catch {
  try { piVersion = execSync("pi --version").toString().trim(); } catch {}
}
console.log(`installed pi version: ${piVersion}`);

// --- make @earendil-works/* importable for bare node -----------------------
// Extensions may runtime-import @earendil-works/* (btw.ts → buildSessionContext,
// matchesKey; pi's loader maps those specifiers itself, bare node cannot).
// Symlink the installed packages into the bundle's node_modules (gitignored,
// same pattern as the existing typebox link) so this harness can load them.
// If pi isn't found, affected extensions fall back to the skip path below.
function resolveGlobalRoot() {
  try {
    const root = execSync("npm root -g", { encoding: "utf8" }).trim();
    if (root && existsSync(path.join(root, "@earendil-works", "pi-coding-agent"))) return root;
  } catch {}
  try {
    const bin = execSync("which pi", { encoding: "utf8" }).trim();
    const real = execSync(`readlink -f "${bin}"`, { encoding: "utf8" }).trim() || bin;
    const pkgDir = path.resolve(real, "../../.."); // .../pi-coding-agent
    if (existsSync(pkgDir)) return path.dirname(path.dirname(pkgDir)); // .../lib/node_modules
  } catch {}
  return null;
}
const linked = [];
{
  const root = resolveGlobalRoot();
  if (root) {
    const srcBase = path.join(root, "@earendil-works");
    const dstBase = path.join(pkgRoot, "node_modules", "@earendil-works");
    mkdirSync(dstBase, { recursive: true });
    for (const pkg of ["pi-coding-agent", "pi-tui", "pi-ai"]) {
      const srcNested = path.join(srcBase, "pi-coding-agent", "node_modules", "@earendil-works", pkg);
      const src = existsSync(path.join(srcBase, pkg)) ? path.join(srcBase, pkg) : srcNested;
      const dst = path.join(dstBase, pkg);
      if (!existsSync(src) || existsSync(dst)) continue;
      try {
        rmSync(dst, { force: true }); // clear dangling links
        symlinkSync(src, dst);
        linked.push(pkg);
      } catch {}
    }
  }
}
if (linked.length) console.log(`linked into node_modules/@earendil-works: ${linked.join(", ")}`);

// --- fake ExtensionAPI capturing tools + commands -------------------------
const registered = {};
const commands = {};
const fakePi = {
  registerTool: (t) => { registered[t.name] = t; },
  registerCommand: (name, opts) => { commands[name] = opts; },
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
const skipped = [];
for (const f of files) {
  try {
    const mod = await import(path.join(pkgRoot, "extensions", f));
    mod.default(fakePi);
  } catch (e) {
    const msg = String(e?.message ?? e);
    // Extensions may runtime-import @earendil-works/* (e.g. btw.ts →
    // buildSessionContext, matchesKey). pi's own loader resolves those for
    // extensions; this bare-node harness cannot. Skip such files instead of
    // crashing the whole run — they must still be verified inside real pi.
    if (/Cannot find package '@earendil-works\//.test(msg)) {
      skipped.push(`${f} (imports runtime-provided @earendil-works/* — verify in pi)`);
      continue;
    }
    console.error(`LOAD FAILED: ${f}: ${msg}`);
    process.exit(1);
  }
}
for (const s of skipped) console.log(`skipped: ${s}`);
const names = Object.keys(registered);
console.log(`registered tools: ${names.join(", ") || "(none)"}`);
if (names.length === 0 && skipped.length >= files.length) {
  console.error("every extension was skipped — nothing to smoke test");
  process.exit(1);
}

// --- minimal valid args per tool ------------------------------------------
const MIN_ARGS = {
  web_search: { query: "pi extension smoke test", numResults: 1 },
  quota_check: {},
  web_fetch: { url: "https://example.com" },
  code_search: { query: "hello world" },
  code_find_related: { file_path: "extensions/ext.ts", line: 1 },
  bg_run: { command: "echo smoke-bg-ok" },
  bg_status: {},
  bg_log: { id: "nope-smoke" },
  bg_kill: { id: "nope-smoke" },
  bg_artifact: { path: "package.json" },
};

let failures = 0;

// --- command registration + completions -----------------------------------
const commandNames = Object.keys(commands);
console.log(`registered commands: ${commandNames.map((n) => `/${n}`).join(" ") || "(none)"}`);
for (const name of commandNames) {
  const fn = commands[name].getArgumentCompletions;
  if (typeof fn !== "function") continue;
  let bad = 0;
  for (const prefix of ["", "level ", "show ", "bring ", "clear"]) {
    try {
      const items = fn.call(commands[name], prefix);
      const valid =
        items === null ||
        (Array.isArray(items) &&
          items.every((i) => i && typeof i.value === "string" && typeof i.label === "string"));
      if (!valid) {
        console.log(`FAIL /${name} completions("${prefix}") malformed items`);
        bad++;
      }
    } catch (e) {
      console.log(`FAIL /${name} completions("${prefix}") threw: ${e.message}`);
      bad++;
    }
  }
  if (bad === 0) console.log(`ok   /${name} completions (5 prefixes)`);
  failures += bad;
}
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
