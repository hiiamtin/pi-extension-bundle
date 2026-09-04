#!/usr/bin/env node
// End-to-end behavioral tests for the subagent extension.
// All state and child processes are isolated from real pi state.

import assert from "node:assert/strict";
import { execSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";

const here = path.dirname(new URL(import.meta.url).pathname);
const pkgRoot = path.dirname(here);
const root = path.join(os.tmpdir(), `pi-subagent-e2e-${process.pid}`);
const agentDir = path.join(root, "agent-dir");
const stateDir = path.join(root, "state");
const captureFile = path.join(root, "spawn.jsonl");
const fakePi = path.join(here, "fixtures", "fake-subagent-pi.mjs");

rmSync(root, { recursive: true, force: true });
mkdirSync(path.join(agentDir, "agents"), { recursive: true });
mkdirSync(path.join(agentDir, "skills", "review-marker"), { recursive: true });
mkdirSync(path.join(agentDir, "npm", "node_modules", "pi-mcp-adapter"), { recursive: true });
mkdirSync(stateDir, { recursive: true });
writeFileSync(
  path.join(agentDir, "agents", "scout.md"),
  `---\nname: scout\ndescription: Read-only codebase recon. # delegation summary\nmodel: fake/fake-model\ntools:\n  - read\n  - grep\nextensions:\n  - code-search\nskills: []\ntimeout: 10\n---\n\nReturn compressed findings.\n`,
);
writeFileSync(
  path.join(agentDir, "agents", "slow.md"),
  `---\nname: slow\ndescription: Timeout test agent.\ntools: read\ntimeout: 0.002\n---\n\nTest timeouts.\n`,
);
writeFileSync(
  path.join(agentDir, "agents", "broken.md"),
  `---\nname: broken\ndescription: Broken resource test agent.\nextensions: [missing-extension]\n---\n\nFail cleanly.\n`,
);
writeFileSync(
  path.join(agentDir, "agents", "researcher.md"),
  `---\nname: researcher\ndescription: Research with one skill and one MCP server.\ntools: read\nskills: [review-marker]\nmcp: [context7]\n---\n\nResearch carefully.\n`,
);
writeFileSync(path.join(agentDir, "skills", "review-marker", "SKILL.md"), `---\nname: review-marker\ndescription: Test review skill.\n---\n\nReview.\n`);
writeFileSync(path.join(agentDir, "npm", "node_modules", "pi-mcp-adapter", "index.ts"), "export default function () {}\n");
writeFileSync(path.join(agentDir, "mcp.json"), JSON.stringify({
  settings: { mcpFooterStatus: "off" },
  mcpServers: {
    context7: { url: "https://context7.invalid/mcp" },
    forbidden: { url: "https://forbidden.invalid/mcp" },
  },
}));

process.env.PI_CODING_AGENT_DIR = agentDir;
process.env.PI_SUBAGENT_STATE_DIR = stateDir;
process.env.PI_SUBAGENT_PI_SCRIPT = fakePi;
process.env.PI_SUBAGENT_MAX_CONCURRENT = "2";
process.env.FAKE_SUBAGENT_CAPTURE = captureFile;

// Bare node does not provide pi's package resolver. Link pi's bundled peer
// packages into this gitignored node_modules exactly as the production loader does.
const globalRoot = execSync("npm root -g", { encoding: "utf8" }).trim();
const piRoot = path.join(globalRoot, "@earendil-works", "pi-coding-agent");
assert(existsSync(path.join(piRoot, "package.json")), "installed pi package must be available for peer links");
const peerBase = path.join(pkgRoot, "node_modules", "@earendil-works");
mkdirSync(peerBase, { recursive: true });
for (const name of ["pi-coding-agent", "pi-tui", "pi-ai"]) {
  const source = name === "pi-coding-agent" ? piRoot : path.join(piRoot, "node_modules", "@earendil-works", name);
  const target = path.join(peerBase, name);
  if (!existsSync(target)) symlinkSync(source, target);
}
const typeboxTarget = path.join(pkgRoot, "node_modules", "typebox");
if (!existsSync(typeboxTarget)) symlinkSync(path.join(piRoot, "node_modules", "typebox"), typeboxTarget);

const registered = {};
const commands = {};
const hooks = {};
const mod = await import(path.join(pkgRoot, "extensions", "subagent.ts"));
mod.default({
  cwd: pkgRoot,
  registerTool: (tool) => (registered[tool.name] = tool),
  registerCommand: (name, command) => (commands[name] = command),
  on: (name, handler) => { (hooks[name] ??= []).push(handler); },
});

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const waitFor = async (predicate, timeoutMs = 3000) => {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const value = predicate();
    if (value) return value;
    await sleep(25);
  }
  throw new Error("timed out waiting for test condition");
};

const tool = registered.subagent;
assert(tool, "subagent tool must be registered");
assert(commands.subagents, "/subagents command must be registered");

const notices = [];
const ctx = {
  cwd: pkgRoot,
  model: { provider: "parent", id: "parent-model" },
  thinkingLevel: "high",
  hasUI: false,
  isProjectTrusted: () => true,
  sessionManager: { getSessionFile: () => path.join(root, "parent-session.jsonl") },
  ui: { notify: (message, level) => notices.push({ message, level }) },
};

const updates = [];
const result = await tool.execute(
  "e2e-call",
  { agent: "scout", task: "find auth" },
  new AbortController().signal,
  (update) => updates.push(update),
  ctx,
);
const text = result.content?.[0]?.text ?? "";
assert.match(text, /result for Task: find auth/);
assert.equal(result.isError, undefined);
assert(result.details?.run?.id, "result must expose a run id");
assert.equal(result.details.run.agent, "scout");
assert.equal(result.details.run.state, "done");
assert.equal(result.details.run.usage.input, 101);
assert.equal(result.details.run.usage.cost, 0.033);
assert.equal(result.usage.input, 101);
assert.equal(result.usage.totalTokens, 137);
assert.equal(result.usage.cost.input, 0.01);
assert.equal(result.usage.cost.output, 0.02);
assert.equal(result.usage.cost.cacheRead, 0.001);
assert.equal(result.usage.cost.cacheWrite, 0.002);
assert.equal(result.usage.cost.total, 0.033);
assert(updates.length > 0, "foreground run must stream at least one update");

const runDir = path.join(stateDir, result.details.run.id);
assert(existsSync(path.join(runDir, "meta.json")), "run metadata must persist");
assert(existsSync(path.join(runDir, "session.jsonl")), "child session must persist");
assert(existsSync(path.join(runDir, "transcript.jsonl")), "raw event stream must persist");
assert.equal(readFileSync(path.join(runDir, "result.md"), "utf8"), text);

const spawn = readFileSync(captureFile, "utf8").trim().split("\n").map(JSON.parse).find((event) => event.event === "start");
assert.deepEqual(spawn.args.slice(0, 4), ["--mode", "json", "-p", "--session"]);
assert(spawn.args.includes("--no-extensions"));
assert(spawn.args.includes("--no-skills"));
assert(spawn.args.includes("--no-context-files"));
assert(spawn.args.includes("--no-prompt-templates"));
assert(spawn.args.includes("--no-themes"));
assert(spawn.args.includes("--tools"));
assert(spawn.args.includes("read,grep"));
assert.equal(spawn.args[spawn.args.indexOf("--model") + 1], "fake/fake-model");
assert(spawn.args.includes("-e"));
assert(spawn.args.some((arg) => arg.endsWith("/extensions/code-search.ts")));
assert.equal(spawn.args.at(-1), "Task: find auth");

const otherCwd = path.join(root, "other-cwd");
mkdirSync(otherCwd, { recursive: true });
const continued = await tool.execute(
  "e2e-continue",
  { continue: result.details.run.id, task: "address the review" },
  new AbortController().signal,
  undefined,
  { ...ctx, cwd: otherCwd },
);
assert.match(continued.content?.[0]?.text ?? "", /result for Task: address the review/);
assert.equal(continued.details?.run?.id, result.details.run.id, "continue must keep the run id");
assert.equal(continued.details.run.state, "done");
assert.equal(continued.details.run.usage.input, 202, "run metadata aggregates usage across continuations");
const spawns = readFileSync(captureFile, "utf8").trim().split("\n").map(JSON.parse).filter((event) => event.event === "start");
assert.equal(spawns.length, 2);
assert.equal(spawns[1].args[spawns[1].args.indexOf("--session") + 1], path.join(runDir, "session.jsonl"));
assert.equal(spawns[1].args.at(-1), "Task: address the review");
assert.equal(spawns[1].cwd, pkgRoot, "cross-session continue must keep the original run cwd");

writeFileSync(captureFile, "");
const overridden = await tool.execute("model-override", { agent: "scout", task: "override", model: "caller/stronger" }, undefined, undefined, ctx);
assert.equal(overridden.details?.run?.state, "done");
const overrideSpawn = readFileSync(captureFile, "utf8").trim().split("\n").map(JSON.parse).find((event) => event.event === "start");
assert.equal(overrideSpawn.args[overrideSpawn.args.indexOf("--model") + 1], "caller/stronger");

writeFileSync(captureFile, "");
process.env.FAKE_SUBAGENT_DELAY_MS = "350";
const parallel = await Promise.all([
  tool.execute("parallel-1", { agent: "scout", task: "one" }, undefined, undefined, ctx),
  tool.execute("parallel-2", { agent: "scout", task: "two" }, undefined, undefined, ctx),
  tool.execute("parallel-3", { agent: "scout", task: "three" }, undefined, undefined, ctx),
]);
assert(parallel.every((entry) => entry.details?.run?.state === "done"));
const lifecycle = readFileSync(captureFile, "utf8").trim().split("\n").map(JSON.parse);
let active = 0;
let maxActive = 0;
for (const event of lifecycle.sort((a, b) => a.at - b.at || (a.event === "start" ? -1 : 1))) {
  active += event.event === "start" ? 1 : -1;
  maxActive = Math.max(maxActive, active);
}
assert.equal(maxActive, 2, "native sibling calls must respect PI_SUBAGENT_MAX_CONCURRENT");
delete process.env.FAKE_SUBAGENT_DELAY_MS;

writeFileSync(captureFile, "");
process.env.FAKE_SUBAGENT_DELAY_MS = "800";
const blockers = [
  tool.execute("block-1", { agent: "scout", task: "block one" }, undefined, undefined, ctx),
  tool.execute("block-2", { agent: "scout", task: "block two" }, undefined, undefined, ctx),
];
await waitFor(() => readFileSync(captureFile, "utf8").split("\n").filter((line) => line.includes('"event":"start"')).length === 2);
const queuedPromise = tool.execute("queued", { agent: "scout", task: "cancel queued" }, undefined, undefined, ctx);
const queuedMeta = await waitFor(() => readdirSync(stateDir)
  .map((id) => JSON.parse(readFileSync(path.join(stateDir, id, "meta.json"), "utf8")))
  .find((meta) => meta.task === "cancel queued" && meta.state === "queued"));
await commands.subagents.handler(`kill ${queuedMeta.id}`, ctx);
const queuedResult = await queuedPromise;
await Promise.all(blockers);
delete process.env.FAKE_SUBAGENT_DELAY_MS;
assert.equal(queuedResult.details?.run?.state, "killed");
const queuedStarts = readFileSync(captureFile, "utf8").split("\n").filter(Boolean).map(JSON.parse)
  .filter((event) => event.event === "start" && event.args.at(-1) === "Task: cancel queued");
assert.equal(queuedStarts.length, 0, "cancelled queued run must never spawn a child");

process.env.FAKE_SUBAGENT_DELAY_MS = "3000";
const timedOut = await tool.execute("timeout", { agent: "slow", task: "long work" }, undefined, undefined, ctx);
assert.equal(timedOut.details?.run?.state, "timeout");
assert.notEqual(timedOut.details.run.exitCode, 0);
const timedId = timedOut.details.run.id;
delete process.env.FAKE_SUBAGENT_DELAY_MS;
const afterTimeout = await tool.execute("resume-timeout", { continue: timedId, task: "finish it" }, undefined, undefined, ctx);
assert.equal(afterTimeout.details?.run?.id, timedId);
assert.equal(afterTimeout.details.run.state, "done");
assert.match(afterTimeout.content?.[0]?.text ?? "", /result for Task: finish it|result for Recovered transcript/);
const timeoutSpawns = readFileSync(captureFile, "utf8").trim().split("\n").map(JSON.parse).filter((event) => event.event === "start");
assert.match(timeoutSpawns.at(-1).args.at(-1), /finish it/, "timeout continue must carry the follow-up task");

notices.length = 0;
await commands.subagents.handler(`cont ${result.details.run.id} fix from command`, ctx);
assert(notices.some((notice) => /result for Task: fix from command/.test(notice.message)), "/subagents cont must surface the child result");
assert.equal(JSON.parse(readFileSync(path.join(runDir, "meta.json"), "utf8")).state, "done");
const contCompletions = commands.subagents.getArgumentCompletions(`cont ${result.details.run.id}`);
assert(contCompletions?.some((item) => item.value === `cont ${result.details.run.id}`));
assert(contCompletions.length <= 8);

rmSync(path.join(runDir, "session.jsonl"), { force: true });
writeFileSync(captureFile, "");
const recovered = await tool.execute("recover", { continue: result.details.run.id, task: "recover without session" }, undefined, undefined, ctx);
assert.equal(recovered.details?.run?.state, "done");
const recoverySpawn = readFileSync(captureFile, "utf8").trim().split("\n").map(JSON.parse).find((event) => event.event === "start");
assert.match(recoverySpawn.args.at(-1), /Recovered transcript from the interrupted run/);
assert.match(recoverySpawn.args.at(-1), /result for Task: find auth/);
assert.match(recoverySpawn.args.at(-1), /Follow-up task:\nrecover without session/);

process.env.FAKE_SUBAGENT_DELAY_MS = "3000";
const killPromise = tool.execute("kill-run", { agent: "scout", task: "kill me" }, undefined, undefined, ctx);
const killMeta = await waitFor(() => {
  const dirs = existsSync(stateDir) ? readdirSync(stateDir) : [];
  return dirs
    .map((id) => JSON.parse(readFileSync(path.join(stateDir, id, "meta.json"), "utf8")))
    .find((meta) => meta.task === "kill me" && meta.state === "running");
});
const killCompletions = commands.subagents.getArgumentCompletions("kill ");
assert(killCompletions?.some((item) => item.value === `kill ${killMeta.id}`));
assert(killCompletions.length <= 8);
notices.length = 0;
await commands.subagents.handler(`kill ${killMeta.id}`, ctx);
const killed = await killPromise;
delete process.env.FAKE_SUBAGENT_DELAY_MS;
assert.equal(killed.details?.run?.state, "killed");
assert.equal(JSON.parse(readFileSync(path.join(stateDir, killMeta.id, "meta.json"), "utf8")).state, "killed");
assert(notices.some((notice) => /SIGTERM/.test(notice.message)));
await sleep(100);
assert.throws(() => process.kill(killMeta.pid, 0), "killed child must not survive");

writeFileSync(captureFile, "");
const broken = await tool.execute("broken", { agent: "broken", task: "bad config" }, undefined, undefined, ctx);
assert.equal(broken.details?.run?.state, "failed");
assert.match(broken.content?.[0]?.text ?? "", /missing-extension/);
const researched = await tool.execute("research", { agent: "researcher", task: "look up docs" }, undefined, undefined, ctx);
assert.equal(researched.details?.run?.state, "done");
const researchSpawn = readFileSync(captureFile, "utf8").trim().split("\n").map(JSON.parse).find((event) => event.event === "start");
assert(researchSpawn.args.includes("--skill"));
assert(researchSpawn.args.some((arg) => arg.endsWith("/skills/review-marker/SKILL.md")));
assert.equal(researchSpawn.args[researchSpawn.args.indexOf("--tools") + 1], "read,mcp,mcpScript");
assert(researchSpawn.args.includes("--mcp-config"));
assert(researchSpawn.args.some((arg) => arg.endsWith("/npm/node_modules/pi-mcp-adapter/index.ts")));
assert.deepEqual(Object.keys(researchSpawn.mcpConfig.mcpServers), ["context7"]);
assert(!existsSync(path.join(stateDir, researched.details.run.id, ".mcp-filtered.json")), "filtered MCP config must be removed after child exit");

const projectRoot = path.join(root, "project");
mkdirSync(path.join(projectRoot, ".pi", "agents"), { recursive: true });
writeFileSync(path.join(projectRoot, ".pi", "agents", "scout.md"), `---\nname: scout\ndescription: Project scout.\ntools: [read]\n---\n\nPROJECT OVERRIDE PROMPT\n`);
writeFileSync(captureFile, "");
await tool.execute("untrusted-project", { agent: "scout", task: "untrusted" }, undefined, undefined, { ...ctx, cwd: projectRoot, isProjectTrusted: () => false });
await tool.execute("trusted-project", { agent: "scout", task: "trusted" }, undefined, undefined, { ...ctx, cwd: projectRoot, isProjectTrusted: () => true });
await tool.execute("foreign-project", { agent: "scout", task: "foreign", cwd: projectRoot }, undefined, undefined, { ...ctx, isProjectTrusted: () => true });
const trustSpawns = readFileSync(captureFile, "utf8").trim().split("\n").map(JSON.parse).filter((event) => event.event === "start");
const appendPrompt = (event) => event.args[event.args.indexOf("--append-system-prompt") + 1];
assert.match(appendPrompt(trustSpawns[0]), /Return compressed findings/);
assert.doesNotMatch(appendPrompt(trustSpawns[0]), /PROJECT OVERRIDE/);
assert.equal(appendPrompt(trustSpawns[1]), "PROJECT OVERRIDE PROMPT");
assert.match(appendPrompt(trustSpawns[2]), /Return compressed findings/);
assert.doesNotMatch(appendPrompt(trustSpawns[2]), /PROJECT OVERRIDE/, "cwd override must not borrow trust from the caller's project");

process.env.FAKE_SUBAGENT_OUTPUT = `${"H".repeat(1200)}\nMIDDLE\n${"T".repeat(1200)}`;
const truncated = await tool.execute("truncate", { agent: "scout", task: "large output" }, undefined, undefined, ctx);
delete process.env.FAKE_SUBAGENT_OUTPUT;
assert.equal(truncated.details?.truncated, true);
assert.match(truncated.content?.[0]?.text ?? "", /output truncated/);
assert((truncated.content?.[0]?.text ?? "").includes("HHHH"));
assert((truncated.content?.[0]?.text ?? "").includes("TTTT"));
assert.equal(readFileSync(truncated.details.fullOutputPath, "utf8").length, 2408);

console.log("ALL SUBAGENT E2E TESTS PASSED");
rmSync(root, { recursive: true, force: true });
