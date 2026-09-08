// pi extension: Hindsight memory loading indicator + /hindsight panel.
//
// WHY: the hindsight-coding-agents plugin reflects on the session's first
// prompt BEFORE the model starts — the user hits enter and nothing moves for
// seconds (up to the reflect timeout), which reads as "hung". This extension
// mirrors that window as a visible loading line, tok-rate style, by tailing
// the two log streams hindsight already writes (purely read-only — it never
// touches the bank, the config, or the logs):
//
//   diag file (JSON lines; /tmp/hindsight-plugin.log)  → completed events:
//       retain_ok / inject_ok / inject_empty / session_start / reflect_ok /
//       reflect_failed / pages_failed / seed_started / deepen_started
//
//   loading line        - "✦ reflecting… (sonic)" in the working row while
//                         prompt-time memory work runs (replacing pi's
//                         "Working" spinner). Painted from before_agent_start
//                         (the auto-reflect logs nothing when it starts) and
//                         cleared when inject lands / streaming starts / turn
//                         ends / 30s elapse, whichever comes first. Position
//                         via PI_HINDSIGHT_LOADING: row (default) / top
//                         (widget above editor) / bottom (widget below) /
//                         footer.
//   /hindsight          - panel: resolved bank, api url, sync stats (via the
//                         runtime's dist/status.js) + recent activity
//   /hindsight tail     - recent memory activity only
//
// Only reflects drive the loading line — inject/retain are sub-second and
// happen at points where pi already shows its own activity. Retained events
// remain inspectable via /hindsight tail.
//
// PI_HINDSIGHT_STATUS=off disables the log watcher (the /hindsight command
// stays available). Machines without the hindsight runtime stay quiet.

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { execFile } from "node:child_process";
import { closeSync, existsSync, openSync, readFileSync, readSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

const DIAG_FILE = process.env.HINDSIGHT_DIAG_FILE || "/tmp/hindsight-plugin.log";
const RUNTIME_STATUS_JS = join(homedir(), ".hindsight", "coding-agents", "dist", "status.js");
const CONFIG_JSON = join(homedir(), ".hindsight", "coding-agent.json");
const POLL_MS = 400;
const LOADING_MAX_MS = 30_000; // safety: never hold the loading line longer than this
const ICON = "✦"; // loading-line prefix — swap freely (emoji renders inconsistently across terminals)

// where the loading line lives: "row" (tok-rate's working row — the default;
// the row demonstrably renders in the pre-agent hang window, replacing pi's
// built-in "Working" spinner until streaming starts), "top" (widget above
// the editor), "bottom" (widget below), "footer" (status area)
type LoadingSpot = "top" | "bottom" | "row" | "footer";
const SPOT: LoadingSpot = ((): LoadingSpot => {
  const v = (process.env.PI_HINDSIGHT_LOADING || "row").trim().toLowerCase();
  return v === "top" || v === "bottom" || v === "footer" ? v : "row";
})();

type EventKind = "info" | "run" | "fail";
interface MemEvent { at: number; label: string; kind: EventKind }
interface DiagLine { ts?: string; event?: string; ms?: number; chars?: number; pages?: number }
interface SyncStatus {
  bank?: string;
  gitlogPresent?: boolean;
  chatDocs?: number;
  pagesCount?: number;
  activeOps?: number;
  synced?: boolean;
}
interface MemUi {
  setStatus?: (key: string, text: string | undefined) => void;
  setWidget?: (key: string, lines: string[] | undefined, options?: { placement?: "aboveEditor" | "belowEditor" }) => void;
  setWorkingMessage?: (msg?: string) => void;
  notify: (msg: string, level?: string) => void;
  theme?: { fg(color: string, text: string): string };
}

function fmtDur(ms?: number): string {
  if (ms === undefined || !Number.isFinite(ms)) return "";
  if (ms < 1000) return `${Math.round(ms)}ms`;
  const s = Math.round(ms / 1000);
  if (s < 60) return `${s}s`;
  return `${Math.floor(s / 60)}m${String(s % 60).padStart(2, "0")}s`;
}

function fmtRel(at: number, now = Date.now()): string {
  const s = Math.max(0, Math.round((now - at) / 1000));
  if (s < 60) return `${s}s`;
  if (s < 3600) return `${Math.floor(s / 60)}m`;
  return `${Math.floor(s / 3600)}h`;
}

// diag JSON line → displayable event (falls back to the raw event name)
function diagLabel(line: string): MemEvent | null {
  let ev: DiagLine;
  try {
    ev = JSON.parse(line) as DiagLine;
  } catch {
    return null;
  }
  if (!ev || typeof ev.event !== "string") return null;
  const at = ev.ts ? Date.parse(ev.ts) || Date.now() : Date.now();
  switch (ev.event) {
    case "retain_ok":
      return { at, label: `ret ${fmtDur(ev.ms)}`.trim(), kind: "info" };
    case "inject_ok":
      return { at, label: ev.chars ? `inj ${ev.chars}c` : "inj", kind: "info" };
    case "inject_empty":
      return { at, label: "inj –", kind: "info" };
    case "session_start":
      return { at, label: ev.pages ? `bank ${ev.pages}p` : "bank", kind: "info" };
    case "reflect_ok":
      return { at, label: `refl ${fmtDur(ev.ms)}`.trim(), kind: "info" };
    case "reflect_failed":
      return { at, label: "refl ✗", kind: "fail" };
    case "pages_failed":
      return { at, label: "pages ✗", kind: "fail" };
    case "seed_started":
      return { at, label: "seed…", kind: "run" };
    case "deepen_started":
      return { at, label: "deepen…", kind: "run" };
    default:
      return { at, label: ev.event, kind: "info" };
  }
}

// incremental file tailer: returns only NEW complete lines between polls;
// the first sight of a file skips its history so a fresh session never
// replays hours of old events
interface Tailer { poll(): string[] }
function createTailer(path: string): Tailer {
  let seen = false;
  let size = 0;
  let buf = "";
  return {
    poll(): string[] {
      let next: number;
      try {
        next = statSync(path).size;
      } catch {
        return []; // file not created yet
      }
      if (!seen) {
        seen = true;
        size = next;
        return [];
      }
      if (next === size) return [];
      let from = size;
      if (next < from) {
        from = 0; // truncated or rotated — start over
        buf = "";
      }
      size = next;
      let chunk = "";
      const fd = openSync(path, "r");
      try {
        const out = Buffer.alloc(next - from);
        readSync(fd, out, 0, out.length, from);
        chunk = out.toString("utf8");
      } finally {
        closeSync(fd);
      }
      const lines = (buf + chunk).split("\n");
      buf = lines.pop() ?? "";
      return lines.filter((l) => l.trim().length > 0);
    },
  };
}

// last n events straight from the diag file (works even with the watcher off)
function readRecentDiag(n: number): MemEvent[] {
  let text = "";
  try {
    const size = statSync(DIAG_FILE).size;
    const from = Math.max(0, size - 65_536);
    const fd = openSync(DIAG_FILE, "r");
    try {
      const out = Buffer.alloc(size - from);
      readSync(fd, out, 0, out.length, from);
      text = out.toString("utf8");
    } finally {
      closeSync(fd);
    }
  } catch {
    return [];
  }
  return text
    .split("\n")
    .filter((l) => l.trim().length > 0)
    .slice(-n * 2) // head of the window may start mid-line — overread a bit
    .map((l) => diagLabel(l))
    .filter((e): e is MemEvent => e !== null)
    .slice(-n);
}

function formatRecent(events: MemEvent[]): string {
  if (events.length === 0) return "";
  const now = Date.now();
  return [
    "recent memory activity:",
    ...events.map((e) => `  ${fmtRel(e.at, now).padStart(4)}  ${e.label}`),
  ].join("\n");
}

interface HindsightConfig { apiUrl?: string; disabled?: boolean }

// resolve bank + sync stats via the hindsight runtime's own status script
// (its git probes print "fatal:" noise to stderr — stdout only holds the JSON)
function runSyncStatus(cwd: string): Promise<SyncStatus | null> {
  return new Promise((resolve) => {
    if (!existsSync(RUNTIME_STATUS_JS)) {
      resolve(null);
      return;
    }
    execFile(process.execPath, [RUNTIME_STATUS_JS, "--repo", cwd], { timeout: 10_000 }, (_err, stdout) => {
      const jsonLine = stdout
        .split("\n")
        .filter((l) => l.trim().startsWith("{"))
        .pop();
      if (!jsonLine) {
        resolve(null);
        return;
      }
      try {
        resolve(JSON.parse(jsonLine) as SyncStatus);
      } catch {
        resolve(null);
      }
    });
  });
}

function formatPanel(sync: SyncStatus | null, apiUrl: string, events: MemEvent[]): string {
  const now = Date.now();
  const lines: string[] = [];
  lines.push(`${ICON} Hindsight — bank: ${sync?.bank ?? "?"}${apiUrl ? `\napi: ${apiUrl}` : ""}`);
  if (sync) {
    const parts = [
      sync.chatDocs !== undefined ? `${sync.chatDocs} docs` : null,
      sync.pagesCount !== undefined ? `${sync.pagesCount} pages` : null,
      `git: ${sync.gitlogPresent ? "✓" : "–"}`,
      sync.activeOps ? `ops: ${sync.activeOps}` : null,
      sync.synced ? "synced" : "not synced yet",
    ].filter((p): p is string => p !== null);
    lines.push(`sync: ${parts.join(" · ")}`);
  } else {
    lines.push("sync: runtime not found (~/.hindsight/coding-agents)");
  }
  if (events.length > 0) {
    lines.push("");
    lines.push("recent:");
    for (const e of events) lines.push(`  ${fmtRel(e.at, now).padStart(4)}  ${e.label}`);
  }
  return lines.join("\n");
}

export default function hindsightExtension(pi: ExtensionAPI): void {
  let ui: MemUi | null = null;
  let timer: NodeJS.Timeout | null = null;
  let loading = false;
  let bankName: string | null = null;
  let bankPromise: Promise<void> | null = null;
  let firstTurn = true;
  let safetyTimer: NodeJS.Timeout | null = null;
  const diagTail = createTailer(DIAG_FILE);

  // bank id for the loading line, resolved exactly like the runtime resolves
  // it (dist/status.js — honors mapPathToBank/banks redirects), fetched once
  // per session in the background; diag events carrying a bank field keep it
  // fresh for free
  const ensureBank = (cwd: string): void => {
    if (bankPromise) return;
    bankPromise = runSyncStatus(cwd)
      .then((s) => {
        if (s?.bank) bankName = s.bank;
      })
      .catch(() => {
        /* bank stays unknown — the line just omits it */
      });
  };

  // Default spot is the working row (pi's built-in "Working" spinner line):
  // the row is already visible while memory work blocks the prompt, so our
  // text simply replaces the spinner label — one line, same place tok-rate
  // paints once streaming starts. Widget/footer spots exist for hosts where
  // the row is not rendered in that window.
  const showLoading = (label: string, kind: EventKind): void => {
    loading = true;
    const text = bankName ? `${ICON} ${label} (${bankName})` : `${ICON} ${label}`;
    const colored = ui?.theme ? ui.theme.fg(kind === "fail" ? "error" : "accent", text) : text;
    if (safetyTimer) clearTimeout(safetyTimer);
    safetyTimer = setTimeout(() => clearLoading(), LOADING_MAX_MS);
    if (typeof safetyTimer.unref === "function") safetyTimer.unref();
    try {
      if (SPOT === "footer") ui?.setStatus?.("hindsight", colored);
      else if (SPOT === "row") ui?.setWorkingMessage?.(colored);
      else ui?.setWidget?.("hindsight", [colored], { placement: SPOT === "bottom" ? "belowEditor" : "aboveEditor" });
    } catch {
      /* stale ui after reload — drop this paint */
    }
  };

  const clearLoading = (): void => {
    if (safetyTimer) {
      clearTimeout(safetyTimer);
      safetyTimer = null;
    }
    if (!loading) return;
    loading = false;
    try {
      if (SPOT === "footer") ui?.setStatus?.("hindsight", undefined);
      else if (SPOT === "row") ui?.setWorkingMessage?.();
      else ui?.setWidget?.("hindsight", undefined);
    } catch {
      /* stale ui after reload */
    }
  };

  const observe = (ev: MemEvent): void => {
    // reflects are the long pole — mirror them; inject landing means the
    // prompt-time memory work is over (the wait is over even mid-reflect)
    if (ev.label.startsWith("refl")) {
      if (ev.kind === "run") showLoading(ev.label, ev.kind);
      else clearLoading();
    } else if (ev.label.startsWith("inj")) {
      clearLoading();
    }
  };

  const poll = (): void => {
    for (const line of diagTail.poll()) {
      try {
        const b = (JSON.parse(line) as DiagLine & { bank?: string }).bank;
        if (typeof b === "string" && b) bankName = b;
      } catch {
        /* non-JSON line */
      }
      const ev = diagLabel(line);
      if (ev) observe(ev);
    }
  };

  pi.on("session_start", async (_event: unknown, ctx: { hasUI?: boolean; ui?: MemUi } | undefined) => {
    if (ctx?.hasUI === false) return;
    if (!ctx?.ui) return;
    ui = ctx.ui;
    if ((process.env.PI_HINDSIGHT_STATUS || "").toLowerCase() === "off") return;
    bankName = null;
    bankPromise = null;
    firstTurn = true;
    ensureBank(ctx.cwd ?? process.cwd());
    if (!timer) {
      timer = setInterval(poll, POLL_MS);
      if (typeof timer.unref === "function") timer.unref();
    }
  });

  // The auto-reflect logs NOTHING when it starts (only when it ends), so log
  // tailing alone paints late. On the session's first turn, paint immediately
  // from this event instead — hindsight runs its prompt-time memory work
  // (recall → reflect → inject) inside this same phase.
  pi.on("before_agent_start", async (_event: unknown, ctx: { hasUI?: boolean; ui?: MemUi } | undefined) => {
    if (ctx?.ui) ui = ctx.ui;
    if (!firstTurn) return;
    showLoading("memory…", "run");
    firstTurn = false;
  });

  // belt+braces: an aborted/errored turn must never leave the line behind
  pi.on("turn_end", async () => clearLoading());

  pi.on("session_shutdown", async () => {
    if (timer) {
      clearInterval(timer);
      timer = null;
    }
    clearLoading();
  });

  pi.registerCommand("hindsight", {
    description: "Hindsight memory status. /hindsight [tail]",
    getArgumentCompletions: (prefix: string) => {
      const p = prefix.trim();
      const subs = [{ value: "tail", label: "tail — Recent memory activity only" }].filter((s) =>
        s.value.startsWith(p),
      );
      return subs.length > 0 ? subs : null;
    },
    handler: async (args: string, ctx: { ui: MemUi; cwd?: string }) => {
      ui = ctx.ui;
      const [sub] = args.trim().split(/\s+/).filter(Boolean);
      if (sub === "tail") {
        const recent = formatRecent(readRecentDiag(10));
        ctx.ui.notify(recent || "no hindsight activity recorded yet", "info");
        return;
      }
      const sync = await runSyncStatus(ctx.cwd ?? process.cwd());
      let apiUrl = "";
      try {
        apiUrl = (JSON.parse(readFileSync(CONFIG_JSON, "utf8")) as HindsightConfig)?.apiUrl ?? "";
      } catch {
        /* no config — fall through with an empty api line */
      }
      ctx.ui.notify(formatPanel(sync, apiUrl, readRecentDiag(6)), "info");
    },
  });
}

export { diagLabel, fmtDur, fmtRel, formatPanel, formatRecent, readRecentDiag };
