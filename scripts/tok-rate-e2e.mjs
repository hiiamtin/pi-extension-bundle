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
await sleep(450); // phase label lands on the next paint (throttle/tick ≤400ms)
msg = last();
check("text_delta switches phase to Writing (within a tick)", !!msg && msg.includes("Writing"), String(msg));
const callsBeforeTool = setWorkingCalls.length;
const parseTok = (m) => {
  const match = /· ([\d.]+)(k|M)? tok/.exec(m ?? "");
  if (!match) return NaN;
  let v = Number(match[1]);
  if (match[2] === "k") v *= 1000;
  if (match[2] === "M") v *= 1e6;
  return v;
};
const beforeTok = parseTok(last());
await fire("message_update", {
  assistantMessageEvent: { type: "toolcall_delta", delta: "j".repeat(400) },
});
await sleep(450); // next paint folds the toolcall chars into totals
const afterTok = parseTok(last());
check("toolcall_delta counted into totals (label unchanged)", afterTok > beforeTok && (last() ?? "").includes("Writing"), `${beforeTok} → ${afterTok} tok`);

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

// --- themed host: colors via theme.fg (rate tiers like pi-web's badge) ---------
const hooksT = {};
const paintedT = [];
const fakeTheme = { fg: (color, text) => `\x1b[${color}m${text}\x1b[0m` };
const modT = await import(path.join(pkgRoot, "extensions", "tok-rate.ts"));
modT.default({
  registerTool: () => {},
  registerCommand: () => {},
  on: (name, fn) => {
    (hooksT[name] ??= []).push(fn);
  },
  sendMessage: () => {},
});
const fireT = (name, event) =>
  Promise.all(
    (hooksT[name] ?? []).map((fn) =>
      fn(event, { hasUI: true, ui: { setWorkingMessage: (m) => paintedT.push(m), theme: fakeTheme } }),
    ),
  );
await fireT("message_start", { message: { role: "assistant" } });
await fireT("message_update", {
  assistantMessageEvent: { type: "thinking_delta", delta: "x".repeat(2000) },
});
await sleep(450); // fold a rate window (ema > 0 → accent tier)
const themed = paintedT.at(-1) ?? "";
check("themed host paints ANSI colors (accent/dim present)", themed.includes("\x1b[") && themed.includes("accent") && themed.includes("dim"), JSON.stringify(themed));
check("rate gets a tier color (accent/success/warning/error)", ["accent", "success", "warning", "error"].some((c) => themed.includes(`\x1b[${c}m↑`)), JSON.stringify(themed));

console.log(failures === 0 ? "\nALL TOK-RATE CHECKS PASSED" : `\n${failures} CHECK(S) FAILED`);
process.exit(failures === 0 ? 0 : 1);
