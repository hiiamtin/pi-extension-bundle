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
const fakePi = path.join(here, "fixtures", "fake-subagent-rpc.mjs");

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
process.env.PI_SUBAGENT_DEBUG_LOG = path.join(root, "debug.log");
process.env.PI_SUBAGENT_WRAPUP_SEC = "1"; // short grace so timeout tests stay fast

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
const shortcuts = [];
const hooks = {};
const mod = await import(path.join(pkgRoot, "extensions", "subagent.ts"));
mod.default({
  cwd: pkgRoot,
  registerTool: (tool) => (registered[tool.name] = tool),
  registerCommand: (name, command) => (commands[name] = command),
  on: (name, handler) => { (hooks[name] ??= []).push(handler); },
  registerShortcut: (shortcut, opts) => { (shortcuts ??= []).push({ shortcut, opts }); },
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
assert.match(tool.description, /independent.*same assistant response/i, "tool schema must teach real sibling-call parallelism");
assert.match(tool.description, /depends on an earlier result/i, "tool schema must distinguish sequential dependencies");
assert.equal(tool.promptSnippet, undefined, "parallel guidance belongs in the tool description only");
assert.equal(tool.promptGuidelines, undefined, "parallel guidance must not duplicate system-prompt text");
assert(commands.subagents, "/subagents command must be registered");
const viewerShortcut = shortcuts.find((entry) => entry.shortcut === "ctrl+alt+s");
assert(viewerShortcut, "ctrl+alt+s must be registered for the chat viewer");

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
assert.match(text, new RegExp(`\\[subagent run: ${result.details.run.id} · scout · done\\]`));
assert.match(text, new RegExp(`subagent\\(\\{ continue: "${result.details.run.id}"`));
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
assert.equal(readFileSync(path.join(runDir, "result.md"), "utf8"), "result for Task: find auth", "result.md must remain the raw child output");

const spawnedEvent = readFileSync(captureFile, "utf8").trim().split("\n").map(JSON.parse).find((event) => event.event === "start");
assert(spawnedEvent.rpcMode, "child must be spawned in rpc mode");
const spawn = spawnedEvent;
assert.deepEqual(spawn.args.slice(0, 3), ["--mode", "rpc", "--session"]);
assert(!spawn.args.includes("-p"), "rpc children must not use -p");
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
assert.match(continued.content?.[0]?.text ?? "", new RegExp(`\\[subagent run: ${result.details.run.id} · scout · done\\]`));
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
assert.match(timedOut.content?.[0]?.text ?? '', /timeout/, "footer must carry the timeout state");
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
assert((truncated.content?.[0]?.text ?? "").length <= 1000, "model-visible footer must stay inside PI_SUBAGENT_OUT_CHARS");
assert((truncated.content?.[0]?.text ?? "").includes("HHHH"));
assert((truncated.content?.[0]?.text ?? "").includes("TTTT"));
assert.equal(readFileSync(truncated.details.fullOutputPath, "utf8").length, 2408);

// ─── P2: background runs ─────────────────────────────────────────────────────
// The notification/session machinery lives in lib/agent-runs.ts (lifted from
// bg-task.ts; see docs/subagent.md §8). Unit-level tests import it directly.
const runs = await import(path.join(pkgRoot, "lib", "agent-runs.ts"));

// ownership matrix: strict per-session notice ownership
const ownerFile = path.join(root, "owner.jsonl");
writeFileSync(ownerFile, "{}");
const now = Date.now();
assert.equal(runs.canNotifyHere(ownerFile, now - 1000, now, ownerFile), true, "own session always receives");
assert.equal(runs.canNotifyHere(ownerFile, now - 1000, now, path.join(root, "other.jsonl")), false, "foreign run with live owner must wait");
rmSync(ownerFile, { force: true });
assert.equal(runs.canNotifyHere(ownerFile, now - 1000, now, path.join(root, "other.jsonl")), true, "deleted owner session is adoptable");
assert.equal(runs.canNotifyHere(undefined, now - 61_000, now, undefined), true, "legacy no-owner run adopts after grace");
assert.equal(runs.canNotifyHere(undefined, now - 1000, now, undefined), false, "legacy no-owner run waits during grace");

// orphan finalize: dead process group → failed; live group and finished runs untouched
const ioDir = path.join(root, "io-runs");
mkdirSync(ioDir, { recursive: true });
const ioMeta = (id) => path.join(ioDir, id, "meta.json");
const ioWrite = (meta) => { mkdirSync(path.join(ioDir, meta.id), { recursive: true }); writeFileSync(ioMeta(meta.id), JSON.stringify(meta)); };
const ioRead = (id) => { try { return JSON.parse(readFileSync(ioMeta(id), "utf8")); } catch { return null; } };
const baseRun = (id, state, pgid, extra = {}) => ({ id, agent: "scout", task: `t-${id}`, cwd: root, state, pgid, pid: pgid, createdAt: now, startedAt: now, timeoutMin: 5, sessionFile: path.join(ioDir, id, "session.jsonl"), transcriptPath: path.join(ioDir, id, "transcript.jsonl"), resultPath: path.join(ioDir, id, "result.md"), usage: { turns: 0, input: 0, output: 0, cacheRead: 0, cacheWrite: 0, reasoning: 0, totalTokens: 0, cost: 0, costInput: 0, costOutput: 0, costCacheRead: 0, costCacheWrite: 0 }, ...extra });
ioWrite(baseRun("s-deadpgid", "running", 999_999_999));
const { spawn: spawnRaw } = await import("node:child_process");
const sleeper = spawnRaw("sleep", ["30"], { detached: true, stdio: "ignore" });
ioWrite(baseRun("s-alivepgid", "running", sleeper.pid));
ioWrite(baseRun("s-finished", "done", 999_999_999, { finishedAt: now }));
const orphanIo = { list: () => ["s-deadpgid", "s-alivepgid", "s-finished"].map(ioRead), save: (m) => ioWrite(m) };
const finalized = runs.finalizeOrphans(orphanIo, { now });
assert.deepEqual(finalized, ["s-deadpgid"], "only dead-process-group runs may be finalized");
assert.equal(ioRead("s-deadpgid").state, "failed");
assert.match(ioRead("s-deadpgid").error, /host exited/);
assert.equal(ioRead("s-alivepgid").state, "running", "live process group must stay running");
assert.equal(ioRead("s-finished").state, "done", "finished runs must never be re-finalized");
sleeper.kill("SIGKILL");

// prune: old finished dirs removed, recent kept, running never pruned
const pruned = [];
const pruneIo = {
  list: () => [
    baseRun("s-old-done", "done", 1, { finishedAt: now - 8 * 24 * 3_600_000 }),
    baseRun("s-new-done", "done", 1, { finishedAt: now - 1000 }),
    baseRun("s-old-running", "running", 1, { finishedAt: undefined }),
  ],
  remove: (id) => pruned.push(id),
};
assert.deepEqual(runs.pruneRuns(pruneIo, { now, maxAgeMs: 7 * 24 * 3_600_000 }), ["s-old-done"], "only old finished runs may be pruned");
assert.deepEqual(pruned, ["s-old-done"]);

// ── background tool flow (in-process, fake child) ──
const bgNotices = [];
mod.default({
  cwd: pkgRoot,
  registerTool: (t) => (registered.subagent = t),
  registerCommand: (n, c) => (commands[n] = c),
  on: (name, handler) => { (hooks[name] ??= []).push(handler); },
  registerShortcut: (shortcut, opts) => { (shortcuts ??= []).push({ shortcut, opts }); },
  sendMessage: (message, opts) => bgNotices.push({ message, opts }),
});

const bgSessionFile = path.join(root, "bg-session.jsonl");
writeFileSync(bgSessionFile, "{}");
const bgCtx = { ...ctx, sessionManager: { getSessionFile: () => bgSessionFile } };
const fire = (event, eventCtx) => { for (const handler of hooks[event] ?? []) handler({}, eventCtx); };
fire("session_start", { sessionManager: { getSessionFile: () => bgSessionFile } });

process.env.FAKE_SUBAGENT_DELAY_MS = "600";
writeFileSync(captureFile, "");
const bgT0 = Date.now();
const bgStart = await tool.execute("bg-start", { agent: "scout", task: "background please", run_in_background: true }, undefined, undefined, bgCtx);
const bgLag = Date.now() - bgT0;
delete process.env.FAKE_SUBAGENT_DELAY_MS;
assert(bgLag < 400, `background call must return immediately (took ${bgLag}ms)`);
assert.match(bgStart.content?.[0]?.text ?? "", /Background subagent started: s-[a-z0-9]+ \(scout\)/);
assert.match(bgStart.content?.[0]?.text ?? "", /\/subagents kill /, "start text must expose the kill command");
const bgId = (bgStart.content[0].text.match(/s-[a-z0-9]+/) || [])[0];
assert(bgId, "start text must expose the run id");
const bgMetaRead = () => JSON.parse(readFileSync(path.join(stateDir, bgId, "meta.json"), "utf8"));
await waitFor(() => bgMetaRead().state === "done", 8000);
await waitFor(() => !!bgMetaRead().notifiedAt, 3000);
assert(bgNotices.length >= 1, "finish must push a notice into the owner session");
const finishNotice = bgNotices.filter((n) => String(n.message?.content ?? "").includes(bgId)).at(-1);
assert(finishNotice, "finish notice must reference the run id");
assert.match(finishNotice.message.content, new RegExp(`'scout' \\(${bgId}\\) finished: done`));
assert.match(finishNotice.message.content, /result for Task: background please/, "finish notice must carry a result tail");
assert.match(finishNotice.message.content, new RegExp(`subagent\\(\\{ continue: "${bgId}"`));
assert(finishNotice.message.content.includes(path.join(stateDir, bgId, "result.md")), "finish notice must point at the full result on disk");
assert.equal(finishNotice.opts.deliverAs, "followUp", "owner in the foreground must be woken proactively");
assert.equal(finishNotice.opts.triggerTurn, true);
assert.equal(bgMetaRead().notifyTries, 1, "first delivery attempt must succeed via the targeted session api");

// sweep catch-up: a finished unnotified run surfaces on the owner's next activation
writeFileSync(path.join(stateDir, bgId, "meta.json"), JSON.stringify({ ...bgMetaRead(), notifiedAt: undefined }, null, 2));
bgNotices.length = 0;
fire("session_start", { sessionManager: { getSessionFile: () => bgSessionFile } });
await waitFor(() => bgNotices.length > 0, 3000);
assert.match(bgNotices[0].message.content, /finished since you were away/);
assert(bgMetaRead().notifiedAt, "sweep must mark the run delivered");

// strict ownership across sessions: a live foreign owner blocks adoption
const foreignOwner = path.join(root, "foreign-owner.jsonl");
writeFileSync(foreignOwner, "{}");
process.env.FAKE_SUBAGENT_DELAY_MS = "400";
const foreignStart = await tool.execute("foreign-bg", { agent: "scout", task: "foreign owner run", run_in_background: true }, undefined, undefined, { ...bgCtx, sessionManager: { getSessionFile: () => foreignOwner } });
delete process.env.FAKE_SUBAGENT_DELAY_MS;
const foreignId = (foreignStart.content[0].text.match(/s-[a-z0-9]+/) || [])[0];
const foreignMetaRead = () => JSON.parse(readFileSync(path.join(stateDir, foreignId, "meta.json"), "utf8"));
await waitFor(() => foreignMetaRead().state === "done", 8000);
bgNotices.length = 0;
fire("session_start", { sessionManager: { getSessionFile: () => bgSessionFile } });
await sleep(300);
assert(!bgNotices.some((notice) => String(notice.message?.content ?? "").includes(foreignId)), "a live foreign owner must block adoption");
assert(!foreignMetaRead().notifiedAt);
rmSync(foreignOwner, { force: true });
fire("session_start", { sessionManager: { getSessionFile: () => bgSessionFile } });
await waitFor(() => !!foreignMetaRead().notifiedAt, 3000);
assert(foreignMetaRead().notifiedAt, "deleted owner session must make the run adoptable");

// orphan finalize through the session hook: running meta with a dead pgid becomes failed
const hookOrphan = { ...baseRun("s-hookorphan", "running", 999_999_999), resultPath: path.join(stateDir, "s-hookorphan", "result.md") };
mkdirSync(path.join(stateDir, "s-hookorphan"), { recursive: true });
writeFileSync(path.join(stateDir, "s-hookorphan", "meta.json"), JSON.stringify(hookOrphan));
fire("tool_call", { sessionManager: { getSessionFile: () => bgSessionFile } });
const orphanAfter = JSON.parse(readFileSync(path.join(stateDir, "s-hookorphan", "meta.json"), "utf8"));
assert.equal(orphanAfter.state, "failed");
assert.match(orphanAfter.error, /host exited/);
assert(existsSync(path.join(stateDir, "s-hookorphan", "result.md")), "orphan finalize must leave a result file");

// context pump: silent in single-session mode; injects a system-reminder in multi-session mode
const markAllNotified = () => {
  for (const id of readdirSync(stateDir)) {
    const metaFile = path.join(stateDir, id, "meta.json");
    if (!existsSync(metaFile)) continue;
    const meta = JSON.parse(readFileSync(metaFile, "utf8"));
    if (!meta.notifiedAt && meta.finishedAt && meta.state !== "running" && meta.state !== "queued") {
      meta.notifiedAt = Date.now();
      writeFileSync(metaFile, JSON.stringify(meta, null, 2));
    }
  }
};
markAllNotified();
fire("session_start", { sessionManager: { getSessionFile: () => path.join(root, "second-session.jsonl") } });
const baseMessages = [{ role: "user", content: [{ type: "text", text: "hi" }] }];
const quietCtx = { sessionManager: { getSessionFile: () => path.join(root, "second-session.jsonl") } };
const fireContext = (eventCtx) => {
  let last = {};
  for (const handler of hooks.context ?? []) {
    const out = handler({ messages: baseMessages }, eventCtx);
    if (out && Object.keys(out).length) last = out;
  }
  return last;
};
assert.deepEqual(fireContext(quietCtx), {}, "context pump must stay silent with nothing pending");
writeFileSync(path.join(stateDir, bgId, "meta.json"), JSON.stringify({ ...bgMetaRead(), notifiedAt: undefined }, null, 2));
// strict ownership: pumping from the WRONG session must not surface the run
assert.deepEqual(fireContext(quietCtx), {}, "pending run of a live foreign owner must not be injected elsewhere");
assert(!bgMetaRead().notifiedAt, "foreign pump must not mark the run delivered");
// the owner session itself gets its pending notice injected on its next LLM call
const pumped = fireContext({ sessionManager: { getSessionFile: () => bgSessionFile } });
assert(pumped?.messages?.length === 2, "context pump must inject one reminder message");
assert.match(pumped.messages[1].content[0].text, /<system-reminder>/);
assert.match(pumped.messages[1].content[0].text, new RegExp(bgId));
assert(bgMetaRead().notifiedAt, "context pump must mark delivered runs");

// ── ui.confirm fallback for project agents in untrusted-but-promptable sessions ──
const projectRoot2 = path.join(root, "project2");
mkdirSync(path.join(projectRoot2, ".pi", "agents"), { recursive: true });
writeFileSync(path.join(projectRoot2, ".pi", "agents", "pinner.md"), `---\nname: pinner\ndescription: Project-only agent.\ntools: [read]\n---\n\nPINNER PROMPT\n`);
const confirmCalls = [];
const untrustedBase = { ...ctx, cwd: projectRoot2, isProjectTrusted: () => false, hasUI: true };
const denied = await tool.execute("confirm-deny", { agent: "pinner", task: "x" }, undefined, undefined, { ...untrustedBase, ui: { confirm: async (title, text) => { confirmCalls.push({ title, text }); return false; } } });
assert.match(denied.content?.[0]?.text ?? "", /unknown agent 'pinner'/);
assert.equal(confirmCalls.length, 1, "promptable untrusted session must be asked once");
assert.match(confirmCalls[0].title, /[Aa]gent/);
writeFileSync(captureFile, "");
const allowed = await tool.execute("confirm-allow", { agent: "pinner", task: "use project agent" }, undefined, undefined, { ...untrustedBase, ui: { confirm: async () => true } });
assert.equal(allowed.details?.run?.state, "done");
const allowSpawn = readFileSync(captureFile, "utf8").trim().split("\n").map(JSON.parse).find((event) => event.event === "start");
assert.equal(allowSpawn.args[allowSpawn.args.indexOf("--append-system-prompt") + 1], "PINNER PROMPT");

// ─── P3: rpc upgrade — steer / graceful wrap-up / inspect / doctor / events ──

// steer a running run via continue
process.env.FAKE_RPC_STEERABLE = "1";
process.env.FAKE_RPC_STEER_OUTPUT = "STEER-PIVOTED";
writeFileSync(captureFile, "");
process.env.FAKE_SUBAGENT_DELAY_MS = "4000";
const steerPromise = tool.execute("steer-target", { agent: "scout", task: "long running work" }, undefined, undefined, ctx);
const steerRun = await waitFor(() => readdirSync(stateDir)
  .map((id) => JSON.parse(readFileSync(path.join(stateDir, id, "meta.json"), "utf8")))
  .find((meta) => meta.task === "long running work" && meta.state === "running"));
await sleep(500); // let the in-flight turn be cancellable
const steerOutcome = await tool.execute("steer-call", { continue: steerRun.id, task: "pivot now" }, undefined, undefined, ctx);
delete process.env.FAKE_SUBAGENT_DELAY_MS;
assert.match(steerOutcome.content?.[0]?.text ?? "", new RegExp(`Steered run ${steerRun.id}`));
assert.match(steerOutcome.content?.[0]?.text ?? "", /still running/);
const steeredResult = await steerPromise;
delete process.env.FAKE_RPC_STEERABLE;
delete process.env.FAKE_RPC_STEER_OUTPUT;
assert.equal(steeredResult.details?.run?.state, "done");
assert.match(steeredResult.content?.[0]?.text ?? "", /STEER-PIVOTED/, "steered run must deliver the pivoted answer");
const steerSpawns = readFileSync(captureFile, "utf8").trim().split("\n").map(JSON.parse).filter((event) => event.event === "start");
assert.equal(steerSpawns.length, 1, "steering must reuse the live child, never spawn a second one");

// graceful wrap-up: timeout fires → wrap-up steer → child finishes inside grace → done
process.env.FAKE_RPC_WRAPUP_HONORS = "1";
process.env.FAKE_SUBAGENT_DELAY_MS = "3000";
const wrapped = await tool.execute("wrapup", { agent: "slow", task: "grace work" }, undefined, undefined, ctx);
delete process.env.FAKE_RPC_WRAPUP_HONORS;
delete process.env.FAKE_SUBAGENT_DELAY_MS;
assert.equal(wrapped.details?.run?.state, "done", "wrap-up completed inside the grace window is a done run");
assert.match(wrapped.content?.[0]?.text ?? "", /wrapped up on request/);

// timeout exceeded: child ignores wrap-up → abort → forced stop
process.env.FAKE_RPC_HANG = "1";
process.env.FAKE_SUBAGENT_DELAY_MS = "3000";
const hung = await tool.execute("hung", { agent: "slow", task: "hang work" }, undefined, undefined, ctx);
delete process.env.FAKE_RPC_HANG;
delete process.env.FAKE_SUBAGENT_DELAY_MS;
assert.equal(hung.details?.run?.state, "timeout");
const hungContinue = await tool.execute("resume-hang", { continue: hung.details.run.id, task: "finish it" }, undefined, undefined, ctx);
assert.equal(hungContinue.details?.run?.state, "done");

// /subagents inspect: full report for finished runs
notices.length = 0;
await commands.subagents.handler(`inspect ${steeredResult.details.run.id}`, ctx);
const inspectNotice = notices.map((notice) => notice.message).join("\n");
assert.match(inspectNotice, /STEER-PIVOTED/, "inspect must show the final result text");
assert.match(inspectNotice, /timeline:/, "inspect must include a tool-call timeline");
assert.match(inspectNotice, /1\.\s*read/, "timeline entries must list tool names in order");
assert.match(inspectNotice, /task:/, "inspect must show the delegated task");
assert.match(inspectNotice, /usage:/, "inspect must show usage totals");
assert.match(inspectNotice, /transcript:/, "inspect must point at the transcript on disk");
assert.match(inspectNotice, /final result:/, "inspect must show the final result");
const steerTranscript = readFileSync(path.join(stateDir, steeredResult.details.run.id, "transcript.jsonl"), "utf8");
assert(!steerTranscript.includes("message_update"), "transcript must exclude streamed deltas");
assert(!steerTranscript.includes("agent_end"), "transcript must exclude oversized agent_end payloads");
assert(steerTranscript.includes("tool_execution_start"), "transcript must keep consumed events");

// /subagents chat: the actual dialogue (user/assistant turns) of a run
notices.length = 0;
await commands.subagents.handler(`chat ${steeredResult.details.run.id}`, ctx);
const chatNotice = notices.map((notice) => notice.message).join("\n");
assert.match(chatNotice, /you:/, "chat must label user turns");
assert.match(chatNotice, /long running work/, "chat must show the delegated task text");
assert.match(chatNotice, /pivot now/, "chat must show steering messages as user turns");
assert.match(chatNotice, /scout:.*STEER-PIVOTED/s, "chat must show the assistant reply");

// /subagents doctor: environment health report
notices.length = 0;
await commands.subagents.handler("doctor", ctx);
const doctorText = notices.map((notice) => notice.message).join("\n");
assert.match(doctorText, /doctor/);
assert.match(doctorText, /state dir/i);
assert.match(doctorText, /agents?/i);
assert.match(doctorText, /OK|FAIL/);

// pi.events lifecycle emits
const lifecycleEvents = [];
mod.default({
  cwd: pkgRoot,
  registerTool: (t) => (registered.subagent = t),
  registerCommand: (n, c) => (commands[n] = c),
  on: (name, handler) => { (hooks[name] ??= []).push(handler); },
  registerShortcut: (shortcut, opts) => { (shortcuts ??= []).push({ shortcut, opts }); },
  events: { emit: (name, data) => lifecycleEvents.push({ name, data }) },
});
writeFileSync(captureFile, "");
const evented = await tool.execute("events", { agent: "scout", task: "emit lifecycle" }, undefined, undefined, ctx);
assert.equal(evented.details?.run?.state, "done");
assert(lifecycleEvents.some((entry) => entry.name === "subagent:started" && entry.data.id === evented.details.run.id), "must emit subagent:started");
assert(lifecycleEvents.some((entry) => entry.name === "subagent:finished" && entry.data.id === evented.details.run.id && entry.data.state === "done"), "must emit subagent:finished");

// completion completions argument for getArgumentCompletions must include inspect/doctor
const rootCompletions = commands.subagents.getArgumentCompletions("");
assert(rootCompletions?.some((item) => item.value === "inspect"), "inspect must be a root command");
assert(rootCompletions?.some((item) => item.value === "doctor"), "doctor must be a root command");
assert(rootCompletions.length <= 8);

// renderResult: click-to-inspect — run id is an OSC 8 link to result.md, hint line present
{
  const fakeTheme = { fg: (_k, t) => t, bold: (t) => t, success: (t) => t, error: (t) => t, muted: (t) => t, dim: (t) => t, toolTitle: (t) => t, toolOutput: (t) => t };
  const rendered = tool.renderResult({ content: [{ type: "text", text: "body" }], details: { run: JSON.parse(readFileSync(path.join(stateDir, evented.details.run.id, "meta.json"), "utf8")), activities: [{ toolName: "read", args: {} }] } }, { expanded: true }, fakeTheme);
  const lines = rendered.render(200);
  const joined = lines.join("\n");
  assert(joined.includes("\x1b]8;;file://"), "run id must be an OSC 8 hyperlink");
  assert(joined.includes(evented.details.run.resultPath), "hyperlink must target result.md");
  assert(joined.includes(`/subagents inspect ${evented.details.run.id}`), "expanded view must show the inspect hint");
  assert(joined.includes("1 tool call(s)"), "expanded view must show the activity count");
}

// blocking runs are delivered inline → must be marked notified (no sweep noise)
const inlineRun = await tool.execute("inline-notify", { agent: "scout", task: "inline delivery" }, undefined, undefined, ctx);
const inlineMeta = JSON.parse(readFileSync(path.join(stateDir, inlineRun.details.run.id, "meta.json"), "utf8"));
assert(inlineMeta.notifiedAt, "inline-delivered run must be marked notified immediately");
bgNotices.length = 0;
fire("session_start", { sessionManager: { getSessionFile: () => bgSessionFile } });
await sleep(250);
assert(!bgNotices.some((notice) => String(notice.message?.content ?? "").includes(inlineRun.details.run.id)), "inline-delivered run must never resurface in sweeps");

// /subagents chat (TUI): opens the interactive viewer — no id → picker first
{
  const fakeTheme = { fg: (_k, t) => t, bold: (t) => t };
  const customCalls = [];
  const selectCalls = [];
  const tuiCtx = {
    ...ctx,
    hasUI: true,
    ui: {
      notify: (message, level) => notices.push({ message, level }),
      select: async (title, options) => {
        selectCalls.push({ title, options });
        return options.find((option) => option.includes(steeredResult.details.run.id));
      },
      custom: async (factory, opts) => {
        customCalls.push({ factory, opts });
        return undefined;
      },
    },
  };
  // no id → picker must list session runs, selecting one opens the viewer
  await commands.subagents.handler("chat", tuiCtx);
  assert.equal(customCalls.length, 1, "picker selection must open the viewer");
  assert.equal(selectCalls.length, 1);
  assert(selectCalls[0].options.some((option) => option.includes(steeredResult.details.run.id)));
  const doneSpyCalls = [];
  const fakeTui = { requestRender: () => {} };
  const component = customCalls[0].factory(fakeTui, fakeTheme, {}, (value) => doneSpyCalls.push(value));
  assert(component, "viewer factory must return a component");
  const viewLines = component.render(100);
  assert(viewLines.some((line) => line.includes("STEER-PIVOTED")), "viewer must render the assistant turn");
  assert(viewLines.some((line) => line.includes("long running work")), "viewer must render the user turn");
  assert(viewLines.some((line) => line.includes("esc")), "viewer must show exit hint");
  // scroll + exit
  const before = component.scrollTop ?? 0;
  component.handleInput?.("\x1b[B");
  assert((component.scrollTop ?? 0) >= before, "down must scroll (or stay at end)");
  component.handleInput?.("\x1b");
  assert.equal(doneSpyCalls.length, 1, "escape must close the viewer");
  // explicit id skips the picker
  customCalls.length = 0;
  selectCalls.length = 0;
  await commands.subagents.handler(`chat ${steeredResult.details.run.id}`, tuiCtx);
  assert.equal(customCalls.length, 1, "explicit id must open the viewer directly");
  assert.equal(selectCalls.length, 0, "explicit id must skip the picker");
  // running run gets a live marker
  process.env.FAKE_SUBAGENT_DELAY_MS = "1500";
  const livePromise = tool.execute("viewer-live", { agent: "scout", task: "live viewer run" }, undefined, undefined, ctx);
  const liveId = await waitFor(() => readdirSync(stateDir)
    .map((entry) => JSON.parse(readFileSync(path.join(stateDir, entry, "meta.json"), "utf8")))
    .find((meta) => meta.task === "live viewer run" && meta.state === "running")).then((meta) => meta.id);
  customCalls.length = 0;
  await commands.subagents.handler(`chat ${liveId}`, tuiCtx);
  delete process.env.FAKE_SUBAGENT_DELAY_MS;
  const liveComponent = customCalls[0].factory(fakeTui, fakeTheme, {}, () => {});
  const liveHeader = liveComponent.render(100).join("\n");
  assert(/live/i.test(liveHeader), "viewer must mark running runs as live");
  liveComponent.handleInput?.("\x1b");
  await livePromise;
}

// non-TUI fallback: chat without a UI keeps the plain notify transcript
notices.length = 0;
await commands.subagents.handler(`chat ${steeredResult.details.run.id}`, { ...ctx, hasUI: false });
assert(notices.some((notice) => /STEER-PIVOTED/.test(notice.message)), "text fallback must keep working");

// in-viewer actions: s = steer a live child, D×2 = stop the run
{
  const customCalls = [];
  const fakeTheme = { fg: (_k, t) => t, bold: (t) => t };
  const actionCtx = {
    ...ctx,
    hasUI: true,
    ui: {
      notify: (message, level) => notices.push({ message, level }),
      select: async (_title, options) => options[0],
      custom: async (factory) => {
        customCalls.push(factory);
        return undefined;
      },
    },
  };
  writeFileSync(captureFile, "");
  process.env.FAKE_RPC_STEERABLE = "1";
  process.env.FAKE_SUBAGENT_DELAY_MS = "2500";
  const livePromise = tool.execute("action-live", { agent: "scout", task: "viewer actions run" }, undefined, undefined, ctx);
  const liveRun = await waitFor(() => readdirSync(stateDir)
    .map((entry) => JSON.parse(readFileSync(path.join(stateDir, entry, "meta.json"), "utf8")))
    .find((meta) => meta.task === "viewer actions run" && meta.state === "running"));
  // steer via s + typed text + enter
  customCalls.length = 0;
  await commands.subagents.handler(`chat ${liveRun.id}`, actionCtx);
  const viewer = customCalls[0]({ requestRender: () => {} }, fakeTheme, {}, () => {});
  viewer.handleInput("s");
  viewer.handleInput("p");
  viewer.handleInput("i");
  viewer.handleInput("v");
  viewer.handleInput("\r");
  await waitFor(() => readFileSync(captureFile, "utf8").includes('"steer"'), 4000);
  const steerEvent = readFileSync(captureFile, "utf8").trim().split("\n").map(JSON.parse).find((event) => event.event === "steer");
  assert.equal(steerEvent.message, "piv");
  // esc inside input mode cancels input (does not close the viewer)
  viewer.handleInput("s");
  viewer.handleInput("\x1b");
  const closedEarly = viewer.render(100).length === 0;
  assert(!closedEarly, "esc while composing must cancel input, not the viewer");
  // double-D kill
  viewer.handleInput("D");
  viewer.handleInput("D");
  const killedResult = await livePromise;
  delete process.env.FAKE_RPC_STEERABLE;
  delete process.env.FAKE_SUBAGENT_DELAY_MS;
  assert.equal(killedResult.details?.run?.state, "killed", "double-D must stop the run");
  viewer.handleInput("\x1b"); // now esc closes (run finished)
}

console.log("ALL SUBAGENT E2E TESTS PASSED");
rmSync(root, { recursive: true, force: true });
