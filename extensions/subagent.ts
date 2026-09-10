// pi extension: delegate work to isolated subprocess agents.
//
// P1 uses `pi --mode json -p` with a persistent session file. Children are
// clean-room by default; agent frontmatter opts specific tools, extensions,
// skills, and MCP servers back in. See docs/subagent.md.

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { hyperlink, matchesKey, Key, Text, truncateToWidth, wrapTextWithAnsi } from "@earendil-works/pi-tui";
import { Type } from "typebox";
import { parse as parseYaml } from "yaml";
import { spawn } from "node:child_process";
import {
  appendFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { extractToolArgs, requireString, textResult } from "../lib/tool-compat.ts";
import { startRpcChild, type RpcChild } from "../lib/rpc-child.ts";
import { lowPrio } from "../lib/low-prio.ts";
import {
  captureExtensionApi,
  deliverRunNotice,
  sendToSession,
  finalizeOrphans,
  pruneRuns,
  pumpContext,
  sweepFinishedRuns,
  trackSession,
  type RunNoticeMeta,
} from "../lib/agent-runs.ts";

function envInt(name: string, fallback: number, min: number, max: number): number {
  const parsed = Number(process.env[name]);
  if (!Number.isFinite(parsed)) return fallback;
  return Math.min(max, Math.max(min, Math.round(parsed)));
}

const EXTENSION_DIR = path.dirname(fileURLToPath(import.meta.url));
const BUNDLE_DIR = process.env.PI_SUBAGENT_BUNDLE_DIR || path.dirname(EXTENSION_DIR);
const CONFIG_DIR_NAME = ".pi";
const AGENT_DIR = process.env.PI_CODING_AGENT_DIR || path.join(os.homedir(), CONFIG_DIR_NAME, "agent");
const STATE_DIR = process.env.PI_SUBAGENT_STATE_DIR || path.join(AGENT_DIR, "subagents");
const DEFAULT_TIMEOUT_MIN = envInt("PI_SUBAGENT_TIMEOUT_MIN", 15, 0, 24 * 60);
const MAX_CONCURRENT = envInt("PI_SUBAGENT_MAX_CONCURRENT", 4, 1, 16);
const MAX_OUTPUT_CHARS = envInt("PI_SUBAGENT_OUT_CHARS", 200_000, 1_000, 2_000_000);
const MAX_OUTPUT_LINES = envInt("PI_SUBAGENT_OUT_LINES", 5_000, 100, 50_000);
const RECOVERY_TRANSCRIPT_CHARS = 24_000;
const STDERR_CAP_CHARS = 32_000;
const KILL_ESCALATE_MS = 5_000;
// timeout: wrap-up steer → wait grace → abort → SIGTERM → SIGKILL
const WRAPUP_MS = envInt("PI_SUBAGENT_WRAPUP_SEC", 45, 0, 600) * 1000;
// after turn_end, wait this long for a steered turn to begin before declaring idle
const STEER_QUIET_MS = 700;

// live rpc children of in-flight runs (this process only) — steer targets
const liveRuns = new Map<string, { child: RpcChild }>();
// lifecycle bus set by the factory from pi.events (guarded — hosts may omit it)
let emitLifecycle: (event: string, data: Record<string, unknown>) => void = () => {};
const CLEAN_ROOM_FLAGS = [
  "--no-extensions",
  "--no-skills",
  "--no-context-files",
  "--no-prompt-templates",
  "--no-themes",
];

interface AgentConfig {
  name: string;
  description: string;
  enabled: boolean;
  model?: string;
  tools?: string[];
  extensions: string[];
  skills: string[];
  mcp: string[];
  thinking?: string;
  timeoutMin: number;
  systemPrompt: string;
  source: "user" | "project";
  filePath: string;
}

type RunState = "queued" | "running" | "done" | "failed" | "timeout" | "killed";

interface UsageTotals {
  turns: number;
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
  reasoning: number;
  totalTokens: number;
  cost: number;
  costInput: number;
  costOutput: number;
  costCacheRead: number;
  costCacheWrite: number;
}

interface RunMeta {
  id: string;
  agent: string;
  task: string;
  cwd: string;
  state: RunState;
  model?: string;
  ownerSession?: string;
  pid: number;
  pgid: number;
  createdAt: number;
  startedAt?: number;
  finishedAt?: number;
  timeoutMin: number;
  exitCode?: number | null;
  signal?: string | null;
  error?: string;
  /** completion notify policy for the LATEST run round: false = quiet (viewer send), default/true = push+turn */
  notifyOnDone?: boolean;
  sessionFile: string;
  transcriptPath: string;
  resultPath: string;
  usage: UsageTotals;
}

interface ToolActivity {
  toolName: string;
  args: Record<string, unknown>;
}

class Semaphore {
  private active = 0;
  private waiting: Array<() => void> = [];

  async acquire(): Promise<() => void> {
    if (this.active >= MAX_CONCURRENT) await new Promise<void>((resolve) => this.waiting.push(resolve));
    this.active++;
    let released = false;
    return () => {
      if (released) return;
      released = true;
      this.active--;
      this.waiting.shift()?.();
    };
  }
}

const childSlots = new Semaphore();

interface RunDetails {
  run: RunMeta;
  activities: ToolActivity[];
  fullOutputPath?: string;
  truncated?: boolean;
}

type Frontmatter = {
  name?: unknown;
  description?: unknown;
  enabled?: unknown;
  model?: unknown;
  tools?: unknown;
  extensions?: unknown;
  skills?: unknown;
  mcp?: unknown;
  thinking?: unknown;
  timeout?: unknown;
};

type ToolCtx = {
  cwd?: string;
  model?: { provider?: string; id?: string };
  thinkingLevel?: string;
  hasUI?: boolean;
  isProjectTrusted?: () => boolean;
  sessionManager?: { getSessionFile?: () => string | undefined };
  ui?: { notify?: (message: string, level: string) => void; confirm?: (title: string, message: string) => Promise<boolean> };
};

type OnUpdate = (result: {
  content: Array<{ type: "text"; text: string }>;
  details: RunDetails;
}) => void;

function emptyUsage(): UsageTotals {
  return {
    turns: 0,
    input: 0,
    output: 0,
    cacheRead: 0,
    cacheWrite: 0,
    reasoning: 0,
    totalTokens: 0,
    cost: 0,
    costInput: 0,
    costOutput: 0,
    costCacheRead: 0,
    costCacheWrite: 0,
  };
}

function parseList(value: unknown): string[] {
  const raw = Array.isArray(value) ? value : typeof value === "string" ? value.split(",") : [];
  return raw
    .filter((item): item is string => typeof item === "string")
    .map((item) => item.trim())
    .filter(Boolean);
}

function parseAgentMarkdown(content: string): { frontmatter: Frontmatter; body: string } {
  const normalized = content.replace(/\r\n?/g, "\n");
  if (!normalized.startsWith("---\n")) return { frontmatter: {}, body: normalized.trim() };
  const end = normalized.indexOf("\n---", 4);
  if (end < 0) return { frontmatter: {}, body: normalized.trim() };
  const parsed = parseYaml(normalized.slice(4, end));
  const frontmatter = parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed : {};
  return { frontmatter: frontmatter as Frontmatter, body: normalized.slice(end + 4).trim() };
}

function loadAgentsFromDir(dir: string, source: AgentConfig["source"]): AgentConfig[] {
  if (!existsSync(dir)) return [];
  let entries: ReturnType<typeof readdirSync>;
  try {
    entries = readdirSync(dir, { withFileTypes: true });
  } catch {
    return [];
  }
  const agents: AgentConfig[] = [];
  for (const entry of entries) {
    if (!entry.name.endsWith(".md") || (!entry.isFile() && !entry.isSymbolicLink())) continue;
    const filePath = path.join(dir, entry.name);
    try {
      const { frontmatter, body } = parseAgentMarkdown(readFileSync(filePath, "utf8"));
      if (typeof frontmatter.name !== "string" || typeof frontmatter.description !== "string") continue;
      const parsedTimeout = Number(frontmatter.timeout);
      const enabledRaw = frontmatter.enabled;
      const enabled = enabledRaw === undefined ? true : enabledRaw !== false && String(enabledRaw).toLowerCase() !== "false";
      agents.push({
        name: frontmatter.name.trim(),
        description: frontmatter.description.trim(),
        enabled,
        model: typeof frontmatter.model === "string" && frontmatter.model !== "inherit" ? frontmatter.model.trim() : undefined,
        tools: parseList(frontmatter.tools).length ? parseList(frontmatter.tools) : undefined,
        extensions: parseList(frontmatter.extensions),
        skills: parseList(frontmatter.skills),
        mcp: parseList(frontmatter.mcp),
        thinking: typeof frontmatter.thinking === "string" && frontmatter.thinking !== "inherit" ? frontmatter.thinking.trim() : undefined,
        timeoutMin: Number.isFinite(parsedTimeout) && parsedTimeout >= 0 ? parsedTimeout : DEFAULT_TIMEOUT_MIN,
        systemPrompt: body.trim(),
        source,
        filePath,
      });
    } catch {
      // One malformed agent must not hide the remaining valid definitions.
    }
  }
  return agents;
}

function nearestProjectAgentsDir(cwd: string): string | null {
  let current = path.resolve(cwd);
  for (;;) {
    const candidate = path.join(current, CONFIG_DIR_NAME, "agents");
    try {
      if (statSync(candidate).isDirectory()) return candidate;
    } catch {
      // keep walking
    }
    const parent = path.dirname(current);
    if (parent === current) return null;
    current = parent;
  }
}

// per-session agent toggles (/subagents agents off|on) — in-memory, resets on reload
const sessionDisabled = new Set<string>();

function discoverAgents(cwd: string, projectTrusted: boolean): AgentConfig[] {
  const byName = new Map<string, AgentConfig>();
  for (const agent of loadAgentsFromDir(path.join(AGENT_DIR, "agents"), "user")) {
    byName.set(agent.name, { ...agent, enabled: agent.enabled && !sessionDisabled.has(agent.name) });
  }
  const projectDir = nearestProjectAgentsDir(cwd);
  if (projectTrusted && projectDir) {
    for (const agent of loadAgentsFromDir(projectDir, "project")) {
      byName.set(agent.name, { ...agent, enabled: agent.enabled && !sessionDisabled.has(agent.name) });
    }
  }
  return [...byName.values()].sort((a, b) => a.name.localeCompare(b.name));
}

function enabledAgents(agents: AgentConfig[]): AgentConfig[] {
  return agents.filter((agent) => agent.enabled);
}

function projectAgentsAllowed(targetCwd: string, ctx: ToolCtx | undefined): boolean {
  if (!ctx?.isProjectTrusted?.()) return false;
  return path.resolve(targetCwd) === path.resolve(ctx.cwd || targetCwd);
}

// Single-writer discipline: merges a patch into the CURRENT on-disk meta so a
// kill (stale read) can never clobber usage/model fields written concurrently.
function mergeMeta(id: string, patch: (current: RunMeta) => RunMeta): RunMeta {
  const current = readMeta(id) ?? ({} as RunMeta);
  const merged = patch(current);
  writeMeta(merged);
  return merged;
}

function nextId(): string {
  return `s-${Date.now().toString(36).slice(-6)}${Math.random().toString(36).slice(2, 5)}`;
}

function runDir(id: string): string {
  return path.join(STATE_DIR, id);
}

function metaPath(id: string): string {
  return path.join(runDir(id), "meta.json");
}

function writeMeta(meta: RunMeta): void {
  mkdirSync(runDir(meta.id), { recursive: true });
  const temp = `${metaPath(meta.id)}.${process.pid}.tmp`;
  writeFileSync(temp, JSON.stringify(meta, null, 2));
  renameSync(temp, metaPath(meta.id));
}

function readMeta(id: string): RunMeta | null {
  try {
    return JSON.parse(readFileSync(metaPath(id), "utf8")) as RunMeta;
  } catch {
    return null;
  }
}

function listMetas(): RunMeta[] {
  try {
    return readdirSync(STATE_DIR)
      .map((name) => readMeta(name))
      .filter((meta): meta is RunMeta => !!meta)
      .sort((a, b) => b.createdAt - a.createdAt);
  } catch {
    return [];
  }
}

function resolveBundleExtension(name: string): string {
  if (!/^[a-zA-Z0-9][a-zA-Z0-9._-]*$/.test(name)) throw new Error(`invalid extension name '${name}'`);
  const file = path.join(EXTENSION_DIR, name.endsWith(".ts") ? name : `${name}.ts`);
  if (!existsSync(file)) throw new Error(`bundle extension '${name}' not found: ${file}`);
  return file;
}

function findSkill(name: string, cwd: string): string {
  if (!/^[a-z0-9][a-z0-9-]*$/.test(name)) throw new Error(`invalid skill name '${name}'`);
  const candidates = [
    path.join(BUNDLE_DIR, "skills", name, "SKILL.md"),
    path.join(AGENT_DIR, "skills", name, "SKILL.md"),
    path.join(os.homedir(), ".agents", "skills", name, "SKILL.md"),
    path.join(AGENT_DIR, "skills", `${name}.md`),
  ];
  let current = path.resolve(cwd);
  for (;;) {
    candidates.push(path.join(current, CONFIG_DIR_NAME, "skills", name, "SKILL.md"));
    candidates.push(path.join(current, ".agents", "skills", name, "SKILL.md"));
    const parent = path.dirname(current);
    if (parent === current) break;
    current = parent;
  }
  const found = candidates.find(existsSync);
  if (!found) throw new Error(`skill '${name}' not found in pi skill locations`);
  return found;
}

// Children resolve mcp: names against this user-level file. It is deliberately
// NOT the main session's MCP config — the pi-mcp-adapter in normal sessions
// reads .mcp.json / ~/.config/mcp/mcp.json, so this file is subagent-only by
// construction (the main agent stays MCP-free while children opt in).
const MCP_CONFIG_FILE = "subagent_mcp.json";
const LEGACY_MCP_CONFIG_FILE = "mcp.json";

function mcpConfigSource(): { path: string; legacy: boolean } {
  const preferred = path.join(AGENT_DIR, MCP_CONFIG_FILE);
  if (existsSync(preferred)) return { path: preferred, legacy: false };
  const legacy = path.join(AGENT_DIR, LEGACY_MCP_CONFIG_FILE);
  if (existsSync(legacy)) return { path: legacy, legacy: true };
  return { path: preferred, legacy: false }; // missing → caller surfaces ENOENT
}

function prepareMcp(agent: AgentConfig, dir: string): { adapter: string; config: string } | null {
  if (!agent.mcp.length) return null;
  const source = mcpConfigSource().path;
  const parsed = JSON.parse(readFileSync(source, "utf8")) as {
    settings?: Record<string, unknown>;
    mcpServers?: Record<string, unknown>;
  };
  const available = parsed.mcpServers ?? {};
  const missing = agent.mcp.filter((name) => !(name in available));
  if (missing.length) throw new Error(`MCP server(s) not found: ${missing.join(", ")}`);
  const mcpServers = Object.fromEntries(agent.mcp.map((name) => [name, available[name]]));
  const config = path.join(dir, ".mcp-filtered.json");
  writeFileSync(config, JSON.stringify({ settings: parsed.settings ?? {}, mcpServers }, null, 2), { mode: 0o600 });
  const adapter = path.join(AGENT_DIR, "npm", "node_modules", "pi-mcp-adapter", "index.ts");
  if (!existsSync(adapter)) throw new Error(`pi-mcp-adapter not found: ${adapter}`);
  return { adapter, config };
}

function getPiInvocation(args: string[]): { command: string; args: string[] } {
  const testScript = process.env.PI_SUBAGENT_PI_SCRIPT;
  if (testScript && testScript.trim()) return { command: process.execPath, args: [testScript, ...args] };
  const currentScript = process.argv[1];
  const looksLikeHost = currentScript && !currentScript.startsWith("/$bunfs/root/") && /\b(cli|pi|index|main)\.(m?js)$/.test(currentScript) && existsSync(currentScript);
  if (looksLikeHost) {
    return { command: process.execPath, args: [currentScript!, ...args] };
  }
  const execName = path.basename(process.execPath).toLowerCase();
  if (!/^(node|bun)(\.exe)?$/.test(execName)) return { command: process.execPath, args };
  return { command: "pi", args };
}

function assistantText(message: unknown): string {
  const msg = message as { role?: string; content?: Array<{ type?: string; text?: string }> };
  if (msg?.role !== "assistant" || !Array.isArray(msg.content)) return "";
  return msg.content.findLast((part) => part.type === "text")?.text ?? "";
}

function applyUsage(total: UsageTotals, message: unknown): void {
  const usage = (message as { usage?: Record<string, any> })?.usage;
  if (!usage) return;
  total.turns += 1;
  total.input += Number(usage.input) || 0;
  total.output += Number(usage.output) || 0;
  total.cacheRead += Number(usage.cacheRead) || 0;
  total.cacheWrite += Number(usage.cacheWrite) || 0;
  total.reasoning += Number(usage.reasoning) || 0;
  total.totalTokens += Number(usage.totalTokens) || 0;
  total.cost += Number(usage.cost?.total) || 0;
  total.costInput += Number(usage.cost?.input) || 0;
  total.costOutput += Number(usage.cost?.output) || 0;
  total.costCacheRead += Number(usage.cost?.cacheRead) || 0;
  total.costCacheWrite += Number(usage.cost?.cacheWrite) || 0;
}

function truncateOutput(text: string): { text: string; truncated: boolean } {
  const lines = text.split("\n");
  if (text.length <= MAX_OUTPUT_CHARS && lines.length <= MAX_OUTPUT_LINES) return { text, truncated: false };
  const headLines = Math.max(1, Math.floor(MAX_OUTPUT_LINES / 2));
  const tailLines = Math.max(1, MAX_OUTPUT_LINES - headLines);
  let output = `${lines.slice(0, headLines).join("\n")}\n\n[... output truncated; full result on disk ...]\n\n${lines.slice(-tailLines).join("\n")}`;
  if (output.length > MAX_OUTPUT_CHARS) {
    const half = Math.max(1, Math.floor((MAX_OUTPUT_CHARS - 100) / 2));
    output = `${output.slice(0, half)}\n\n[... output truncated; full result on disk ...]\n\n${output.slice(-half)}`;
  }
  return { text: output, truncated: true };
}

function modelVisibleOutput(output: string, meta: RunMeta): string {
  const footer = [
    `[subagent run: ${meta.id} · ${meta.agent} · ${meta.state}]`,
    `Continue with: subagent({ continue: "${meta.id}", task: "..." })`,
  ].join("\n");
  const separator = "\n\n";
  const outputBudget = Math.max(0, MAX_OUTPUT_CHARS - separator.length - footer.length);
  const bounded = output.length <= outputBudget ? output : `${output.slice(0, Math.max(0, outputBudget - 1))}…`;
  return `${bounded}${separator}${footer}`;
}

// Foreground results are delivered inline the moment runAgent resolves —
// mark them notified so sweeps never resurface them as "finished since you
// were away" noise. Already-marked runs are left untouched.
function markInlineDelivered(id: string): void {
  try {
    mergeMeta(id, (current) => (current.notifiedAt ? current : { ...current, notifiedAt: Date.now() }));
  } catch { /* meta is best-effort */ }
  updateFleetWidget();
}

function bgStartText(id: string, agentName: string, model?: string): string {
  const modelTag = model ? ` · ${model}` : "";
  return [
    `Background subagent started: ${id} (${agentName}${modelTag}).`,
    "You will be notified here when it finishes; keep working meanwhile.",
    `Progress: /subagents list · Stop: /subagents kill ${id}`,
  ].join("\n");
}

// FleetView widget (below editor): compact live summary of active runs.
// The setter is captured from the first TUI context that provides it.
let fleetSetWidget: ((key: string, lines?: string[]) => void) | null = null;

function updateFleetWidget(): void {
  if (!fleetSetWidget) return;
  const active = listMetas().filter((run) => run.state === "running" || run.state === "queued");
  if (!active.length) {
    fleetSetWidget("subagents", undefined);
    return;
  }
  const now = Date.now();
  const lines = [`${active.length} subagent run(s) active · ctrl+alt+s viewer`];
  for (const run of active.slice(0, 5)) {
    const elapsed = fmtDur(now - (run.startedAt ?? run.createdAt));
    lines.push(`  ${run.id} · ${run.agent} · ${run.state} · ${elapsed} · ${run.task.slice(0, 40)}`);
  }
  fleetSetWidget("subagents", lines);
}

// Fire-and-forget: when a background run settles, push its notice to the owner
// session. Failed pushes stay pending — the sweep and context pump own them.
function launchBackground(running: Promise<unknown>, id: string, runsIo: RunsIo): void {
  void running.then(() => {
    const final = readMeta(id);
    if (!final || final.notifiedAt) return;
    if (final.notifyOnDone === false) {
      // quiet round (user sent it from the viewer and is watching there):
      // mark delivered so sweeps never resurface it — no chat push, no turn
      mergeMeta(id, (current) => (current.notifiedAt ? current : { ...current, notifiedAt: Date.now() }));
      return;
    }
    deliverRunNotice(final, runsIo);
  }).catch(() => {}).finally(() => updateFleetWidget());
}

function killProcessGroup(meta: RunMeta): void {
  try {
    process.kill(-meta.pgid, "SIGTERM");
  } catch {
    try { process.kill(meta.pid, "SIGTERM"); } catch { return; }
  }
  const timer = setTimeout(() => {
    try { process.kill(-meta.pgid, "SIGKILL"); } catch {
      try { process.kill(meta.pid, "SIGKILL"); } catch { /* gone */ }
    }
  }, KILL_ESCALATE_MS);
  timer.unref?.();
}

function recoveryTask(meta: RunMeta): string {
  let transcript = "";
  try {
    transcript = readFileSync(meta.transcriptPath, "utf8").slice(-RECOVERY_TRANSCRIPT_CHARS);
  } catch {
    // A run may fail before producing any stdout.
  }
  const assistant = transcript
    .split("\n")
    .filter(Boolean)
    .flatMap((line) => {
      try {
        const event = JSON.parse(line) as { type?: string; message?: unknown };
        const text = event.type === "message_end" ? assistantText(event.message) : "";
        return text ? [text] : [];
      } catch {
        return [];
      }
    })
    .slice(-4)
    .join("\n\n");
  const recovered = assistant || "(no completed assistant message; inspect the existing project files and continue cautiously)";
  return `Recovered transcript from the interrupted run:\n\n${recovered}\n\nFollow-up task:\n${meta.task}`;
}

function buildArgs(agent: AgentConfig, meta: RunMeta, cwd: string, inherited: { model?: string; thinking?: string }, recovering: boolean): { args: string[]; mcpConfig?: string } {
  const args = ["--mode", "rpc", "--session", meta.sessionFile, ...CLEAN_ROOM_FLAGS];
  if (meta.model) args.push("--model", meta.model);
  const thinking = agent.thinking ?? inherited.thinking;
  if (thinking) args.push("--thinking", thinking);
  if (agent.tools?.length) {
    const tools = agent.mcp.length ? [...new Set([...agent.tools, "mcp", "mcpScript"])] : agent.tools;
    args.push("--tools", tools.join(","));
  }
  for (const extension of agent.extensions) args.push("-e", resolveBundleExtension(extension));
  for (const skill of agent.skills) args.push("--skill", findSkill(skill, cwd));
  const mcp = prepareMcp(agent, runDir(meta.id));
  if (mcp) args.push("-e", mcp.adapter, "--mcp-config", mcp.config);
  if (agent.systemPrompt) args.push("--append-system-prompt", agent.systemPrompt);
  args.push(recovering ? recoveryTask(meta) : `Task: ${meta.task}`);
  return { args, mcpConfig: mcp?.config };
}

type RunResult = { content: Array<{ type: "text"; text: string }>; details: RunDetails; usage?: Record<string, unknown> };

async function continueRun(
  id: string,
  task: string,
  ctx: ToolCtx | undefined,
  signal: AbortSignal | undefined,
  onUpdate?: OnUpdate,
  runsIo?: RunsIo,
  bg = false,
  notifyOnDone?: boolean,
): Promise<RunResult | string> {
  const existing = readMeta(id);
  if (!existing) return `error: run '${id}' not found — use /subagents list`;
  if (existing.state === "running") return steerRun(id, task);
  if (existing.state === "queued") return `error: run '${id}' is still queued — not yet steerable`;
  const cwd = existing.cwd || ctx?.cwd || process.cwd();
  const agent = discoverAgents(cwd, projectAgentsAllowed(cwd, ctx)).find((candidate) => candidate.name === existing.agent);
  if (!agent) {
    const anyAgent = discoverAgents(cwd, false).some((candidate) => candidate.name === existing.agent);
    return anyAgent
      ? `error: agent '${existing.agent}' for run '${id}' is disabled — /subagents agents on ${existing.agent} to enable`
      : `error: agent '${existing.agent}' for run '${id}' is no longer available`;
  }
  const inherited = { model: existing.model, thinking: ctx?.thinkingLevel };
  if (bg && runsIo) {
    const running = runAgent(agent, task, cwd, inherited, existing.ownerSession, undefined, undefined, existing, { notifyOnDone });
    launchBackground(running, existing.id, runsIo);
    return bgStartText(existing.id, agent.name, inherited.model);
  }
  return runAgent(agent, task, cwd, inherited, existing.ownerSession, signal, onUpdate, existing).then((result) => {
    markInlineDelivered(existing.id);
    return result;
  });
}

function steerRun(id: string, message: string): Promise<string> {
  const live = liveRuns.get(id);
  if (!live) {
    return Promise.resolve(`error: run '${id}' is not live in this process (already finished, or spawned by another session or before a reload)`);
  }
  return live.child.request({ type: "steer", message })
    .then((response) => response.success === false
      ? `error: steer rejected for run '${id}'`
      : `Steered run ${id} — instruction delivered; still running. The result arrives as usual (call result or background notice).`)
    .catch((error: unknown) => `error: steer failed for run '${id}': ${(error as Error).message}`);
}

async function runAgent(
  agent: AgentConfig,
  task: string,
  cwd: string,
  inherited: { model?: string; thinking?: string },
  ownerSession: string | undefined,
  signal: AbortSignal | undefined,
  onUpdate: OnUpdate | undefined,
  existing?: RunMeta,
  opts?: { notifyOnDone?: boolean },
  onStart?: (meta: RunMeta) => void,
): Promise<{ content: Array<{ type: "text"; text: string }>; details: RunDetails; usage?: Record<string, unknown> }> {
  const id = existing?.id ?? nextId();
  const dir = runDir(id);
  mkdirSync(dir, { recursive: true });
  const meta: RunMeta = existing
    ? {
        ...existing,
        task,
        state: "running",
        model: existing.model ?? inherited.model ?? agent.model,
        pid: 0,
        pgid: 0,
        startedAt: Date.now(),
        finishedAt: undefined,
        exitCode: undefined,
        signal: undefined,
        error: undefined,
        timeoutMin: agent.timeoutMin,
        // a new round is a new notification cycle — never inherit the
        // previous round's delivered marker or retry counter
        notifiedAt: undefined,
        notifyTries: undefined,
        ...(opts?.notifyOnDone !== undefined ? { notifyOnDone: opts.notifyOnDone } : {}),
      }
    : {
        id,
        agent: agent.name,
        task,
        cwd,
        state: "queued",
        model: inherited.model ?? agent.model,
        ownerSession,
        pid: 0,
        pgid: 0,
        createdAt: Date.now(),
        startedAt: Date.now(),
        timeoutMin: agent.timeoutMin,
        sessionFile: path.join(dir, "session.jsonl"),
        transcriptPath: path.join(dir, "transcript.jsonl"),
        resultPath: path.join(dir, "result.md"),
        usage: emptyUsage(),
      };
  writeMeta(meta);
  onStart?.(meta);
  updateFleetWidget();

  const releaseSlot = await childSlots.acquire();
  const queuedState = readMeta(meta.id)?.state;
  if (queuedState === "killed") {
    meta.state = "killed";
    meta.finishedAt = Date.now();
    meta.error = "run cancelled while queued";
    writeFileSync(meta.resultPath, meta.error);
    writeMeta(meta);
    releaseSlot();
    return {
      content: [{ type: "text", text: meta.error }],
      details: { run: meta, activities: [], fullOutputPath: meta.resultPath },
    };
  }
  meta.state = "running";
  meta.startedAt = Date.now();
  writeMeta(meta);

  const activities: ToolActivity[] = [];
  let finalOutput = "";
  let stderr = "";
  let forcedState: RunState | null = null;
  let completedQuietly = false;
  let timeoutArmed = false;
  let rpcChild: RpcChild | null = null;
  let timeoutTimer: NodeJS.Timeout | null = null;
  let abortHandler: (() => void) | null = null;
  let wrapTimer: NodeJS.Timeout | null = null;
  let killTimer: NodeJS.Timeout | null = null;
  const recovering = !!existing && (!existsSync(existing.sessionFile) || statSync(existing.sessionFile).size === 0 || existing.state === "timeout" || existing.state === "killed");
  let args: string[];
  let mcpConfig: string | undefined;
  try {
    const built = buildArgs(agent, meta, cwd, inherited, recovering);
    args = built.args;
    mcpConfig = built.mcpConfig;
  } catch (error) {
    meta.state = "failed";
    meta.finishedAt = Date.now();
    meta.error = error instanceof Error ? error.message : String(error);
    writeFileSync(meta.resultPath, meta.error);
    writeMeta(meta);
    releaseSlot();
    return {
      content: [{ type: "text", text: meta.error }],
      details: { run: meta, activities, fullOutputPath: meta.resultPath },
    };
  }

  const emit = () => onUpdate?.({
    content: [{ type: "text", text: finalOutput || activities.at(-1)?.toolName || "(running...)" }],
    details: { run: { ...meta }, activities: [...activities] },
  });

  try {
    const exit = await new Promise<{ code: number | null; signal: string | null }>((resolve) => {
      const invocation = getPiInvocation(args);
      // the rpc child gets the task via a prompt request, not argv
      const prompt = args.pop() as string;
      const [prioCmd, ...prioArgs] = lowPrio([invocation.command, ...invocation.args]);
      rpcChild = startRpcChild(prioCmd, prioArgs, { cwd });
      liveRuns.set(meta.id, { child: rpcChild });
      meta.pid = rpcChild.pid;
      meta.pgid = rpcChild.pid;
      writeMeta(meta);
      emitLifecycle("subagent:started", { id: meta.id, agent: meta.agent, model: meta.model, state: meta.state });

      // Completion = agent idle (turn_end) with no steered turn starting within
      // the quiet window — a steer delivered between turns starts a new turn.
      let turnEndTimer: NodeJS.Timeout | null = null;
      const markTurnEnd = () => {
        if (turnEndTimer) return;
        turnEndTimer = setTimeout(() => resolveExit({ code: 0, signal: null, quiet: true }), STEER_QUIET_MS);
        turnEndTimer.unref?.();
      };
      const clearTurnEnd = () => {
        if (turnEndTimer) { clearTimeout(turnEndTimer); turnEndTimer = null; }
      };

      const processEvent = (event: Record<string, any>) => {
        if (event.type === "tool_execution_start") {
          activities.push({ toolName: String(event.toolName ?? "tool"), args: event.args ?? {} });
          emit();
        }
        if (event.type === "turn_start") clearTurnEnd();
        if (event.type === "turn_end") markTurnEnd();
        if (event.type === "message_end" && event.message?.role === "assistant") {
          applyUsage(meta.usage, event.message);
          const text = assistantText(event.message);
          if (text) finalOutput = text;
          if (!meta.model && event.message.model) meta.model = String(event.message.model);
          if (event.message.stopReason === "error" || event.message.stopReason === "aborted") {
            meta.error = event.message.errorMessage || `child stopped: ${event.message.stopReason}`;
          }
          writeMeta(meta);
          emit();
        }
      };
      rpcChild.onEvent((event) => {
        // transcript.jsonl keeps only the events we consume (activities,
        // usage, recovery, inspect). message_update floods are streamed
        // deltas and agent_end embeds the whole message array — keeping them
        // bloats the file and breaks tail-based readers.
        const keep = [
          "agent_start", "turn_start", "turn_end",
          "tool_execution_start", "tool_execution_end", "message_end",
        ].includes(event.type);
        if (keep) {
          try {
            appendFileSync(meta.transcriptPath, `${JSON.stringify(event)}\n`);
          } catch { /* transcript best-effort */ }
        }
        processEvent(event);
      });
      rpcChild.onStderr((text) => {
        stderr += text;
        if (stderr.length > STDERR_CAP_CHARS) stderr = stderr.slice(-STDERR_CAP_CHARS);
      });

      // send the task as an rpc prompt; acceptance resolves fast, events stream after
      rpcChild.request({ type: "prompt", message: prompt }, 30_000).catch((error: Error) => {
        rpcChild.kill("SIGTERM");
        stderr += `prompt rejected: ${error.message}`;
        resolve({ code: 1, signal: null });
      });

      // graceful wrap-up on timeout: steer → wait grace → abort → SIGTERM group
      const armTimeout = () => {
        if (forcedState) return;
        rpcChild.request({
          type: "steer",
          message: "Time is up: wrap up NOW. Stop exploring and return your best partial answer immediately.",
        }).catch(() => { /* child may be gone */ });
        wrapTimer = setTimeout(() => {
          if (forcedState) return;
          timeoutArmed = true;
          rpcChild.request({ type: "abort" }).catch(() => { /* fall through to kill */ });
          killTimer = setTimeout(() => {
            if (forcedState) return;
            forcedState = "timeout";
            killProcessGroup(meta);
          }, KILL_ESCALATE_MS);
          killTimer.unref?.();
        }, WRAPUP_MS);
        wrapTimer.unref?.();
      };

      const stop = (state: RunState) => {
        if (forcedState) return;
        forcedState = state;
        killProcessGroup(meta);
      };
      abortHandler = () => stop("killed");
      if (signal?.aborted) abortHandler();
      else signal?.addEventListener("abort", abortHandler, { once: true });
      if (meta.timeoutMin > 0) {
        timeoutTimer = setTimeout(armTimeout, meta.timeoutMin * 60_000);
        timeoutTimer.unref?.();
      }

      // resolve on transport exit; "quiet" turns it into a clean exit below
      let quietDone = false;
      function resolveExit(value: { code: number | null; signal: string | null; quiet?: boolean }) {
        if (value.quiet) completedQuietly = true;
        if (quietDone) return;
        quietDone = true;
        resolve(value);
      }
      rpcChild.exit.then((value) => resolveExit(value));
    });

    // quiet completion resolved the race early: close stdin and let the child
    // exit; escalate to SIGTERM if it lingers so runs never leave zombies
    if (rpcChild && !rpcChild.exited) {
      rpcChild.closeStdin();
      await Promise.race([rpcChild.exit, new Promise((resolve) => setTimeout(resolve, 1_500))]);
      if (!rpcChild.exited) rpcChild.kill("SIGTERM");
    }

    meta.exitCode = exit.code;
    meta.signal = exit.signal;
    meta.finishedAt = Date.now();
    const persistedState = readMeta(meta.id)?.state;
    const externallyStopped = persistedState === "killed" || persistedState === "timeout" ? persistedState : null;
    // wrap-up finished inside the grace window = done; exceeded (abort/kill) = timeout
    meta.state = forcedState ?? externallyStopped
      ?? (completedQuietly || (exit.code === 0 && !meta.error && !timeoutArmed) ? "done"
        : timeoutArmed && exit.code === 0 && !meta.error ? "timeout" : "failed");
    if (!meta.error && meta.state === "failed") meta.error = stderr.trim() || `child exited ${exit.code}`;
    const fullOutput = finalOutput || meta.error || stderr.trim() || "(no output)";
    writeFileSync(meta.resultPath, fullOutput);
    writeMeta(meta);
    emitLifecycle("subagent:finished", { id: meta.id, agent: meta.agent, state: meta.state });
    const visible = truncateOutput(fullOutput);
    const result = {
      content: [{ type: "text" as const, text: modelVisibleOutput(visible.text, meta) }],
      details: { run: meta, activities, fullOutputPath: meta.resultPath, truncated: visible.truncated },
      usage: {
        input: meta.usage.input,
        output: meta.usage.output,
        cacheRead: meta.usage.cacheRead,
        cacheWrite: meta.usage.cacheWrite,
        totalTokens: meta.usage.totalTokens,
        cost: {
          input: meta.usage.costInput,
          output: meta.usage.costOutput,
          cacheRead: meta.usage.costCacheRead,
          cacheWrite: meta.usage.costCacheWrite,
          total: meta.usage.cost,
        },
      },
    };
    return result;
  } finally {
    releaseSlot();
    if (timeoutTimer) clearTimeout(timeoutTimer);
    if (wrapTimer) clearTimeout(wrapTimer);
    if (killTimer) clearTimeout(killTimer);
    if (abortHandler) signal?.removeEventListener("abort", abortHandler);
    if (mcpConfig) rmSync(mcpConfig, { force: true });
    liveRuns.delete(meta.id);
    updateFleetWidget();
  }
}

function fmtDur(ms: number): string {
  const s = Math.max(0, Math.round(ms / 1000));
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m${String(s % 60).padStart(2, "0")}s`;
  return `${Math.floor(m / 60)}h${String(m % 60).padStart(2, "0")}m`;
}

function listText(): string {
  const runs = listMetas();
  if (!runs.length) return `no subagent runs (state: ${STATE_DIR})`;
  const now = Date.now();
  return runs.slice(0, 20).map((run) => {
    const end = run.finishedAt ?? now;
    const start = run.startedAt ?? run.createdAt;
    const tokens = run.usage.totalTokens || run.usage.input + run.usage.cacheRead + run.usage.output;
    const usage = `${run.usage.turns}t ${tokens}tok $${run.usage.cost.toFixed(4)}`;
    return `${run.id} · ${run.agent} · ${run.model ?? "inherit"} · ${run.state} · ${fmtDur(end - start)} · ${usage} · ${run.task.slice(0, 32)}`;
  }).join("\n");
}

type RunsIo = {
  list: () => RunMeta[];
  save: (meta: RunNoticeMeta) => void;
  read?: (id: string) => RunNoticeMeta | null;
  remove?: (id: string) => void;
};

function transcriptTimeline(meta: RunMeta, limit = 12): string[] {
  const entries: string[] = [];
  try {
    for (const line of readFileSync(meta.transcriptPath, "utf8").split("\n")) {
      if (!line.trim()) continue;
      try {
        const event = JSON.parse(line) as Record<string, any>;
        if (event.type === "tool_execution_start") {
          entries.push(`${entries.length + 1}. ${String(event.toolName ?? "tool")} ${JSON.stringify(event.args ?? {}).slice(0, 100)}`);
        }
      } catch { /* skip malformed */ }
    }
  } catch { /* transcript optional */ }
  if (entries.length > limit) {
    const hidden = entries.length - limit;
    return [...entries.slice(0, limit), `… +${hidden} more`];
  }
  return entries;
}

function messageText(message: Record<string, any> | undefined): string {
  if (!message || !Array.isArray(message.content)) return "";
  return message.content
    .filter((part) => part.type === "text" && typeof part.text === "string")
    .map((part) => part.text)
    .join(" ")
    .trim();
}

// speaker colors for chat rendering — the notify channel wraps the whole
// message in theme dim, so embedded SGR codes make labels pop and bodies fall
// back to normal weight. Honors NO_COLOR.
const CHAT_STYLE = process.env.NO_COLOR
  ? { user: "", agent: "", dim: "", reset: "" }
  : { user: "\x1b[1;36m", agent: "\x1b[1;35m", dim: "\x1b[2m", reset: "\x1b[0m" };

function chatTranscript(meta: RunMeta, perMessageCap = 500, totalCap = 4_000): string {
  const turns: string[] = [];
  try {
    for (const line of readFileSync(meta.transcriptPath, "utf8").split("\n")) {
      if (!line.trim()) continue;
      try {
        const event = JSON.parse(line) as Record<string, any>;
        if (event.type !== "message_end") continue;
        const role = event.message?.role;
        if (role !== "user" && role !== "assistant") continue;
        const text = messageText(event.message);
        if (!text) continue;
        const label = role === "user"
          ? `${CHAT_STYLE.user}you:${CHAT_STYLE.reset}`
          : `${CHAT_STYLE.agent}${meta.agent}:${CHAT_STYLE.reset}`;
        const body = text.length <= perMessageCap ? text : `${text.slice(0, perMessageCap)}…`;
        turns.push(`${label} ${body}`);
      } catch { /* skip malformed */ }
    }
  } catch { /* transcript optional */ }
  if (!turns.length) return "(no dialogue captured — run may predate rpc mode)";
  const separator = `\n\n${CHAT_STYLE.dim}──────${CHAT_STYLE.reset}\n\n`;
  let out = turns.join(separator);
  if (out.length > totalCap) out = `${out.slice(0, totalCap)}…\n${CHAT_STYLE.dim}(full history: ${meta.sessionFile})${CHAT_STYLE.reset}`;
  return out;
}

function inspectFinishedSummary(meta: RunMeta): string {
  const end = meta.finishedAt ?? Date.now();
  const duration = fmtDur(end - (meta.startedAt ?? meta.createdAt));
  const tokens = meta.usage.totalTokens || meta.usage.input + meta.usage.cacheRead + meta.usage.output;
  const usage = `${meta.usage.turns} turns · ${tokens} tok · $${meta.usage.cost.toFixed(4)}`;
  const timeline = transcriptTimeline(meta);
  const timelineBlock = timeline.length ? [`timeline:`, ...timeline.map((entry) => `  ${entry}`)] : ["timeline: (no tool calls)"];
  let result = "";
  try { result = readFileSync(meta.resultPath, "utf8").trim(); } catch { /* optional */ }
  return [
    `run ${meta.id} · ${meta.agent} · ${meta.state} · ${duration}`,
    `model: ${meta.model ?? "(child-reported)"}`,
    `usage: ${usage}`,
    `task: ${meta.task.slice(0, 120)}`,
    ...timelineBlock,
    `final result:`,
    result.slice(0, 1_600) || "(no output)",
    `transcript: ${meta.transcriptPath}`,
    `session: ${meta.sessionFile}`,
  ].join("\n");
}

// viewer constants — the chat viewer docks where the editor is, so it keeps
// a fixed body height and scrolls internally
const VIEWER_ROWS = 14;

// global viewer shortcut — registered via pi.registerShortcut so key parsing
// is pi's problem (works across terminals); armed from startup, not lazily.

function killRunNow(meta: RunMeta): void {
  writeMeta({ ...meta, state: "killed" });
  mergeMeta(meta.id, (current) => ({ ...current, state: "killed" }));
  if (meta.state === "running") killProcessGroup(meta);
}

class SubagentViewer {
  private meta: RunMeta;
  private tui: { requestRender: () => void };
  private done: () => void;
  private lines: string[] = [];
  private scrollTop = 0;
  private follow = true;
  private timer: NodeJS.Timeout | null = null;
  private inputMode: string | null = null;
  private killArmedAt = 0;
  private flash: string | null = null;
  private runsIo: RunsIo;
  private notifyNext = false; // viewer sends default quiet; n toggles

  constructor(meta: RunMeta, tui: { requestRender: () => void }, done: () => void, runsIo: RunsIo) {
    this.meta = meta;
    this.tui = tui;
    this.done = done;
    this.runsIo = runsIo;
    this.refresh();
    if (meta.state === "running" || meta.state === "queued") {
      this.timer = setInterval(() => {
        this.refresh();
        if (this.meta.state !== "running" && this.meta.state !== "queued") this.stopTimer();
        this.tui.requestRender();
      }, 1_000);
      this.timer.unref?.();
    }
  }

  private stopTimer(): void {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
  }

  dispose(): void {
    this.stopTimer();
  }

  private refresh(): void {
    const fresh = readMeta(this.meta.id);
    if (fresh) this.meta = fresh;
    this.lines = buildViewerBody(this.meta);
    const max = Math.max(0, this.lines.length - VIEWER_ROWS);
    if (this.follow) this.scrollTop = max;
    this.scrollTop = Math.min(this.scrollTop, max);
  }

  // pi hands focused components the raw input string ("q" is literally "q",
  // legacy arrows are "\x1b[A"…). Key identity must go through matchesKey():
  // under the Kitty keyboard protocol Escape arrives as a CSI-u sequence
  // ("\x1b[27u"), NOT a bare byte — raw "=== "\x1b"" matching missed it and
  // left the viewer stuck (q still worked, which is how the bug surfaced).
  handleInput = (raw: unknown): boolean => {
    const data = typeof raw === "string"
      ? raw
      : String((raw as { sequence?: string; name?: string } | undefined)?.sequence ?? (raw as { name?: string } | undefined)?.name ?? "");
    const max = Math.max(0, this.lines.length - VIEWER_ROWS);
    this.refresh(); // actions must see the run's current state, not a stale snapshot
    // composing a steering message captures printable input; esc cancels
    if (this.inputMode !== null) {
      if (matchesKey(data, Key.escape)) {
        this.inputMode = null;
      } else if (matchesKey(data, Key.enter) || data === "\r" || data === "\n") {
        const message = this.inputMode.trim();
        this.inputMode = null;
        if (message) {
          if (this.meta.state === "running" && liveRuns.has(this.meta.id)) {
            void steerRun(this.meta.id, message).then(() => this.tui.requestRender());
          } else if (this.meta.state === "running" || this.meta.state === "queued") {
            this.flash = "run is live in another process or session — open it there";
          } else {
          this.flash = "continue starting…";
          void continueRun(this.meta.id, message, undefined, undefined, undefined, this.runsIo, true, this.notifyNext)
            .then((outcome) => {
              this.flash = typeof outcome === "string" ? outcome.split("\n")[0] : null;
              this.tui.requestRender();
            })
            .catch((error: Error) => {
              this.flash = `continue failed: ${error.message}`;
              this.tui.requestRender();
            });
        }
        }
      } else if (matchesKey(data, Key.backspace) || data === "\x7f" || data === "\b") {
        this.inputMode = this.inputMode.slice(0, -1);
      } else if (data && !data.startsWith("\x1b")) {
        this.inputMode += data;
      }
      this.tui.requestRender();
      return true;
    }
    // esc (any protocol encoding) or q = leave the viewer
    if (matchesKey(data, Key.escape) || data === "\x1b" || data === "q") {
      this.stopTimer();
      this.done();
      return true;
    }
    if (matchesKey(data, Key.ctrl("c")) || data === "\x03") {
      // ctrl+c must never be swallowed by the viewer
      this.stopTimer();
      this.done();
      return true;
    }
    if (data === "n") {
      this.notifyNext = !this.notifyNext;
      this.flash = null;
      this.tui.requestRender();
      return true;
    }
    if (data === "s") {
      if (this.meta.state === "queued") {
        this.flash = "run is still queued — not yet steerable";
      } else {
        this.inputMode = "";
      }
      this.tui.requestRender();
      return true;
    }
    if (data === "D") {
      if (this.meta.state !== "running" && this.meta.state !== "queued") {
        this.flash = "run already finished";
      } else if (Date.now() - this.killArmedAt < 5_000) {
        this.killArmedAt = 0;
        this.flash = null;
        killRunNow(this.meta);
      } else {
        this.killArmedAt = Date.now();
        this.flash = "press D again to STOP this run";
      }
      this.tui.requestRender();
      return true;
    }
    if (data === "j" || matchesKey(data, Key.down)) {
      this.follow = false;
      this.scrollTop = Math.min(max, this.scrollTop + 1);
    } else if (data === "k" || matchesKey(data, Key.up)) {
      this.scrollTop = Math.max(0, this.scrollTop - 1);
    } else if (matchesKey(data, Key.pageDown) || data === "\x1b[6~" || data === " ") {
      this.scrollTop = Math.min(max, this.scrollTop + VIEWER_ROWS);
    } else if (matchesKey(data, Key.pageUp) || data === "\x1b[5~") {
      this.scrollTop = Math.max(0, this.scrollTop - VIEWER_ROWS);
    } else if (data === "g" || matchesKey(data, Key.home)) {
      this.follow = false;
      this.scrollTop = 0;
    } else if (data === "G" || matchesKey(data, Key.end) || data === "\x1b[F") {
      this.follow = true;
      this.scrollTop = max;
    } else {
      return false; // unhandled — let pi's default handling see it
    }
    this.tui.requestRender();
    return true;
  };

  render(width: number): string[] {
    this.refresh();
    const max = Math.max(0, this.lines.length - VIEWER_ROWS);
    if (this.follow) this.scrollTop = max;
    this.scrollTop = Math.min(this.scrollTop, max);
    const live = this.meta.state === "running" || this.meta.state === "queued" ? " · \x1b[1;33mLIVE\x1b[0m" : "";
    const header = `\x1b[1msubagent viewer\x1b[0m ${this.meta.id} · ${this.meta.agent} · ${this.meta.model ?? "inherit"} · ${this.meta.state}${live}`;
    const visible = this.lines.slice(this.scrollTop, this.scrollTop + VIEWER_ROWS);
    const padded = [...visible];
    while (padded.length < VIEWER_ROWS) padded.push("");
    const notifyTag = this.notifyNext ? "\x1b[1;33mnotify:on\x1b[0m" : "\x1b[2mnotify:off\x1b[0m";
    const footer = this.inputMode !== null
      ? `\x1b[1;36msteer:\x1b[0m ${this.inputMode}\x1b[2m▏ · enter send · esc cancel\x1b[0m`
      : this.flash
        ? `\x1b[1;33m${this.flash}\x1b[0m`
        : `\x1b[2m↑↓/jk scroll · g/G ends · s talk · D stop · n ${notifyTag} · esc back\x1b[0m`;
    return [header, ...padded, footer].map((line) => truncateToWidth(line, width));
  }
}

function buildViewerBody(meta: RunMeta): string[] {
  const lines: string[] = [];
  try {
    for (const line of readFileSync(meta.transcriptPath, "utf8").split("\n")) {
      if (!line.trim()) continue;
      let event: Record<string, any>;
      try {
        event = JSON.parse(line);
      } catch {
        continue;
      }
      if (event.type === "tool_execution_start") {
        lines.push(`${CHAT_STYLE.dim}  · ${String(event.toolName ?? "tool")} ${JSON.stringify(event.args ?? {}).slice(0, 90)}${CHAT_STYLE.reset}`);
      } else if (event.type === "message_end") {
        const role = event.message?.role;
        if (role !== "user" && role !== "assistant") continue;
        const text = messageText(event.message);
        if (!text) continue;
        const label = role === "user"
          ? `${CHAT_STYLE.user}you:${CHAT_STYLE.reset}`
          : `${CHAT_STYLE.agent}${meta.agent}:${CHAT_STYLE.reset}`;
        const textLines = text.split("\n");
        textLines.forEach((chunk, index) => lines.push(index === 0 ? `${label} ${chunk}` : `  ${chunk}`));
      }
    }
  } catch { /* transcript optional */ }
  if (!lines.length) lines.push("(no dialogue captured)");
  return lines;
}

let shortcutArmed = false;

async function openChatViewer(ctx: ToolCtx, id?: string, runsIo?: RunsIo): Promise<void> {
  let targetId = id;
  if (!targetId) {
    const sessionFile = ctx?.sessionManager?.getSessionFile?.();
    const metas = listMetas();
    const owned = sessionFile ? metas.filter((run) => run.ownerSession === sessionFile) : [];
    const pool = (owned.length ? owned : metas).slice(0, 20);
    if (!pool.length) {
      ctx.ui?.notify?.("no subagent runs yet", "warning");
      return;
    }
    const labels = pool.map((run) => `${run.id} · ${run.agent} · ${run.state} · ${run.task.slice(0, 44)}`);
    const picked = await ctx.ui?.select?.("Subagent runs — pick one to view:", labels);
    const chosen = pool[labels.indexOf(picked ?? "")];
    if (!chosen) return;
    targetId = chosen.id;
  }
  const target = readMeta(targetId);
  if (!target) {
    ctx.ui?.notify?.(`run '${targetId}' not found`, "warning");
    return;
  }
  await ctx.ui?.custom?.((tui, _theme, _keybindings, done) =>
    new SubagentViewer(target, tui as { requestRender: () => void }, done as () => void, runsIo));
}

// arm ctrl+alt+s once: opens the chat viewer picker even while a turn runs
function armViewerShortcut(pi: ExtensionAPI): void {
  if (shortcutArmed) return;
  shortcutArmed = true;
  try {
    pi.registerShortcut?.("ctrl+alt+s", {
      description: "Open subagent chat viewer",
      handler: async (ctx: ToolCtx) => {
        await openChatViewer(ctx);
      },
    });
  } catch { /* shortcuts must never break startup */ }
}

function enabledFallbackList(): string[] {
  const names = loadAgentsFromDir(path.join(AGENT_DIR, "agents"), "user").map((agent) => agent.name);
  return names.sort((a, b) => a.localeCompare(b));
}

function collectDoctorReport(cwd: string, ctx: ToolCtx | undefined): string[] {
  const lines: string[] = ["subagents doctor"];
  const invocation = getPiInvocation(["--mode", "rpc"]);
  lines.push(`${invocation.command === "pi" || existsSync(invocation.command) ? "OK" : "WARN"} pi invocation: ${invocation.command} ${invocation.args.join(" ")}`.trim());
  try {
    const probe = path.join(STATE_DIR, `.doctor-${process.pid}`);
    mkdirSync(STATE_DIR, { recursive: true });
    writeFileSync(probe, "ok");
    rmSync(probe, { force: true });
    lines.push(`OK state dir writable: ${STATE_DIR}`);
  } catch (error) {
    lines.push(`FAIL state dir not writable: ${STATE_DIR} (${(error as Error).message})`);
  }
  const userAgents = loadAgentsFromDir(path.join(AGENT_DIR, "agents"), "user");
  const projectDir = nearestProjectAgentsDir(cwd);
  const projectAgents = projectDir && projectAgentsAllowed(cwd, ctx) ? loadAgentsFromDir(projectDir, "project") : [];
  lines.push(`OK agents parsed: ${userAgents.length} user${projectAgents.length ? ` + ${projectAgents.length} project (${projectDir})` : ""}`);
  const byName = new Map<string, number>();
  for (const agent of [...userAgents, ...projectAgents]) byName.set(agent.name, (byName.get(agent.name) ?? 0) + 1);
  const duplicates = [...byName.entries()].filter(([, count]) => count > 1);
  if (duplicates.length) lines.push(`WARN duplicate agent names (project overrides user): ${duplicates.map(([name]) => name).join(", ")}`);
  const agents = [...userAgents, ...projectAgents];
  for (const agent of agents) {
    for (const extension of agent.extensions) {
      try {
        resolveBundleExtension(extension);
      } catch (error) {
        lines.push(`FAIL agent '${agent.name}' extension: ${(error as Error).message}`);
      }
    }
    for (const skill of agent.skills) {
      try {
        findSkill(skill, cwd);
      } catch (error) {
        lines.push(`FAIL agent '${agent.name}' skill: ${(error as Error).message}`);
      }
    }
    if (agent.mcp.length) {
      const src = mcpConfigSource();
      if (src.legacy && !lines.some((line) => line.includes("deprecated"))) {
        lines.push(`WARN ${LEGACY_MCP_CONFIG_FILE} deprecated: rename it to ${MCP_CONFIG_FILE}`);
      }
      try {
        const source = JSON.parse(readFileSync(src.path, "utf8")) as { mcpServers?: Record<string, unknown> };
        const missing = agent.mcp.filter((name) => !(name in (source.mcpServers ?? {})));
        if (missing.length) lines.push(`FAIL agent '${agent.name}' mcp servers not in ${MCP_CONFIG_FILE}: ${missing.join(", ")}`);
      } catch (error) {
        lines.push(`FAIL agent '${agent.name}' ${MCP_CONFIG_FILE} unreadable: ${(error as Error).message}`);
      }
    }
  }
  if (!lines.some((line) => line.startsWith("FAIL"))) lines.push("OK no problems found");
  return lines;
}

export default function subagentExtension(pi: ExtensionAPI): void {
  mkdirSync(STATE_DIR, { recursive: true });
  captureExtensionApi(pi);
  armViewerShortcut(pi);
  emitLifecycle = (event, data) => {
    try {
      (pi as { events?: { emit?: (name: string, payload: unknown) => void } }).events?.emit?.(event, data);
    } catch { /* events bus must never break runs */ }
  };

  const runsIo: RunsIo = {
    list: () => listMetas(),
    read: (id) => readMeta(id),
    remove: (id) => rmSync(runDir(id), { recursive: true, force: true }),
    save: (meta) => {
      writeMeta(meta as RunMeta);
      // orphan finalize leaves a result file so post-mortems never 404
      if (meta.state === "failed" && meta.error?.startsWith("host exited") && !existsSync(meta.resultPath)) {
        writeFileSync(meta.resultPath, meta.error);
      }
    },
  };
  const housekeep = () => {
    try {
      finalizeOrphans(runsIo);
      pruneRuns(runsIo);
    } catch {
      // housekeeping must never crash the host
    }
  };
  housekeep();
  const housekeeper = setInterval(housekeep, 3_600_000);
  housekeeper.unref?.();
  const fleetTicker = setInterval(updateFleetWidget, 2_000);
  fleetTicker.unref?.();

  // @mention autocomplete: typing "@sc" offers discovered agents; the mention
  // itself is plain text — the model reads it and delegates via the tool.
  pi.on("session_start" as never, (_event: unknown, ctx: unknown) => {
    try {
      const ui = (ctx as { ui?: { addAutocompleteProvider?: (provider: unknown) => void } } | undefined)?.ui;
      if (!ui?.addAutocompleteProvider) return;
      const cwd = (ctx as { cwd?: string; sessionManager?: { getSessionFile?: () => string } } | undefined)?.cwd;
      ui.addAutocompleteProvider(((current: {
        getSuggestions: (lines: string[], line: number, col: number, options: unknown) => Promise<{ prefix: string; items: Array<{ value: string; label: string }> }>;
        applyCompletion: (lines: string[], line: number, col: number, item: { value: string }, prefix: string) => void;
        shouldTriggerFileCompletion?: (lines: string[], line: number, col: number) => boolean;
      }) => ({
        triggerCharacters: ["#"],
        async getSuggestions(lines: string[], line: number, col: number, options: unknown) {
          const before = (lines[line] ?? "").slice(0, col);
          const match = before.match(/(?:^|[ \t])#([a-zA-Z0-9_-]*)$/);
          if (!match) return current.getSuggestions(lines, line, col, options);
          const token = match[1].toLowerCase();
          const agents = enabledAgents(discoverAgents(cwd || process.cwd(), false)).filter((agent) => agent.name.toLowerCase().startsWith(token));
          return {
            prefix: `#${match[1]}`,
            items: agents.map((agent) => ({ value: `#${agent.name}`, label: `${agent.name} — ${agent.description}` })),
          };
        },
        applyCompletion(lines: string[], line: number, col: number, item: { value: string }, prefix: string) {
          return current.applyCompletion(lines, line, col, item, prefix);
        },
        shouldTriggerFileCompletion(lines: string[], line: number, col: number) {
          return current.shouldTriggerFileCompletion?.(lines, line, col) ?? true;
        },
      })) as never);
    } catch { /* autocomplete must never break startup */ }
  });

  const onActivity = (_event: unknown, eventCtx: unknown) => {
    try {
      trackSession(eventCtx);
      const eventUi = (eventCtx as { ui?: { setWidget?: (key: string, lines?: string[], opts?: unknown) => void } } | undefined)?.ui;
      if (eventUi?.setWidget) fleetSetWidget = (key, lines) => eventUi.setWidget(key, lines, { placement: "belowEditor" });
      updateFleetWidget();
      housekeep();
      sweepFinishedRuns(runsIo);
    } catch {
      // never crash the host
    }
  };
  for (const event of ["session_start", "session_info_changed", "input", "tool_call"] as const) {
    pi.on(event as never, (e: never, c: never) => onActivity(e, c));
  }
  pi.on("context" as never, (event: unknown, eventCtx: unknown) =>
    pumpContext(runsIo, event as { messages?: Array<Record<string, unknown>> }, eventCtx));

  const initialAgents = enabledAgents(discoverAgents(pi.cwd || process.cwd(), false));
  const catalog = initialAgents.slice(0, 8).map((agent) => `${agent.name}: ${agent.description}`).join("; ") || "none configured";

  pi.registerTool({
    name: "subagent",
    label: "Subagent",
    description: [
      "Delegate one task to an isolated specialist child. Blocking by default; pass run_in_background: true to return immediately and be notified on completion.",
      "For parallel work, emit every independent subagent call as sibling tool calls in the SAME assistant response; pi executes those calls concurrently.",
      "Do not call one subagent and wait before issuing another independent call. Wait only when the later task depends on an earlier result.",
      "Users may mention agents as #name in their message (e.g. '#scout find the auth flow') — treat that as a request to delegate that task to that agent via this tool. @path mentions are file attachments, not agent references.",
      `Available user agents: ${catalog}.`,
    ].join(" "),
    parameters: Type.Object({
      agent: Type.Optional(Type.String({ description: "Agent name for a new run" })),
      continue: Type.Optional(Type.String({ description: "Run id to continue instead of starting fresh" })),
      task: Type.String({ description: "Task or follow-up instruction" }),
      run_in_background: Type.Optional(Type.Boolean({ description: "Return immediately and notify this session when the run finishes" })),
      model: Type.Optional(Type.String({ description: "Per-call provider/model override" })),
      cwd: Type.Optional(Type.String({ description: "Working directory override" })),
    }),
    async execute(...cbArgs: unknown[]) {
      const params = extractToolArgs(cbArgs);
      const missingTask = requireString(params, "task");
      if (missingTask) return textResult(missingTask.errorText);
      const modern = typeof cbArgs[0] === "string";
      const signal = modern ? cbArgs[2] as AbortSignal | undefined : undefined;
      const onUpdate = modern ? cbArgs[3] as OnUpdate | undefined : undefined;
      const ctx = (modern ? cbArgs[4] : undefined) as ToolCtx | undefined;
      const wantsBg = params.run_in_background === true;
      if (typeof params.continue === "string" && params.continue.trim()) {
        const outcome = await continueRun(params.continue.trim(), String(params.task).trim(), ctx, signal, onUpdate, runsIo, wantsBg);
        return typeof outcome === "string" ? textResult(outcome) : outcome;
      }
      const missingAgent = requireString(params, "agent");
      if (missingAgent) return textResult(missingAgent.errorText);
      const cwd = typeof params.cwd === "string" && params.cwd.trim() ? path.resolve(params.cwd) : ctx?.cwd || pi.cwd || process.cwd();
      const agents = discoverAgents(cwd, projectAgentsAllowed(cwd, ctx));
      let agent = agents.find((candidate) => candidate.name === String(params.agent).trim());
      if (agent && !agent.enabled) {
        return textResult(`error: agent '${agent.name}' is disabled — /subagents agents on ${agent.name} to enable`);
      }
      if (!agent) {
        // Fallback deferred from P1: untrusted-but-promptable sessions may opt
        // in to project agents for this single run via an explicit confirm.
        const projectDir = nearestProjectAgentsDir(cwd);
        const sameAsSession = path.resolve(cwd) === path.resolve(ctx?.cwd || cwd);
        if (projectDir && sameAsSession && !ctx?.isProjectTrusted?.() && ctx?.hasUI) {
          const approved = await ctx.ui?.confirm?.("Untrusted project agents", `Load project agents from ${projectDir} for this run?`);
          if (approved) agent = discoverAgents(cwd, true).find((candidate) => candidate.name === String(params.agent).trim());
        }
      }
      if (!agent) return textResult(`error: unknown agent '${params.agent}'. Available: ${agents.map((candidate) => candidate.name).join(", ") || "none"}`);
      const parentModel = ctx?.model?.provider && ctx.model.id ? `${ctx.model.provider}/${ctx.model.id}` : undefined;
      const inheritedModel = typeof params.model === "string" && params.model.trim()
        ? params.model.trim()
        : agent.model ?? parentModel;
      const ownerSession = ctx?.sessionManager?.getSessionFile?.();
      if (wantsBg) {
        // No call signal: background runs outlive this tool call and are
        // stopped via /subagents kill, not by parent-turn aborts.
        let started: RunMeta | undefined;
        const running = runAgent(agent, String(params.task).trim(), cwd, { model: inheritedModel, thinking: ctx?.thinkingLevel }, ownerSession, undefined, undefined, undefined, { notifyOnDone: true }, (meta) => { started = meta; });
        const id = started?.id;
        if (!id) return textResult("error: background run failed to initialize");
        launchBackground(running, id, runsIo);
        return textResult(bgStartText(id, agent.name, inheritedModel));
      }
      return runAgent(
        agent,
        String(params.task).trim(),
        cwd,
        { model: inheritedModel, thinking: ctx?.thinkingLevel },
        ownerSession,
        signal,
        onUpdate,
      ).then((result) => {
        markInlineDelivered((result.details as RunDetails).run.id);
        return result;
      });
    },
    renderCall(args: Record<string, unknown>, theme: any) {
      const name = typeof args.continue === "string" ? `continue ${args.continue}` : String(args.agent ?? "...");
      const task = String(args.task ?? "...");
      return new Text(`${theme.fg("toolTitle", theme.bold("subagent "))}${theme.fg("accent", name)}\n  ${theme.fg("dim", task.slice(0, 100))}`, 0, 0);
    },
    renderResult(result: any, options: { expanded?: boolean }, theme: any) {
      const details = result.details as RunDetails | undefined;
      if (!details?.run) return new Text(result.content?.[0]?.text ?? "(no output)", 0, 0);
      const run = details.run;
      const icon = run.state === "done" ? theme.fg("success", "✓") : theme.fg("error", "✗");
      const usage = `${run.model ?? "inherit"} · ${run.usage.input + run.usage.cacheRead} in · ${run.usage.output} out · $${run.usage.cost.toFixed(4)}`;
      const output = result.content?.[0]?.text ?? "(no output)";
      const body = options.expanded ? output : output.split("\n").slice(-8).join("\n");
      // OSC 8: terminals that support it make the run id clickable — it opens
      // the full result.md in the OS editor handler (click-to-inspect)
      const idText = run.resultPath ? hyperlink(run.id, `file://${run.resultPath}`) : run.id;
      const inspectHint = theme.fg("dim", `/subagents inspect ${run.id}`);
      const extra = options.expanded
        ? `\n${theme.fg("dim", `${details.activities.length} tool call(s) · full result: ${run.resultPath} · ${inspectHint}`)}`
        : `\n${theme.fg("dim", inspectHint)}`;
      return new Text(`${icon} ${theme.fg("toolTitle", theme.bold(run.agent))} ${theme.fg("muted", idText)}\n${theme.fg("toolOutput", body)}\n${theme.fg("dim", usage)}${extra}`, 0, 0);
    },
  });

  pi.registerCommand("subagents", {
    description: "Subagent runs: list, continue, or kill",
    getArgumentCompletions: (prefix: string) => {
      const normalized = prefix.trimStart();
      if (!normalized.includes(" ")) {
          const commands = ["list", "agents", "cont", "kill", "steer", "inspect", "chat", "doctor"]
          .filter((value) => value.startsWith(normalized))
          .map((value) => ({ value, label: `${value} — ${{ list: "List runs", agents: "Browse agents + on/off", cont: "Continue a finished run", kill: "Stop a run", steer: "Redirect a running run", inspect: "View a run report", chat: "Open a run's chat viewer", doctor: "Check environment health" }[value]}` }));
        return commands.length ? commands : null;
      }
      const agentsSub = normalized.match(/^agents\s+(off|on)?\s*(\S*)$/);
      if (agentsSub && normalized.startsWith("agents")) {
        const [, action, namePrefix] = agentsSub;
        const names = enabledFallbackList();
        if (!action) {
          return [
            { value: "agents full", label: "full — detailed roster into chat" },
            ...names.slice(0, 7).map((name) => ({ value: `agents ${name}`, label: `${name} — enable/disable for this session` })),
          ];
        }
        return names
          .filter((name) => name.startsWith(namePrefix))
          .slice(0, 8)
          .map((name) => ({ value: `agents ${action} ${name}`, label: `${action} ${name}` }));
      }
      const match = normalized.match(/^(cont|kill|steer)\s+(\S*)$/);
      if (!match) return null;
      const [, action, idPrefix] = match;
      const eligible = listMetas()
        .filter((run) => action === "cont"
          ? run.state !== "running" && run.state !== "queued"
          : action === "kill"
            ? run.state === "running" || run.state === "queued"
            : run.state === "running")
        .filter((run) => run.id.startsWith(idPrefix) || run.agent.toLowerCase().includes(idPrefix.toLowerCase()))
        .slice(0, 8)
        .map((run) => ({ value: `${action} ${run.id}`, label: `${run.agent} · ${run.id} · ${run.state} · ${run.task.slice(0, 40)}` }));
      return eligible.length ? eligible : null;
    },
    handler: async (args: string, ctx: ToolCtx) => {
      const input = args.trim() || "list";
      if (input === "list") {
        ctx.ui?.notify?.(listText(), "info");
        return;
      }
      const kill = input.match(/^kill\s+(\S+)$/);
      if (kill) {
        const id = kill[1];
        const meta = readMeta(id);
        if (!meta) {
          ctx.ui?.notify?.(`run '${id}' not found`, "warning");
          return;
        }
        if (meta.state !== "running" && meta.state !== "queued") {
          ctx.ui?.notify?.(`run '${id}' is not active (${meta.state})`, "warning");
          return;
        }
        writeMeta({ ...meta, state: "killed" });
        mergeMeta(id, (current) => ({ ...current, state: "killed" }));
        if (meta.state === "running") killProcessGroup(meta);
        ctx.ui?.notify?.(
          meta.state === "queued" ? `cancelled queued subagent '${meta.agent}' (${id})` : `SIGTERM sent to subagent '${meta.agent}' (${id})`,
          "info",
        );
        return;
      }
      const steer = input.match(/^steer\s+(\S+)\s+([\s\S]+)$/);
      if (steer) {
        const [, id, message] = steer;
        const outcome = await steerRun(id, message.trim());
        ctx.ui?.notify?.(outcome, outcome.startsWith("error") ? "warning" : "info");
        return;
      }
      const inspect = input.match(/^inspect\s+(\S+)$/);
      if (inspect) {
        const [, id] = inspect;
        const live = liveRuns.get(id);
        if (live) {
          try {
            const response = await live.child.request({ type: "get_messages" });
            const messages = (response?.data?.messages ?? []) as Array<{ role?: string; content?: Array<{ type?: string; text?: string }> }>;
            const lastAssistant = [...messages].reverse().find((message) => message.role === "assistant");
            const text = lastAssistant?.content?.filter((part) => part.type === "text").map((part) => part.text).join(" ") ?? "(no assistant text yet)";
            ctx.ui?.notify?.(`live run ${id}: ${messages.length} message(s) so far\nLast assistant text:\n${text.slice(0, 800)}`, "info");
          } catch (error) {
            ctx.ui?.notify?.(`inspect failed for '${id}': ${(error as Error).message}`, "warning");
          }
          return;
        }
        const meta = readMeta(id);
        if (!meta) {
          ctx.ui?.notify?.(`run '${id}' not found`, "warning");
          return;
        }
        ctx.ui?.notify?.(inspectFinishedSummary(meta), "info");
        return;
      }
      const rosterMatch = input.match(/^agents(?:\s+(full|off|on)(?:\s+(\S+))?)?$/);
      if (rosterMatch) {
        const [, action, name] = rosterMatch;
        const agents = discoverAgents(ctx?.cwd || pi.cwd || process.cwd(), projectAgentsAllowed(ctx?.cwd || pi.cwd || process.cwd(), ctx));
        if (action === "full") {
          const lines = agents.map((agent) => {
            const state = agent.enabled ? "on" : sessionDisabled.has(agent.name) ? "off (session)" : "off (frontmatter)";
            const tools = agent.tools ? `${agent.tools.length} tools` : "all tools";
            return `${agent.enabled ? "✓" : "✗"} ${agent.name} · ${agent.model ?? "inherit"} · ${tools} · ${agent.timeoutMin}min · ${state}\n    ${agent.description}`;
          });
          const report = [`subagent agents (${agents.length}):`, ...lines, "toggle: /subagents agents off|on <name> (session only)"].join("\n");
          const sent = sendToSession({ customType: "subagent-agents", display: true, content: report, details: {} }, { deliverAs: "followUp", triggerTurn: false }, ctx?.sessionManager?.getSessionFile?.());
          if (!sent.ok) ctx.ui?.notify?.(report, "info");
          return;
        }
        if (!action) {
          const marks = agents.map((agent) => `${agent.enabled ? "✓" : "✗"}${agent.name}`).join(" ");
          const off = agents.filter((agent) => !agent.enabled).map((agent) => agent.name);
          ctx.ui?.notify?.(`subagents (${agents.length}): ${marks} · off: ${off.length ? off.join(", ") : "none"} · toggle: agents off|on <name>`, "info");
          return;
        }
        const target = agents.find((agent) => agent.name === name);
        if (!target) {
          ctx.ui?.notify?.(`agent '${name}' not found`, "warning");
          return;
        }
        if (action === "off") {
          sessionDisabled.add(name);
          ctx.ui?.notify?.(`agent '${name}' disabled for this session (resets on reload)`, "info");
        } else {
          if (target.enabled && !sessionDisabled.has(name)) {
            ctx.ui?.notify?.(`agent '${name}' is already enabled (frontmatter)`, "info");
            return;
          }
          if (!target.enabled && !sessionDisabled.has(name)) {
            ctx.ui?.notify?.(`agent '${name}' is disabled in frontmatter (enabled: false) — edit the .md to enable`, "warning");
            return;
          }
          sessionDisabled.delete(name);
          ctx.ui?.notify?.(`agent '${name}' enabled for this session`, "info");
        }
        return;
      }
      const chat = input.match(/^chat(?:\s+(\S+))?$/);
      if (chat) {
          if (ctx.hasUI && ctx.ui?.custom) {
          await openChatViewer(ctx, chat[1], runsIo);
          return;
        }
        const meta = chat[1] ? readMeta(chat[1]) : null;
        if (!meta) {
          ctx.ui?.notify?.(chat[1] ? `run '${chat[1]}' not found` : "no run id given (and no TUI available)", "warning");
          return;
        }
        ctx.ui?.notify?.(`chat of ${chat[1]} · ${meta.agent}\n\n${chatTranscript(meta)}`, "info");
        return;
      }
      if (input === "doctor") {
        ctx.ui?.notify?.(collectDoctorReport(ctx?.cwd || pi.cwd || process.cwd(), ctx).join("\n"), "info");
        return;
      }
      const cont = input.match(/^cont\s+(\S+)\s+([\s\S]+)$/);
      if (cont) {
        const [, id, task] = cont;
        const result = await continueRun(id, task.trim(), ctx, undefined);
        if (typeof result === "string") ctx.ui?.notify?.(result, "warning");
        else ctx.ui?.notify?.(result.content[0].text, result.details.run.state === "done" ? "info" : "error");
        return;
      }
      ctx.ui?.notify?.(`usage: /subagents list | cont <id> <message> | kill <id> | steer <id> <message> | inspect <id> | doctor`, "warning");
    },
  });
}
