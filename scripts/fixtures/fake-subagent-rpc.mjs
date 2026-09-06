#!/usr/bin/env node
// Deterministic stand-in for a `pi --mode rpc` child.
// Used only by scripts/subagent-e2e.mjs at the subprocess boundary.
//
// Speaks enough of the rpc protocol for behavior tests:
//   prompt  → response + turn_start/tool_execution_start/message_end/turn_end
//   steer   → response; when steerable, a second steered turn
//   abort   → response; when abortable, exits 0
// Env knobs: FAKE_SUBAGENT_DELAY_MS, FAKE_SUBAGENT_OUTPUT,
// FAKE_RPC_STEERABLE=1, FAKE_RPC_STEER_OUTPUT, FAKE_RPC_WRAPUP_HONORS=1,
// FAKE_RPC_HANG=1 (never turn_end; ignores wrap-up), FAKE_SUBAGENT_CAPTURE.

import { appendFileSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";

const args = process.argv.slice(2);
const valueAfter = (flag) => {
  const index = args.indexOf(flag);
  return index >= 0 ? args[index + 1] : undefined;
};
const sessionFile = valueAfter("--session");
const mcpConfig = valueAfter("--mcp-config");
const rpcMode = args.includes("--mode") && args[args.indexOf("--mode") + 1] === "rpc";

const capture = (event, extra = {}) => {
  if (!process.env.FAKE_SUBAGENT_CAPTURE) return;
  appendFileSync(process.env.FAKE_SUBAGENT_CAPTURE, `${JSON.stringify({ event, pid: process.pid, at: Date.now(), ...extra })}\n`);
};
capture("start", { args, cwd: process.cwd(), rpcMode, mcpConfig: mcpConfig ? JSON.parse(readFileSync(mcpConfig, "utf8")) : undefined });

if (sessionFile) {
  mkdirSync(path.dirname(sessionFile), { recursive: true });
  writeFileSync(sessionFile, `${JSON.stringify({ type: "session", version: 3, id: "fake-rpc", timestamp: new Date().toISOString(), cwd: process.cwd() })}\n`);
}

const out = (obj) => process.stdout.write(`${JSON.stringify(obj)}\n`);
const respond = (cmd, success, data) => out({ id: cmd.id, type: "response", command: cmd.type, success, ...(data ? { data } : {}) });

const delayMs = Math.max(0, Number(process.env.FAKE_SUBAGENT_DELAY_MS) || 0);
let lastPrompt = "";
const finalText = () => process.env.FAKE_SUBAGENT_OUTPUT || `result for ${lastPrompt}`;
const usage = {
  input: 101, output: 17, cacheRead: 11, cacheWrite: 3, reasoning: 5, totalTokens: 137,
  cost: { input: 0.01, output: 0.02, cacheRead: 0.001, cacheWrite: 0.002, total: 0.033 },
};

const assistantMessage = (text, stopReason = "stop") => ({
  role: "assistant",
  content: [
    { type: "toolCall", id: "fake-tool-1", name: "read", arguments: { path: "README.md" } },
    { type: "text", text },
  ],
  provider: "fake", model: "fake-model", usage, stopReason, timestamp: Date.now(),
});

const emitTurn = (text) => {
  out({ type: "turn_start" });
  out({ type: "tool_execution_start", toolCallId: "fake-tool-1", toolName: "read", args: { path: "README.md" } });
  // stream noise: deltas + message_start — the parent must NOT persist these
  for (let i = 0; i < 120; i++) out({ type: "message_update", delta: `chunk-${i}-${"x".repeat(60)}` });
  out({ type: "message_start", message: { role: "assistant", content: [] } });
  out({ type: "tool_execution_end", toolCallId: "fake-tool-1", status: "success" });
  out({ type: "message_end", message: assistantMessage(text) });
  out({ type: "turn_end" });
};

let buffer = "";
let finished = false; // a turn has fully completed
let turnTimer = null;
const runTurn = (text) => {
  if (turnTimer) clearTimeout(turnTimer);
  turnTimer = delayMs > 0
    ? setTimeout(() => { if (!exiting) { turnTimer = null; emitTurn(text); } }, delayMs)
    : (emitTurn(text), null);
};

let exiting = false;
process.stdin.setEncoding("utf8");
process.stdin.on("data", (chunk) => {
  buffer += chunk;
  for (;;) {
    const index = buffer.indexOf("\n");
    if (index < 0) break;
    const line = buffer.slice(0, index).replace(/\r$/, "");
    buffer = buffer.slice(index + 1);
    if (!line.trim()) continue;
    let cmd;
    try { cmd = JSON.parse(line); } catch { continue; }
    if (cmd.type === "prompt") {
      lastPrompt = String(cmd.message ?? "");
      respond(cmd, true);
      if (process.env.FAKE_RPC_HANG === "1") continue; // never emits turn_end
      runTurn(finalText());
    } else if (cmd.type === "steer") {
      respond(cmd, true);
      if (process.env.FAKE_RPC_STEERABLE !== "1") continue; // wrap-up steers are silent here
      if (turnTimer) { clearTimeout(turnTimer); turnTimer = null; } // pivot abandons the in-flight turn
      const text = process.env.FAKE_RPC_STEER_OUTPUT || "STEER-OK";
      turnTimer = setTimeout(() => { if (!exiting) { finished = true; emitTurn(text); } }, 300);
    } else if (cmd.type === "abort") {
      respond(cmd, true);
      if (process.env.FAKE_RPC_WRAPUP_HONORS === "1" && !finished) {
        if (turnTimer) clearTimeout(turnTimer);
        finished = true;
        emitTurn("wrapped up on request");
      } else {
        exiting = true;
        process.exit(0);
      }
    } else if (cmd.type === "get_messages") {
      respond(cmd, true, { messages: [
        { role: "user", content: [{ type: "text", text: "fake user message" }] },
        { role: "assistant", content: [{ type: "text", text: "fake assistant message" }] },
      ] });
    } else {
      respond(cmd, true);
    }
  }
});
process.stdin.on("end", () => {
  if (!exiting) {
    out({ type: "agent_end", messages: [assistantMessage(finalText())], note: "large payload line" });
    out({ type: "agent_settled" });
  }
  exiting = true;
  capture("end");
  process.exit(0);
});
process.on("SIGTERM", () => { exiting = true; capture("sigterm"); process.exit(1); });
