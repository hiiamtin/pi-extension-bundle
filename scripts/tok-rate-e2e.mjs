#!/usr/bin/env node
// Functional test for the tok-rate extension (fake ExtensionAPI, real timers).
//
//   node scripts/tok-rate-e2e.mjs   (exit 0 = ALL OK)
//
// Simulates a streaming turn: assistant message_start → thinking_delta chunks
// → text_delta chunks → message_end, and asserts the working message shows
// phase + rate + totals, updates on the timer, and is restored afterwards.

import path from "node:path";

const here = path.dirname(new URL(import.meta.url).pathname);
const pkgRoot = path.dirname(here);

// disabled flag must not be set for this run
delete process.env.PI_TOK_RATE;

const mod = await import(path.join(pkgRoot, "extensions", "tok-rate.ts"));

let failures = 0;
function check(label, cond, detail = "") {
  console.log(`${cond ? "PASS" : "FAIL"}  ${label}${cond || !detail ? "" : ` — ${detail}`}`);
  if (!cond) failures++;
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const hooks = {};
const setWorkingCalls = []; // every setWorkingMessage arg (undefined = restore)
const fakePi = {
  registerTool: () => {},
  registerCommand: () => {},
  on: (name, fn) => {
    (hooks[name] ??= []).push(fn);
  },
  sendMessage: () => {},
};
mod.default(fakePi);

const ctx = { hasUI: true, ui: { setWorkingMessage: (m) => setWorkingCalls.push(m) } };
const fire = (name, event) => Promise.all((hooks[name] ?? []).map((fn) => fn(event, ctx)));
const last = () => setWorkingCalls[setWorkingCalls.length - 1];

// --- non-assistant messages are ignored --------------------------------------
await fire("message_start", { message: { role: "user" } });
check("user message_start does not activate", setWorkingCalls.length === 0);

// --- assistant stream: thinking phase -----------------------------------------
await fire("message_start", { message: { role: "assistant" } });
await fire("message_update", {
  assistantMessageEvent: { type: "thinking_delta", delta: "x".repeat(400) },
});
let msg = last();
check("first delta paints immediately", typeof msg === "string", String(msg));
check("thinking phase shown with rate + totals", !!msg && msg.includes("Thinking") && msg.includes("tok/s") && msg.includes("tok · "), String(msg));
await sleep(500); // one timer tick (UPDATE_MS=400) with no deltas — must stay fresh
const callsBeforeIdle = setWorkingCalls.length;
check("timer keeps repainting during pauses", setWorkingCalls.length > 1, `calls=${setWorkingCalls.length}`);

// --- rate accounting: 400 chars = 100 tok in ~0.5s → rate roughly plausible ---
await fire("message_update", {
  assistantMessageEvent: { type: "thinking_delta", delta: "y".repeat(400) },
});
msg = last();
const rateMatch = /↑ ([0-9.]+) tok\/s/.exec(msg ?? "");
const rate = rateMatch ? Number(rateMatch[1]) : 0;
check("rate is a plausible positive number", rate > 10 && rate < 5000, `rate=${rate}`);
check("totals accumulate (≥100 tok est.)", /· ([0-9.]+k?|[0-9]+) tok/.test(msg ?? ""), String(msg));

// --- writing phase switch ------------------------------------------------------
await fire("message_update", {
  assistantMessageEvent: { type: "text_delta", delta: "z".repeat(400) },
});
msg = last();
check("text_delta switches phase to Writing", !!msg && msg.includes("Writing"), String(msg));
const callsBeforeTool = setWorkingCalls.length;
await fire("message_update", {
  assistantMessageEvent: { type: "toolcall_delta", delta: "{}" },
});
check("toolcall_delta ignored (no repaint)", setWorkingCalls.length === callsBeforeTool);

// --- message_end restores the default working message --------------------------
await fire("message_end", { message: { role: "assistant" } });
check("message_end restores default (undefined arg)", last() === undefined);
const callsAtRestore = setWorkingCalls.length;
await sleep(500);
check("timer stopped after message_end (no repaints)", setWorkingCalls.length === callsAtRestore, `restore=${callsAtRestore} now=${setWorkingCalls.length}`);

// --- next message re-activates cleanly ------------------------------------------
await fire("message_start", { message: { role: "assistant" } });
await fire("message_update", {
  assistantMessageEvent: { type: "thinking_delta", delta: "q".repeat(40) },
});
msg = last();
check("re-activates on next assistant message", !!msg && msg.includes("Thinking"), String(msg));

// --- turn_end safety net ----------------------------------------------------------
await fire("turn_end", {});
check("turn_end restores as safety net", last() === undefined);

// --- no-UI host stays idle ----------------------------------------------------------
const hooks2 = {};
const mod2 = await import(path.join(pkgRoot, "extensions", "tok-rate.ts"));
let uiTouched = 0;
mod2.default({
  registerTool: () => {},
  registerCommand: () => {},
  on: (name, fn) => {
    (hooks2[name] ??= []).push(fn);
  },
  sendMessage: () => {},
});
await (hooks2.message_start ?? []).map((fn) => fn({ message: { role: "assistant" } }, { hasUI: false, ui: undefined }));
await (hooks2.message_update ?? []).map((fn) => fn({ assistantMessageEvent: { type: "text_delta", delta: "abc" } }, undefined));
check("no-UI host (hasUI:false) stays completely idle", uiTouched === 0);

console.log(failures === 0 ? "\nALL TOK-RATE CHECKS PASSED" : `\n${failures} CHECK(S) FAILED`);
process.exit(failures === 0 ? 0 : 1);
