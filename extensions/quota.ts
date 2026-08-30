// pi extension: AI quota status via ai-cost MCP (get_quota)
//
// Source of truth: /opt/tintin/config/pi/extensions/quota.ts (tintin-hq-infra)
// Symlinked into ~/.pi/agent/extensions/ by `task pi-extensions-setup`.
//
// Features:
//   status line (footer)  - /quota status all|current|off  (persisted)
//   /quota                - transient panel (ctx.ui.notify, NOT into context)
//   /quota refresh        - bypass the 5-minute cache
//   /quota tools on|off   - expose quota_check tool to the model (default off)
//
// No-ops silently when the ai-cost binary is missing (portable to other machines).

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

const AI_COST_BIN = "/home/tin5451/.local/bin/ai-cost";
const AI_COST_ENV = {
  ...process.env,
  AI_COST_DATA_DATABASE_URL: "sqlite:///opt/tintin/data/ai-cost/data.db",
  AI_COST_OPENCODE_DATABASE_PATH: `${os.homedir()}/.local/share/opencode/opencode.db`,
  AI_COST_MODELS_PATH: `${os.homedir()}/.cache/opencode/models.json`,
} as Record<string, string>;

const CACHE_TTL_MS = 5 * 60_000;
const CALL_TIMEOUT_MS = 20_000;
const STATUS_REFRESH_MS = 5 * 60_000; // keep footer fresh; aligned with cache TTL
const SETTINGS_FILE = path.join(os.homedir(), ".pi/agent/quota-ext-settings.json");

// Heuristic mapping current model -> subscription provider for `status current`.
// Unmatched models fall back to showing all providers.
const MODEL_PROVIDER_HINTS: Array<[RegExp, string]> = [
  [/manager-model|coder-model|glm-5/i, "z.ai"],
  [/9arm/i, "9arm"],
  [/gpt-5\.6-luna|deepseek-v4-flash(?!-free)/i, "opencode-go"],
  [/gpt-5\.6-sol|codex/i, "openai"],
];

type QuotaBar = { label: string; percent: number; usage?: string; reset_after_seconds?: number };
type QuotaProvider = { provider: string; plan?: string; status: string; bars: QuotaBar[]; error?: string };
type QuotaResponse = { providers: QuotaProvider[]; metadata?: { freshness?: string; degraded?: boolean } };
type Settings = { statusMode: "all" | "current" | "off"; toolsEnabled: boolean };
type Ui = {
  setStatus?: (key: string, text: string) => void;
  setWidget?: (key: string, lines: string[] | undefined, options?: { placement?: "aboveEditor" | "belowEditor" }) => void;
  notify: (msg: string, level: string) => void;
  select?: (title: string, options: string[]) => Promise<string | undefined>;
  confirm?: (title: string, message: string) => Promise<boolean>;
};

const DEFAULT_SETTINGS: Settings = { statusMode: "all", toolsEnabled: false };

function loadSettings(): Settings {
  try {
    return { ...DEFAULT_SETTINGS, ...JSON.parse(readFileSync(SETTINGS_FILE, "utf8")) };
  } catch {
    return { ...DEFAULT_SETTINGS };
  }
}

class McpClient {
  private proc: ChildProcessWithoutNullStreams | null = null;
  private buffer = "";
  private nextId = 1;
  private pending = new Map<number, { resolve: (v: string) => void; reject: (e: Error) => void }>();

  private ensure(): ChildProcessWithoutNullStreams {
    if (this.proc && this.proc.exitCode === null) return this.proc;
    const proc = spawn(AI_COST_BIN, ["mcp"], { env: AI_COST_ENV, stdio: ["pipe", "pipe", "pipe"] });
    proc.stdout.setEncoding("utf8");
    proc.stdout.on("data", (chunk: string) => {
      this.buffer += chunk;
      let idx: number;
      while ((idx = this.buffer.indexOf("\n")) >= 0) {
        const line = this.buffer.slice(0, idx).trim();
        this.buffer = this.buffer.slice(idx + 1);
        if (!line) continue;
        try {
          const msg = JSON.parse(line) as { id?: number; result?: unknown; error?: { message?: string } };
          if (typeof msg.id === "number" && this.pending.has(msg.id)) {
            const { resolve, reject } = this.pending.get(msg.id)!;
            this.pending.delete(msg.id);
            if (msg.error) reject(new Error(msg.error.message ?? "MCP error"));
            else resolve(JSON.stringify(msg.result ?? {}));
          }
        } catch {
          // non-JSON diagnostics on stdout — ignore
        }
      }
    });
    proc.on("exit", () => {
      for (const { reject } of this.pending.values()) reject(new Error("ai-cost mcp exited"));
      this.pending.clear();
      this.proc = null;
    });
    this.proc = proc;
    return proc;
  }

  private request(method: string, params: unknown): Promise<string> {
    const proc = this.ensure();
    const id = this.nextId++;
    const payload = JSON.stringify({ jsonrpc: "2.0", id, method, params }) + "\n";
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`MCP ${method} timed out after ${CALL_TIMEOUT_MS}ms`));
      }, CALL_TIMEOUT_MS);
      this.pending.set(id, {
        resolve: (v) => { clearTimeout(timer); resolve(v); },
        reject: (e) => { clearTimeout(timer); reject(e); },
      });
      proc.stdin.write(payload);
    });
  }

  async call(name: string, args: Record<string, unknown> = {}): Promise<string> {
    if (!this.proc) {
      await this.request("initialize", {
        protocolVersion: "2024-11-05",
        capabilities: {},
        clientInfo: { name: "pi-quota-ext", version: "0.1.0" },
      });
      this.proc!.stdin.write(JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" }) + "\n");
    }
    const raw = await this.request("tools/call", { name, arguments: args });
    const parsed = JSON.parse(raw) as { content?: Array<{ type: string; text?: string }> };
    return parsed.content?.find((c) => c.type === "text")?.text ?? raw;
  }

  dispose(): void {
    this.proc?.kill();
    this.proc = null;
  }
}

function humanizeReset(seconds?: number): string {
  if (!seconds || seconds <= 0) return "";
  const d = Math.floor(seconds / 86400);
  const h = Math.floor((seconds % 86400) / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  return d > 0 ? `${d}d${h}h` : h > 0 ? `${h}h${m}m` : `${m}m`;
}

function normalizeProvider(s: string): string {
  return s.toLowerCase().replace(/[^a-z0-9]/g, "");
}

function providerMatches(quotaProvider: string, target: string): boolean {
  const pn = normalizeProvider(quotaProvider);
  const tn = normalizeProvider(target);
  return pn.includes(tn) || tn.includes(pn);
}

function formatPanel(res: QuotaResponse): string {
  const lines: string[] = ["AI quotas (ai-cost):"];
  for (const p of res.providers) {
    if (p.status === "error") { lines.push(`  ${p.provider}: error — ${p.error ?? "unknown"}`); continue; }
    if (p.status === "deferred" || p.bars.length === 0) { lines.push(`  ${p.provider}: ${p.status}`); continue; }
    for (const b of p.bars) {
      const reset = humanizeReset(b.reset_after_seconds);
      const usage = b.usage ? ` (${b.usage})` : "";
      lines.push(`  ${p.provider} ${b.label}: ${Math.round(b.percent)}%${usage}${reset ? ` · resets in ${reset}` : ""}`);
    }
  }
  const fresh = res.metadata?.freshness;
  if (fresh === "stale") lines.push("  ⚠ data stale (last sync > 2h ago)");
  return lines.join("\n");
}

function showQuotaWidget(targetUi: Ui, res: QuotaResponse | null): void {
  const lines = res ? formatPanel(res).split("\n") : ["AI quotas: unavailable"];
  targetUi.setWidget?.("quota-panel", lines, { placement: "aboveEditor" });
}

// Compact single line for the model-facing quota_check tool — token economy:
// one highest-consuming bar per provider, compact reset timers, no ANSI,
// and Gemini excluded (its 6+ rate-limit bars dominate
// the output while coding models never route through it).
function formatToolResponse(res: QuotaResponse): string {
  const parts = res.providers
    .filter((p) => !/gemini/i.test(p.provider))
    .map((p) => {
      if (p.status !== "ok" || p.bars.length === 0) return `${shortName(p.provider)} ${p.status}`;
      const top = [...p.bars].sort((a, b) => b.percent - a.percent)[0];
      const reset = humanizeReset(top.reset_after_seconds);
      return `${shortName(p.provider)} ${Math.round(top.percent)}%${reset ? ` ${reset}` : ""}`;
    });
  if (parts.length === 0) return "no quota data";
  return `quota: ${parts.join(" · ")}`;
}

const GREEN = "\x1b[32m", YELLOW = "\x1b[33m", RED = "\x1b[31m", DIM = "\x1b[2m", R = "\x1b[0m";

function shortName(provider: string): string {
  const p = provider.toLowerCase();
  if (p.includes("z.ai") || p.includes("zai")) return "zAI";
  if (p.includes("opencode")) return "OC";
  if (p.includes("9arm")) return "9arm";
  if (p.includes("openai") || p.includes("codex")) return "OA";
  if (p.includes("gemini")) return "Gem";
  return provider.split(".")[0].slice(0, 4);
}

function colorForPct(pct: number): string {
  if (pct >= 95) return RED;
  if (pct >= 70) return YELLOW;
  return GREEN;
}

function statusLineText(res: QuotaResponse, mode: Settings["statusMode"], currentProvider: string | null, currentModelId: string | null): string {
  if (mode === "off") return "";
  let providers = res.providers;
  if (mode === "current") {
    const target = currentProvider ?? (currentModelId ? MODEL_PROVIDER_HINTS.find(([re]) => re.test(currentModelId!))?.[1] : null);
    const matched = target ? providers.filter((p) => providerMatches(p.provider, target)) : [];
    if (matched.length > 0) providers = matched; // fallback: show all when unmapped
  }
  const parts = providers.map((p) => {
    if (p.status === "deferred" || p.bars.length === 0) return `${DIM}${shortName(p.provider)}–${R}`;
    const top = [...p.bars].sort((a, b) => b.percent - a.percent)[0];
    if (!top) return `${DIM}${shortName(p.provider)}${R}`;
    const pct = Math.round(top.percent);
    return `${colorForPct(pct)}${shortName(p.provider)}${pct}%${R}`;
  });
  if (parts.length === 0) return "";
  // Compact single-line format (mobile-safe): no "quota:" prefix, no " · "
  // separators — long status lines wrap on narrow screens and make the pi-web
  // footer grow tall. Typical output: "zAI42% OC78% 9arm– OA15%" (~24 chars).
  const stale = res.metadata?.freshness === "stale" ? ` ${DIM}*${R}` : "";
  return `${parts.join(" ")}${stale}`;
}

export default function quotaExtension(pi: ExtensionAPI): void {
  if (!existsSync(AI_COST_BIN)) return; // silent no-op on machines without ai-cost

  const settings = loadSettings();
  const client = new McpClient();
  let cached: QuotaResponse | null = null;
  let fetchedAt = 0;
  let currentProvider: string | null = null;
  let currentModelId: string | null = null;
  let fetching = false;
  let ui: Ui | null = null;
  let statusTimer: ReturnType<typeof setInterval> | null = null;

  const save = () => writeFileSync(SETTINGS_FILE, JSON.stringify(settings));

  const getQuota = async (force = false): Promise<QuotaResponse | null> => {
    if (!force && cached && Date.now() - fetchedAt < CACHE_TTL_MS) return cached;
    if (fetching) return cached;
    fetching = true;
    try {
      const text = await client.call("get_quota");
      cached = JSON.parse(text) as QuotaResponse;
      fetchedAt = Date.now();
      return cached;
    } catch {
      return cached; // serve stale on failure; null on first-failure
    } finally {
      fetching = false;
    }
  };

  const refreshStatus = async () => {
    if (!ui?.setStatus) return;
    const res = await getQuota();
    const text = res ? statusLineText(res, settings.statusMode, currentProvider, currentModelId) : "";
    if (settings.statusMode !== "off") ui.setStatus("quota", text);
  };

  const applyToolsEnabled = () => {
    try {
      const active = (pi.getActiveTools?.() ?? []).map((t: unknown) =>
        typeof t === "string" ? t : (t as { name?: string })?.name,
      ).filter((n): n is string => Boolean(n));
      const base = active.filter((n) => n !== "quota_check");
      const next = settings.toolsEnabled ? [...base, "quota_check"] : base;
      pi.setActiveTools?.(next);
    } catch {
      ui?.notify?.("quota: tool toggle not supported by this pi version", "info");
    }
  };

  pi.on("session_start", async (_event: unknown, ctx: { ui: Ui; model?: { provider?: string; id?: string } }) => {
    ui = ctx.ui;
    currentProvider = ctx.model?.provider ?? null;
    currentModelId = ctx.model?.id ?? null;
    applyToolsEnabled();
    // Fire-and-forget: never block session startup on the MCP fetch —
    // the status line pops in when data arrives (measured ~7s if awaited).
    void refreshStatus();
    if (!statusTimer) statusTimer = setInterval(() => { void refreshStatus(); }, STATUS_REFRESH_MS);
  });
  pi.on("model_select", async (event: { model?: { provider?: string; id?: string } }) => {
    const m = event.model;
    currentProvider = m?.provider ?? null;
    currentModelId = m?.id ?? null;
    await refreshStatus();
  });
  pi.on("session_shutdown", async () => {
    if (statusTimer) { clearInterval(statusTimer); statusTimer = null; }
    client.dispose();
  });

  pi.registerCommand("quota", {
    description: "AI provider quotas (ai-cost). /quota [setting|refresh|tools on|off|status all|current|off]",
    getArgumentCompletions: (prefix: string) => {
      const normalized = prefix.trimStart();
      const argumentMatch = normalized.match(/^(\S+)\s+(.*)$/);
      if (!argumentMatch) {
        const subcommands = [
          { value: "setting", label: "setting — Open settings picker" },
          { value: "refresh", label: "refresh — Bypass the 5-min cache" },
          { value: "tools", label: "tools — Expose quota_check tool to the model" },
          { value: "status", label: "status — Set footer status mode" },
        ].filter(({ value }) => value.startsWith(normalized));
        return subcommands.length > 0 ? subcommands : null;
      }
      const [, subcommand, argumentPrefix] = argumentMatch;
      if (argumentPrefix === undefined) return null;
      if (subcommand === "tools") {
        const values = ["on", "off"]
          .filter((v) => v.startsWith(argumentPrefix.trimStart()))
          .map((v) => ({ value: `tools ${v}`, label: `${v} — ${v === "on" ? "Show quota_check to model" : "Hide quota_check from model"}` }));
        return values.length > 0 ? values : null;
      }
      if (subcommand === "status") {
        const values = ["all", "current", "off"]
          .filter((v) => v.startsWith(argumentPrefix.trimStart()))
          .map((v) => ({ value: `status ${v}`, label: `${v} — ${v === "off" ? "Hide footer status" : `Footer: ${v}`} ` }));
        return values.length > 0 ? values : null;
      }
      return null;
    },
    handler: async (args: string, ctx: { ui: Ui }) => {
      ui = ctx.ui;
      const [sub, value] = args.trim().split(/\s+/).filter(Boolean);
      if (sub === "setting") {
        if (!ctx.ui.select) {
          ctx.ui.notify("interactive settings picker unavailable in this mode — use /quota tools or /quota status", "error");
          return;
        }

        type PendingSetting = { key: "statusMode"; value: Settings["statusMode"] } | { key: "toolsEnabled"; value: boolean };
        type Pickable = PendingSetting | { key: "save" };
        const pending = new Map<PendingSetting["key"], PendingSetting["value"]>();
        const isDirty = () => pending.size > 0;
        const onDiskValue = (key: PendingSetting["key"]): PendingSetting["value"] => settings[key];

        for (;;) {
          const statusMode = pending.get("statusMode") ?? settings.statusMode;
          const toolsEnabled = pending.get("toolsEnabled") ?? settings.toolsEnabled;
          const options: string[] = [];
          const map: Pickable[] = [];
          const add = (label: string, picked: Pickable) => { options.push(label); map.push(picked); };
          add(`${statusMode === "all" ? "✓" : "○"} statusMode: all`, { key: "statusMode", value: "all" });
          add(`${statusMode === "current" ? "✓" : "○"} statusMode: current`, { key: "statusMode", value: "current" });
          add(`${statusMode === "off" ? "✓" : "○"} statusMode: off`, { key: "statusMode", value: "off" });
          add(`${toolsEnabled ? "✓" : "○"} toolsEnabled: on`, { key: "toolsEnabled", value: true });
          add(`${toolsEnabled ? "○" : "✓"} toolsEnabled: off`, { key: "toolsEnabled", value: false });
          if (isDirty()) add(`💾 Save (${pending.size} change(s))`, { key: "save" });

          const choice = await ctx.ui.select(`Quota settings${isDirty() ? ` — ${pending.size} unsaved` : ""}`, options);
          if (!choice) break;
          const picked = map[options.indexOf(choice)];
          if (!picked) continue;
          if (picked.key === "save") {
            const nextStatusMode = pending.get("statusMode");
            const nextToolsEnabled = pending.get("toolsEnabled");
            if (nextStatusMode !== undefined) settings.statusMode = nextStatusMode;
            if (nextToolsEnabled !== undefined) settings.toolsEnabled = nextToolsEnabled;
            save();
            applyToolsEnabled();
            if (settings.statusMode === "off") ctx.ui.setStatus?.("quota", "");
            else await refreshStatus();
            const count = pending.size;
            pending.clear();
            ctx.ui.notify(`${count} quota setting change(s) saved`, "info");
            return;
          }
          if (picked.value === onDiskValue(picked.key)) pending.delete(picked.key);
          else pending.set(picked.key, picked.value);
        }

        if (isDirty()) {
          if (!ctx.ui.confirm) {
            ctx.ui.notify("settings picker confirmation unavailable — discarded (settings unchanged)", "info");
            return;
          }
          const shouldSave = await ctx.ui.confirm("Unsaved quota settings", `${pending.size} change(s) not saved — save now?`);
          if (shouldSave) {
            const nextStatusMode = pending.get("statusMode");
            const nextToolsEnabled = pending.get("toolsEnabled");
            if (nextStatusMode !== undefined) settings.statusMode = nextStatusMode;
            if (nextToolsEnabled !== undefined) settings.toolsEnabled = nextToolsEnabled;
            save();
            applyToolsEnabled();
            if (settings.statusMode === "off") ctx.ui.setStatus?.("quota", "");
            else await refreshStatus();
            const count = pending.size;
            pending.clear();
            ctx.ui.notify(`${count} quota setting change(s) saved`, "info");
          } else {
            ctx.ui.notify("discarded (settings unchanged)", "info");
          }
        }
        return;
      }
      if (sub === "refresh") {
        cached = null;
        const res = await getQuota(true);
        showQuotaWidget(ctx.ui, res);
        ctx.ui.notify(res ? "quota panel refreshed" : "quota: fetch failed", res ? "info" : "error");
        await refreshStatus();
        return;
      }
      if (sub === "tools") {
        settings.toolsEnabled = value === "on";
        save();
        applyToolsEnabled();
        ctx.ui.notify(`quota_check tool: ${settings.toolsEnabled ? "visible to model" : "hidden from model"}`, "info");
        return;
      }
      if (sub === "status") {
        if (value === "all" || value === "current" || value === "off") {
          settings.statusMode = value;
          save();
          if (value === "off") ctx.ui.setStatus?.("quota", "");
          await refreshStatus();
          ctx.ui.notify(`status line mode: ${value}`, "info");
        } else {
          ctx.ui.notify("usage: /quota status all|current|off", "error");
        }
        return;
      }
      const res = await getQuota();
      showQuotaWidget(ctx.ui, res);
      if (!res) ctx.ui.notify("quota: unavailable (is ai-cost built with --features mcp?)", "error");
    },
  });

  pi.registerTool({
    name: "quota_check",
    label: "Quota check",
    description: "Check usage percentage of AI provider subscriptions (z.ai, opencode-go, 9arm, openai). Use before starting long jobs.",
    parameters: Type.Object({}),
    async execute() {
      const res = await getQuota(true);
      return {
        content: [{ type: "text" as const, text: res ? formatToolResponse(res) : "quota unavailable" }],
        details: {},
      };
    },
  });
}

export { quotaExtension };
