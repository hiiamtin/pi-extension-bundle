#!/usr/bin/env node
// Deterministic stand-in for a `pi --mode json -p` child.
// Used only by scripts/subagent-e2e.mjs at the subprocess boundary.

import { appendFileSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";

const args = process.argv.slice(2);
const valueAfter = (flag) => {
  const index = args.indexOf(flag);
  return index >= 0 ? args[index + 1] : undefined;
};
const task = args.at(-1) ?? "";
const sessionFile = valueAfter("--session");
const mcpConfig = valueAfter("--mcp-config");

const capture = (event, extra = {}) => {
  if (!process.env.FAKE_SUBAGENT_CAPTURE) return;
  appendFileSync(
    process.env.FAKE_SUBAGENT_CAPTURE,
    `${JSON.stringify({ event, pid: process.pid, at: Date.now(), ...extra })}\n`,
  );
};
capture("start", {
  args,
  cwd: process.cwd(),
  mcpConfig: mcpConfig ? JSON.parse(readFileSync(mcpConfig, "utf8")) : undefined,
});

if (sessionFile) {
  mkdirSync(path.dirname(sessionFile), { recursive: true });
  writeFileSync(
    sessionFile,
    `${JSON.stringify({ type: "session", version: 3, id: "fake-session", timestamp: new Date().toISOString(), cwd: process.cwd() })}\n`,
  );
}

const delayMs = Math.max(0, Number(process.env.FAKE_SUBAGENT_DELAY_MS) || 0);
if (delayMs > 0) await new Promise((resolve) => setTimeout(resolve, delayMs));

const resultText = process.env.FAKE_SUBAGENT_OUTPUT || `result for ${task}`;
const assistant = {
  role: "assistant",
  content: [
    { type: "toolCall", id: "fake-tool-1", name: "read", arguments: { path: "README.md" } },
    { type: "text", text: resultText },
  ],
  provider: "fake",
  model: "fake-model",
  usage: {
    input: 101,
    output: 17,
    cacheRead: 11,
    cacheWrite: 3,
    reasoning: 5,
    totalTokens: 137,
    cost: { input: 0.01, output: 0.02, cacheRead: 0.001, cacheWrite: 0.002, total: 0.033 },
  },
  stopReason: "stop",
  timestamp: Date.now(),
};

for (const event of [
  { type: "session", version: 3, id: "fake-session", timestamp: new Date().toISOString(), cwd: process.cwd() },
  { type: "agent_start" },
  { type: "tool_execution_start", toolCallId: "fake-tool-1", toolName: "read", args: { path: "README.md" } },
  { type: "message_end", message: assistant },
  { type: "agent_end", messages: [assistant] },
  { type: "agent_settled" },
]) {
  process.stdout.write(`${JSON.stringify(event)}\n`);
}
capture("end");
