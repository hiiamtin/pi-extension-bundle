#!/usr/bin/env node
// Regression tests for the 2026-09 bg-task bugfix batch:
//   #1 sweep/context marked ALL pending tasks notified while showing only 5
//   #2 push give-up set notifiedAt without delivery (blocked the context hook)
//   #3 positional claim cursor desynced by the capturedPis splice cap
//   #4 detach scan notified the stale meta ("finished: running") and clobbered state
//   #5 taskLine called with 2 args but declared with 1 (type error — tsc, not here)
//   #6 widget linger: finished task renders result line, retry loop stays alive
//   #7 /bg clean [id] deletes finished tasks NOW; running/orphan are kept
//
//   node scripts/bg-regression.mjs   (exit 0 = ALL OK)
//
// Tests #1/#2/#4 drive the REAL extension module with a fake ExtensionAPI
// (same loader approach as bg-e2e.mjs); test #3 replicates the claim
// algorithm verbatim because sessionApis internals are not exported.

import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";

const here = path.dirname(new URL(import.meta.url).pathname);
const pkgRoot = path.dirname(here);
const STATE_DIR = path.join(os.tmpdir(), `pi-bg-regression-${process.pid}`);
rmSync(STATE_DIR, { recursive: true, force: true });
process.env.PI_BG_STATE_DIR = STATE_DIR;
process.env.PI_BG_TICK_MS = "1000"; // fastest allowed tick — #2 needs ~12 retries fast

process.on("exit", () => rmSync(STATE_DIR, { recursive: true, force: true }));

let failures = 0;
function check(label, cond, detail = "") {
  console.log(`${cond ? "PASS" : "FAIL"}  ${label}${cond || !detail ? "" : ` — ${detail}`}`);
  if (!cond) failures++;
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const OURS = path.join(os.tmpdir(), `pi-bg-regression-owner-${process.pid}.jsonl`);
const OURS2 = path.join(os.tmpdir(), `pi-bg-regression-owner2-${process.pid}.jsonl`);

// --- load the real extension -------------------------------------------------
const mod = await import(path.join(pkgRoot, "extensions", "bg-task.ts"));

const sent = []; // every successful sendMessage payload
const registered = {};
const commands = {};
const hooks = {};
const fakePi = {
  registerTool: (t) => (registered[t.name] = t),
  registerCommand: (name, cmd) => (commands[name] = cmd),
  on: (name, fn) => { (hooks[name] ??= []).push(fn); },
  sendMessage: (m, o) => sent.push({ m, o }), // swapped for a thrower mid-test (#2)
};
mod.default(fakePi);

const fireSessionStart = (sf) =>
  hooks.session_start[0]({}, { sessionManager: { getSessionFile: () => sf } });
const metaOf = (id) => JSON.parse(readFileSync(path.join(STATE_DIR, id, "meta.json"), "utf8"));

const writeMetaRaw = (id, patch) => {
  mkdirSync(path.join(STATE_DIR, id), { recursive: true });
  writeFileSync(path.join(STATE_DIR, id, "meta.json"), JSON.stringify({ id, cmd: "true", pid: 99999, pgid: 99999, startedAt: Date.now() - 120_000, ...patch }, null, 1));
};

// bind the extension's notion of "current session" to OURS + claim our capture
fireSessionStart(OURS);

// --- #4 detach scan: finalize + notify with the FRESH meta -------------------
writeMetaRaw("reg04detach", {
  name: "reg04-detach", state: "running", owner: "pid-x",
  ownerSession: OURS, heartbeat: Date.now() - 60_000, bytes: 0, detach: true,
});
writeFileSync(path.join(STATE_DIR, "reg04detach", "exitcode"), "0\n");
registered.bg_status.execute("tc", {}); // bgListText → refreshScan finalizes detached tasks
const m4 = metaOf("reg04detach");
check("#4a detach scan finalizes state to done (not clobbered back to running)", m4.state === "done", `state=${m4.state}`);
const notice4 = sent.find((s) => s.m?.details?.id === "reg04detach");
check("#4b notice reports the real state (not 'finished: running')", !!notice4 && String(notice4.m.content).includes("finished: done"), notice4 ? String(notice4.m.content).split("\n")[0] : "no notice sent");
check("#4c notifiedAt set after successful delivery", m4.notifiedAt != null);

// --- #1 sweep shows 5 but must mark ONLY the shown ones ----------------------
for (let i = 0; i < 7; i++) {
  writeMetaRaw(`reg01task${i}`, {
    name: `reg01-${i}`, state: "done", exitCode: 0, finishedAt: Date.now() - 60_000,
    owner: "pid-x", ownerSession: OURS, heartbeat: Date.now() - 60_000, bytes: 0,
  });
}
const sentBefore = sent.length;
fireSessionStart(OURS); // session_start always sweeps (not gated by pushAllowed)
const sweepMsg = sent.slice(sentBefore).find((s) => String(s.m?.content ?? "").includes("finished since you were away"));
const listed = sweepMsg ? (String(sweepMsg.m.content).match(/reg01-\d/g) ?? []) : [];
check("#1a sweep lists at most 5 tasks", listed.length === 5, `listed=${listed.length}`);
const marked = [...Array(7)].filter((_, i) => metaOf(`reg01task${i}`).notifiedAt != null).length;
check("#1b exactly the 5 shown tasks are marked notified (2 stay pending)", marked === 5, `marked=${marked}`);
check("#1c details.ids match the shown 5", !!sweepMsg && sweepMsg.m.details.ids.length === 5);

// --- #2 push give-up must NOT set notifiedAt; guaranteed channel still works --
// model pi-web properly: EACH session's load is its own factory call/capture,
// so OURS2's session_start can claim an api bound to OURS2
const registered2 = {};
const hooks2 = {};
const fakePi2 = {
  registerTool: (t) => (registered2[t.name] = t),
  registerCommand: () => {},
  on: (name, fn) => { (hooks2[name] ??= []).push(fn); },
  sendMessage: () => { throw new Error("reg02: runtime unbound"); }, // swapped to a recorder after the give-up
};
mod.default(fakePi2);
const fireSessionStart2 = (sf) =>
  hooks2.session_start[0]({}, { sessionManager: { getSessionFile: () => sf } });
fireSessionStart2(OURS2); // claims fakePi2's capture under OURS2 → pushAllowed() false from here on

// NOTE: no keeper task here — after the linger fix the exit entry stays in
// `own`, keeping the widget loop (and the tick retries) alive on its own
await registered.bg_run.execute(
  "tc", { command: "echo reg02-output; exit 3", name: "reg02-notify" },
  undefined, undefined, { sessionManager: { getSessionFile: () => OURS2 } },
);
const reg02Id = readdirSync(STATE_DIR).find((d) => { try { return metaOf(d).name === "reg02-notify"; } catch { return false; } });
let m2 = null;
const deadline = Date.now() + 40_000;
while (Date.now() < deadline) {
  await sleep(1000);
  m2 = reg02Id ? metaOf(reg02Id) : null;
  if (m2 && m2.state !== "running" && (m2.notifyTries ?? 0) >= 12) break;
}
check("#2a retries exhausted (notifyTries >= 12)", !!m2 && (m2.notifyTries ?? 0) >= 12, `tries=${m2?.notifyTries}`);
check("#2b notifiedAt NOT set after give-up (context/sweep still own it)", !!m2 && m2.notifiedAt == null, `notifiedAt=${m2?.notifiedAt}`);
check("#2c task finalized as failed regardless", !!m2 && m2.state === "failed", `state=${m2?.state}`);
// now heal the channel and prove the guaranteed path still delivers the notice
const rec2 = [];
fakePi2.sendMessage = (m, o) => rec2.push({ m, o });
fireSessionStart2(OURS2);
const healed = rec2.find((s) => String(s.m?.content ?? "").includes("reg02-notify"));
check("#2d session_start sweep delivers the abandoned notice afterwards", !!healed && metaOf(reg02Id).notifiedAt != null);

// --- #3 seq-based claim algorithm (verbatim replica) under splice pressure ----
function makeClaimModel(cap) {
  const captured = [];
  let captureSeq = 0;
  let claimedSeq = 0;
  const sessionApis = new Map();
  return {
    factory() {
      captureSeq += 1;
      captured.push({ id: captureSeq, seq: captureSeq });
      if (captured.length > cap) captured.splice(0, captured.length - cap);
    },
    associate(sf) {
      const claimed = captured.filter((c) => c.seq > claimedSeq);
      if (!claimed.length) return;
      sessionApis.set(sf, [...(sessionApis.get(sf) ?? []), ...claimed]);
      claimedSeq = Math.max(claimedSeq, ...claimed.map((c) => c.seq));
    },
    sessionApis,
  };
}
{
  const N = 40;
  const CAP = 16;
  const model = makeClaimModel(CAP);
  const sessions = [];
  for (let i = 1; i <= N; i++) {
    model.factory();
    const sf = `session-${String(i).padStart(2, "0")}`;
    sessions.push(sf);
    model.associate(sf);
  }
  let bad = 0;
  sessions.forEach((sf, i) => {
    const mine = (model.sessionApis.get(sf) ?? []).map((c) => c.id);
    if (mine.length !== 1 || mine[0] !== i + 1) bad++;
  });
  check(`#3 seq claims: ${N} loads past cap=${CAP} — every session owns exactly its own capture`, bad === 0, `${bad} sessions mis-claimed`);
  // re-eval scenario: re-associating an already-claimed session must be a no-op
  const before = model.sessionApis.get(sessions[0]).length;
  model.associate(sessions[0]);
  check("#3 re-eval: re-associating never re-claims old captures", model.sessionApis.get(sessions[0]).length === before);
}

// --- #6 exit keeps the own entry for the widget linger -----------------------
// the /bg handler primes cachedUi; a fast task must then render its result
// line (✅ …) in the widget during the linger window — and the retry loop
// stays alive without any other running task (proven by #2 needing no keeper)
const widgetCalls = [];
await commands.bg.handler("", { ui: { notify: () => {}, setStatus: () => {}, setWidget: (k, lines) => widgetCalls.push({ k, lines }) } });
await registered.bg_run.execute(
  "tc", { command: "echo reg06-widget; true", name: "reg06-widget" },
  undefined, undefined, { sessionManager: { getSessionFile: () => OURS } },
);
await sleep(2500); // a couple of ticks
const widgetHit = widgetCalls.find((c) => (c.lines ?? []).some((l) => l.includes("reg06-widget")));
check("#6a finished task renders its result line in the widget (linger)", !!widgetHit && widgetHit.lines.some((l) => l.trim().startsWith("✅")), JSON.stringify(widgetCalls.map((c) => c.lines)));
check("#6b widget loop still alive after exit (lines non-empty)", widgetCalls.some((c) => (c.lines ?? []).length > 0));

// --- #7 /bg clean deletes finished tasks now, keeps running/orphan -----------
const notes7 = [];
const ui7 = {
  notify: (m) => notes7.push(String(m)),
  confirm: async () => true,
  setWidget: () => {},
  setStatus: () => {},
};
writeMetaRaw("reg07fin", {
  name: "reg07-finished", state: "done", exitCode: 0, finishedAt: Date.now() - 60_000,
  owner: "pid-x", ownerSession: OURS, heartbeat: Date.now() - 60_000, bytes: 0,
});
writeMetaRaw("reg07run", {
  name: "reg07-running", state: "running", owner: "pid-x",
  ownerSession: OURS, heartbeat: Date.now(), bytes: 0,
  pid: process.pid, pgid: process.pid, // alive → refreshScan must NOT re-mark it gone
});
await commands.bg.handler("clean", { ui: ui7 });
check("#7a clean (no args) deletes finished tasks immediately", !existsSync(path.join(STATE_DIR, "reg07fin")));
check("#7b clean keeps running tasks", existsSync(path.join(STATE_DIR, "reg07run")));
await commands.bg.handler("clean reg07-running", { ui: ui7 });
check("#7c clean <id> refuses running tasks", existsSync(path.join(STATE_DIR, "reg07run")) && notes7.some((n) => n.includes("bg_kill it first")));
writeMetaRaw("reg07one", {
  name: "reg07-single", state: "failed", exitCode: 2, finishedAt: Date.now() - 30_000,
  owner: "pid-x", ownerSession: OURS, heartbeat: Date.now() - 30_000, bytes: 0,
});
await commands.bg.handler("clean reg07one", { ui: ui7 });
check("#7d clean <id> deletes a specific finished task", !existsSync(path.join(STATE_DIR, "reg07one")));
await commands.bg.handler("clean nope-xyz", { ui: ui7 });
check("#7e clean <unknown id> reports not found", notes7.some((n) => n.includes("not found")));

// --- summary ------------------------------------------------------------------
console.log(failures === 0 ? "\nALL REGRESSION CHECKS PASSED" : `\n${failures} CHECK(S) FAILED`);
process.exit(failures === 0 ? 0 : 1);
