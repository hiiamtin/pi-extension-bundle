#!/usr/bin/env node
// End-to-end functional test for the bg-task extension (runs OUTSIDE pi with a
// fake ExtensionAPI — same loader approach as smoke-test.mjs, but exercises
// real behavior: process groups, kill semantics, detach mode, interceptor).
//
//   node scripts/bg-e2e.mjs
//
// Covers:
//   1. bg_run with child processes  → whole process group appears
//   2. bg_status / bg_log           → state + output visible
//   3. bg_kill                      → SIGTERM group, ZERO leftover children
//   4. detach: true                 → exitcode file written, state finalized
//   5. artifact                     → JSON/CSV summaries
//   6. interceptor (default auto-bg)→ follow command becomes a bg task
//
// Exit code 0 = ALL OK.

import { execSync } from "node:child_process";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";

const here = path.dirname(new URL(import.meta.url).pathname);
const pkgRoot = path.dirname(here);
const mod = await import(path.join(pkgRoot, "extensions", "bg-task.ts"));

const registered = {};
const hooks = {};
mod.default({
  registerTool: (t) => (registered[t.name] = t),
  registerCommand: () => {},
  on: (name, fn) => (hooks[name] = fn),
});

const exec = async (name, params) => (await registered[name].execute("e2e", params, undefined, undefined, {})).content[0].text;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const log = (...a) => console.log(...a);
const members = (pgid) => {
  try {
    return execSync(`pgrep -g ${pgid}`).toString().trim().split("\n").filter(Boolean).length;
  } catch {
    return 0;
  }
};
let failures = 0;
const check = (label, ok) => {
  if (!ok) failures++;
  log(`${ok ? "ok  " : "FAIL"} ${label}`);
};

// start from a clean slate (stale foreign metas would pollute assertions)
execSync(`rm -rf ${path.join(os.homedir(), ".pi/agent/bg-tasks")/* trailing slash-less glob */}/* 2>/dev/null || true`);

// --- 1-3: process group kill ---
const r1 = await exec("bg_run", { command: "echo e2e-started; sleep 300 & sleep 300", name: "e2e-group" });
const id = r1.match(/id: ([^,)]+)/)[1];
const pgid = Number(r1.match(/pid: (\d+)/)[1]);
await sleep(900);
check("run: process group has members", members(pgid) > 0);
check("status: shows running", /running/.test(await exec("bg_status", { id })));
check("log: captures stdout", /e2e-started/.test(await exec("bg_log", { id, tail_lines: 5 })));
await exec("bg_kill", { id });
await sleep(6500);
check("kill: zero leftover group members (no zombies)", members(pgid) === 0);
check("status after kill: killed", /killed/.test(await exec("bg_status", { id })));

// --- 4: detach mode ---
const r4 = await exec("bg_run", { command: "echo detach-ok", name: "e2e-detach", detach: true });
const id4 = r4.match(/id: ([^,)]+)/)[1];
await sleep(1200);
const exitFile = path.join(os.homedir(), ".pi/agent/bg-tasks", id4, "exitcode");
check("detach: exitcode file written by wrapper", existsSync(exitFile));
const st4 = await exec("bg_status", { id: id4 });
check("detach: state finalized as done", /done/.test(st4));
check("detach: log captured", /detach-ok/.test(readFileSync(path.join(os.homedir(), ".pi/agent/bg-tasks", id4, "out.log"), "utf8")));

// --- 5: artifact ---
const tmpJson = path.join(os.tmpdir(), `bg-e2e-${Date.now()}.json`);
writeFileSync(tmpJson, JSON.stringify([{ a: 1, b: "x" }, { a: 2 }]));
check("artifact: JSON summary", /JSON array\[2\]/.test(await exec("bg_artifact", { path: tmpJson })));
writeFileSync(tmpJson, "c1,c2\n1,x\n2,y");
check("artifact: CSV summary", /CSV/.test(await exec("bg_artifact", { path: tmpJson })));

// --- 6: interceptor (default auto-bg) ---
const h = hooks["tool_call"];
const ctx = { ui: { notify: () => {} } };
if (typeof h !== "function") {
  check("interceptor registered", false);
} else {
  const blocked = await h({ toolName: "bash", input: { command: "docker logs -f e2e-container" } }, ctx);
  check("interceptor auto-bg: follow command converted to bg task", !!blocked?.block && /id: /.test(blocked.reason));
  const bgId = blocked.reason.match(/id: ([^)]+)\)/)?.[1];
  if (bgId) await exec("bg_kill", { id: bgId.trim() });
  const normal = await h({ toolName: "bash", input: { command: "ls -la" } }, ctx);
  check("interceptor: normal command untouched", normal === undefined);
}

console.log(failures === 0 ? "\nALL OK" : `\n${failures} FAILURE(S)`);
process.exit(failures ? 1 : 0);
