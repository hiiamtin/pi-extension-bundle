// pi extension: delegate work to isolated subprocess agents.
//
// P1 uses `pi --mode json -p` with a persistent session file. Children are
// clean-room by default; agent frontmatter opts specific tools, extensions,
// skills, and MCP servers back in. See docs/subagent.md.

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Text } from "@earendil-works/pi-tui";
import { Type } from "typebox";
import { parse as parseYaml } from "yaml";
import { spawn, type ChildProcess } from "node:child_process";
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
  ui?: { notify?: (message: string, level: string) => void };
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
      agents.push({
        name: frontmatter.name.trim(),
        description: frontmatter.description.trim(),
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

function discoverAgents(cwd: string, projectTrusted: boolean): AgentConfig[] {
  const byName = new Map<string, AgentConfig>();
  for (const agent of loadAgentsFromDir(path.join(AGENT_DIR, "agents"), "user")) byName.set(agent.name, agent);
  const projectDir = nearestProjectAgentsDir(cwd);
  if (projectTrusted && projectDir) {
    for (const agent of loadAgentsFromDir(projectDir, "project")) byName.set(agent.name, agent);
  }
  return [...byName.values()].sort((a, b) => a.name.localeCompare(b.name));
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

function prepareMcp(agent: AgentConfig, dir: string): { adapter: string; config: string } | null {
  if (!agent.mcp.length) return null;
  const source = path.join(AGENT_DIR, "mcp.json");
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
  const args = ["--mode", "json", "-p", "--session", meta.sessionFile, ...CLEAN_ROOM_FLAGS];
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
): Promise<RunResult | string> {
  const existing = readMeta(id);
  if (!existing) return `error: run '${id}' not found — use /subagents list`;
  if (existing.state === "running" || existing.state === "queued") return `error: run '${id}' is still ${existing.state}`;
  const cwd = existing.cwd || ctx?.cwd || process.cwd();
  const agent = discoverAgents(cwd, projectAgentsAllowed(cwd, ctx)).find((candidate) => candidate.name === existing.agent);
  if (!agent) return `error: agent '${existing.agent}' for run '${id}' is no longer available`;
  return runAgent(
    agent,
    task,
    cwd,
    { model: existing.model, thinking: ctx?.thinkingLevel },
    existing.ownerSession,
    signal,
    onUpdate,
    existing,
  );
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
  let child: ChildProcess | null = null;
  let timeoutTimer: NodeJS.Timeout | null = null;
  let abortHandler: (() => void) | null = null;
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
      child = spawn("nice", ["-n", "15", "ionice", "-c3", invocation.command, ...invocation.args], {
        cwd,
        detached: true,
        shell: false,
        stdio: ["ignore", "pipe", "pipe"],
      });
      meta.pid = child.pid ?? 0;
      meta.pgid = child.pid ?? 0;
      writeMeta(meta);

      let buffer = "";
      const processLine = (line: string) => {
        if (!line.trim()) return;
        let event: Record<string, any>;
        try { event = JSON.parse(line); } catch { return; }
        if (event.type === "tool_execution_start") {
          activities.push({ toolName: String(event.toolName ?? "tool"), args: event.args ?? {} });
          emit();
        }
        if (event.type === "turn_start") {
          // turn count is derived from assistant message_end events in applyUsage
        }
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
      child.stdout?.on("data", (chunk: Buffer) => {
        appendFileSync(meta.transcriptPath, chunk);
        buffer += chunk.toString("utf8");
        const lines = buffer.split("\n");
        buffer = lines.pop() ?? "";
        for (const line of lines) processLine(line);
      });
      child.stderr?.on("data", (chunk: Buffer) => {
        stderr += chunk.toString("utf8");
        if (stderr.length > STDERR_CAP_CHARS) stderr = stderr.slice(-STDERR_CAP_CHARS);
      });
      child.on("close", (code, childSignal) => {
        if (buffer.trim()) processLine(buffer);
        resolve({ code, signal: childSignal });
      });
      child.on("error", (error) => {
        stderr += error.message;
        resolve({ code: 1, signal: null });
      });

      const stop = (state: RunState) => {
        if (forcedState) return;
        forcedState = state;
        killProcessGroup(meta);
      };
      abortHandler = () => stop("killed");
      if (signal?.aborted) abortHandler();
      else signal?.addEventListener("abort", abortHandler, { once: true });
      if (meta.timeoutMin > 0) {
        timeoutTimer = setTimeout(() => stop("timeout"), meta.timeoutMin * 60_000);
        timeoutTimer.unref?.();
      }
    });

    meta.exitCode = exit.code;
    meta.signal = exit.signal;
    meta.finishedAt = Date.now();
    const persistedState = readMeta(meta.id)?.state;
    const externallyStopped = persistedState === "killed" || persistedState === "timeout" ? persistedState : null;
    meta.state = forcedState ?? externallyStopped ?? (exit.code === 0 && !meta.error ? "done" : "failed");
    if (!meta.error && meta.state === "failed") meta.error = stderr.trim() || `child exited ${exit.code}`;
    const fullOutput = finalOutput || meta.error || stderr.trim() || "(no output)";
    writeFileSync(meta.resultPath, fullOutput);
    writeMeta(meta);
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
    if (abortHandler) signal?.removeEventListener("abort", abortHandler);
    if (mcpConfig) rmSync(mcpConfig, { force: true });
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
    return `${run.id} · ${run.agent} · ${run.state} · ${fmtDur(end - start)} · ${usage} · ${run.task.slice(0, 40)}`;
  }).join("\n");
}

export default function subagentExtension(pi: ExtensionAPI): void {
  mkdirSync(STATE_DIR, { recursive: true });
  const initialAgents = discoverAgents(pi.cwd || process.cwd(), false);
  const catalog = initialAgents.slice(0, 8).map((agent) => `${agent.name}: ${agent.description}`).join("; ") || "none configured";

  pi.registerTool({
    name: "subagent",
    label: "Subagent",
    description: `Delegate one task to an isolated specialist child. Blocking by default; sibling calls run in parallel. Available user agents: ${catalog}.`,
    parameters: Type.Object({
      agent: Type.Optional(Type.String({ description: "Agent name for a new run" })),
      continue: Type.Optional(Type.String({ description: "Run id to continue instead of starting fresh" })),
      task: Type.String({ description: "Task or follow-up instruction" }),
      run_in_background: Type.Optional(Type.Boolean({ description: "Return immediately and notify on completion (P2)" })),
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
      if (params.run_in_background === true) return textResult("background subagents arrive in P2; omit run_in_background for P1");
      if (typeof params.continue === "string" && params.continue.trim()) {
        const outcome = await continueRun(params.continue.trim(), String(params.task).trim(), ctx, signal, onUpdate);
        return typeof outcome === "string" ? textResult(outcome) : outcome;
      }
      const missingAgent = requireString(params, "agent");
      if (missingAgent) return textResult(missingAgent.errorText);
      const cwd = typeof params.cwd === "string" && params.cwd.trim() ? path.resolve(params.cwd) : ctx?.cwd || pi.cwd || process.cwd();
      const agents = discoverAgents(cwd, projectAgentsAllowed(cwd, ctx));
      const agent = agents.find((candidate) => candidate.name === String(params.agent).trim());
      if (!agent) return textResult(`error: unknown agent '${params.agent}'. Available: ${agents.map((candidate) => candidate.name).join(", ") || "none"}`);
      const parentModel = ctx?.model?.provider && ctx.model.id ? `${ctx.model.provider}/${ctx.model.id}` : undefined;
      const inheritedModel = typeof params.model === "string" && params.model.trim()
        ? params.model.trim()
        : agent.model ?? parentModel;
      const ownerSession = ctx?.sessionManager?.getSessionFile?.();
      return runAgent(
        agent,
        String(params.task).trim(),
        cwd,
        { model: inheritedModel, thinking: ctx?.thinkingLevel },
        ownerSession,
        signal,
        onUpdate,
      );
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
      const usage = `${run.usage.input + run.usage.cacheRead} in · ${run.usage.output} out · $${run.usage.cost.toFixed(4)}`;
      const output = result.content?.[0]?.text ?? "(no output)";
      const body = options.expanded ? output : output.split("\n").slice(-8).join("\n");
      return new Text(`${icon} ${theme.fg("toolTitle", theme.bold(run.agent))} ${theme.fg("muted", run.id)}\n${theme.fg("toolOutput", body)}\n${theme.fg("dim", usage)}`, 0, 0);
    },
  });

  pi.registerCommand("subagents", {
    description: "Subagent runs: list, continue, or kill",
    getArgumentCompletions: (prefix: string) => {
      const normalized = prefix.trimStart();
      if (!normalized.includes(" ")) {
        const commands = ["list", "cont", "kill"]
          .filter((value) => value.startsWith(normalized))
          .map((value) => ({ value, label: `${value} — ${value === "list" ? "List runs" : value === "cont" ? "Continue a run" : "Stop a run"}` }));
        return commands.length ? commands : null;
      }
      const match = normalized.match(/^(cont|kill)\s+(\S*)$/);
      if (!match) return null;
      const [, action, idPrefix] = match;
      const eligible = listMetas()
        .filter((run) => action === "cont" ? run.state !== "running" && run.state !== "queued" : run.state === "running" || run.state === "queued")
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
      const cont = input.match(/^cont\s+(\S+)\s+([\s\S]+)$/);
      if (cont) {
        const [, id, task] = cont;
        const result = await continueRun(id, task.trim(), ctx, undefined);
        if (typeof result === "string") ctx.ui?.notify?.(result, "warning");
        else ctx.ui?.notify?.(result.content[0].text, result.details.run.state === "done" ? "info" : "error");
        return;
      }
      ctx.ui?.notify?.(`usage: /subagents list | cont <id> <message> | kill <id>`, "warning");
    },
  });
}
