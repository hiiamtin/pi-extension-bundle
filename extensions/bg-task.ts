// pi extension: background task runner — keep chatting while long jobs run.
//
// WHY: long-running tool calls block the whole session (real case: a
// brute-force node solver pinned a session for 10+ minutes; `task logs-*`
// with docker `logs -f` never exits at all). This extension gives the model
// non-blocking tools:
//
//   bg_run(command, name?, timeout_min?, detach?)  → spawn detached (own
//                                           process group), returns <100ms,
//                                           chat continues. detach=true: output
//                                           fd-redirected, survives pi exit
//                                           (exit code recorded to <id>/exitcode).
//   bg_status(id?)                        → one task or all tasks (shared state:
//                                           visible across ALL pi sessions).
//   bg_log(id, tail_lines?)               → tail the rolling output log.
//   bg_artifact(id?, path?)               → token-safe summary of a result file
//                                           (JSON/JSONL/CSV/text: schema +
//                                           first entries, never the whole file).
//   bg_kill(id)                           → SIGTERM the whole process group,
//                                           escalate to SIGKILL after 5s.
//
// FOLLOW-MODE INTERCEPTOR (PI_BG_INTERCEPTOR, default auto-bg):
//   warn    — built-in `bash` tool watched; a follow/stream command is blocked
//             ONCE with a short reason (use bg_run / add `timeout` / repeat the
//             exact command to force-run). Detection is scoped per command so
//             `rm -f`, `grep -f`, heredoc bodies etc. never false-positive.
//   auto-bg — don't even ask: the follow command is started as a background
//             task directly (a blocking call to a follow command is always
//             wrong — pi only sees output when a process exits).
//   off     — no interception.
//
// Design notes (TinTin VM, 4 cores / 24GB ARM):
//   - Every task runs `nice -n 15 ionice -c3` so background jobs can never
//     starve the docker stack (traefik/9router/litellm/pi-web).
//   - Shared state dir ~/.pi/agent/bg-tasks/<id>/ (meta.json + out.log).
//     All sessions see all tasks; each session's instance heartbeats its own.
//     Stale heartbeat (>15s) + running process → marked "orphan" (still
//     visible/killable everywhere, nobody is watching it anymore).
//   - Log is a rolling file (rotates at half of PI_BG_LOG_CAP_MB, keeps one
//     old file) piped through a write stream — fixed memory, bounded disk.
//     Limitation: tasks whose output exceeds the pipe buffer die if the pi
//     process itself exits mid-run (marked "gone" on next scan).
//   - On exit the owning session gets pi.sendMessage(..., triggerTurn) so the
//     model announces the result proactively instead of the user polling.
//     pi.sendMessage is read AT CALL TIME (late-bound): at load pi hands a
//     notInitialized placeholder, so capturing it early silently broke every
//     notification (the bug behind lost notices). If the watcher dies anyway
//     (reload/restart), meta.notifiedAt stays unset and the next live session
//     surfaces the finished task at its session_start — data never gets lost.
//     All spawn/exit/notify attempts are logged to bg-task-debug.log.
//   - Auto-prune: finished/orphan/gone dirs older than PI_BG_PRUNE_HOURS (24).
//
// Human commands:  /bg            — interactive task picker (inspect/kill)
//                  /bg kill <id>  — kill with confirm
//                  /bg on|off     — expose bg_* tools AND gate the interceptor
//
// Config (env): PI_BG_STATE_DIR, PI_BG_MAX_CONCURRENT (8), PI_BG_LOG_CAP_MB (2),
//               PI_BG_PRUNE_HOURS (24), PI_BG_DEFAULT_TIMEOUT_MIN (0 = none),
//               PI_BG_TICK_MS (5000 — scan/heartbeat cadence while tasks run).
// After any pi upgrade run: node scripts/smoke-test.mjs

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { extractToolArgs, requireString, textResult } from "../lib/tool-compat.ts";
import { Type } from "typebox";
import { spawn, type ChildProcess } from "node:child_process";
import {
  closeSync,
  createWriteStream,
  existsSync,
  mkdirSync,
  openSync,
  readFileSync,
  readdirSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

// --- config -----------------------------------------------------------------

function envInt(name: string, def: number, min: number, max: number): number {
  const v = Number(process.env[name]);
  if (!Number.isFinite(v)) return def;
  return Math.min(max, Math.max(min, Math.round(v)));
}

const STATE_DIR = process.env.PI_BG_STATE_DIR || path.join(os.homedir(), ".pi/agent/bg-tasks");
const MAX_CONCURRENT = envInt("PI_BG_MAX_CONCURRENT", 8, 1, 64);
const ROTATE_BYTES = envInt("PI_BG_LOG_CAP_MB", 2, 1, 128) * 512 * 1024; // per file; total cap = 2× this
const PRUNE_MS = envInt("PI_BG_PRUNE_HOURS", 24, 1, 24 * 30) * 3_600_000;
const DEFAULT_TIMEOUT_MIN = envInt("PI_BG_DEFAULT_TIMEOUT_MIN", 0, 0, 24 * 60); // 0 = no timeout
const KILL_ESCALATE_MS = 5_000;
const ORPHAN_MS = 15_000; // heartbeat older than this + still running => orphan
const ADOPT_GRACE_MS = 60_000; // foreign finished task: adopt (notify here) only after the owner had this long to do it itself
const WIDGET_MS = envInt("PI_BG_TICK_MS", 5_000, 1_000, 300_000); // scan/heartbeat cadence while tasks are running
const SETTINGS_FILE = path.join(os.homedir(), ".pi/agent/bg-task-settings.json");
const MAX_OUTPUT_CHARS = 8_000;
const INTERCEPTOR_MODE = (process.env.PI_BG_INTERCEPTOR || "auto-bg").toLowerCase(); // auto-bg | warn | off
const ARTIFACT_PARSE_LIMIT = 8 * 1024 * 1024; // files bigger than this skip JSON.parse

// --- types ------------------------------------------------------------------

type TaskState = "running" | "done" | "failed" | "killed" | "timeout" | "orphan" | "gone";

interface Meta {
  id: string;
  name: string;
  cmd: string;
  pid: number;
  pgid: number;
  startedAt: number;
  finishedAt?: number;
  exitCode?: number | null;
  signal?: string | null;
  state: TaskState;
  owner: string; // short session label (or pid-NNN fallback)
  ownerSession?: string; // full session file path — the real per-session identity
  heartbeat?: number; // updated every widget tick by the owning instance
  bytes?: number; // total output bytes written (across rotations)
  detach?: boolean; // fd-redirected output: survives pi restart (no live rotation)
  notifiedAt?: number; // set once the finish notice was delivered to a session
  notifyTries?: number;
}

interface OwnTask {
  meta: Meta;
  child: ChildProcess;
  stream: ReturnType<typeof createWriteStream> | null; // null in detach mode
  bytesCurrent: number; // bytes in the current out.log (pipe mode only)
  timeoutTimer: NodeJS.Timeout | null;
  killTimer: NodeJS.Timeout | null;
}

// --- small helpers ----------------------------------------------------------

function clampChars(s: string, max: number): string {
  return s.length > max ? s.slice(0, max) + `… (+${s.length - max} chars)` : s;
}

function fmtDur(ms: number): string {
  const s = Math.max(0, Math.round(ms / 1000));
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m${String(s % 60).padStart(2, "0")}s`;
  return `${Math.floor(m / 60)}h${String(m % 60).padStart(2, "0")}m`;
}

function ownerId(): string {
  // fallback identity when no session file is available (ephemeral sessions)
  return `pid-${process.pid}`;
}

function shortSession(sessionFile: string): string {
  // "~/.pi/agent/sessions/<hash>/2026-08-30T19-35-12-abc.jsonl" -> "2026-08-30T19-35"
  const base = (sessionFile.split("/").pop() ?? sessionFile).replace(/\.jsonl$/, "");
  return base.slice(0, 16);
}

// Whose notice is this? Sessions are separated by their session FILE (pid is
// useless in pi-web where every session shares one process).
//   - our own session                    -> always ours
//   - owner session file deleted          -> owner is gone, adopt
//   - otherwise foreign                   -> adopt only after ADOPT_GRACE_MS
//     (a live owner's exit handler notifies within milliseconds; silence past
//     the grace means its watcher is dead)
function shouldAdoptNotice(m: Meta, now: number): boolean {
  const age = now - (m.finishedAt ?? now);
  if (!m.ownerSession) return age > ADOPT_GRACE_MS; // legacy meta without session identity
  if (currentSessionFile && m.ownerSession === currentSessionFile) return true;
  if (!existsSync(m.ownerSession)) return true; // owner session file deleted — owner is gone
  return age > ADOPT_GRACE_MS; // foreign: its live exit handler notifies in ms; silence means dead
}

function isCrossSession(m: Meta): boolean {
  return !!m.ownerSession && (!currentSessionFile || m.ownerSession !== currentSessionFile);
}

// Aggregate CPU/RSS of an entire process group from /proc — stateless average
// CPU over the task's lifetime (no sampling window needed). Returns null when
// nothing in the group is alive anymore.
function groupStats(pgid: number, elapsedSec: number): { cpuPct: number; rssMb: number } | null {
  try {
    const CLK = 100; // getconf CLK_TCK on Linux
    const PAGE = 4096;
    let ticks = 0;
    let rssKb = 0;
    let found = false;
    for (const pid of readdirSync("/proc")) {
      if (!/^\d+$/.test(pid)) continue;
      let text: string;
      try {
        text = readFileSync(`/proc/${pid}/stat`, "utf8");
      } catch {
        continue; // process vanished mid-scan
      }
      const after = text.slice(text.lastIndexOf(")") + 2).split(" ");
      if (Number(after[2]) !== pgid) continue; // after[2] = pgrp
      found = true;
      ticks += (Number(after[11]) + Number(after[12])) / CLK; // utime + stime
      const rss = Number(after[21]); // rss pages
      if (Number.isFinite(rss)) rssKb += (rss * PAGE) / 1024;
    }
    return found ? { cpuPct: Math.round(elapsedSec > 0 ? (ticks / elapsedSec) * 100 : 0), rssMb: Math.round((rssKb / 1024) * 10) / 10 } : null;
  } catch {
    return null;
  }
}

function stateIcon(s: TaskState): string {
  return s === "running" ? "⚙️" : s === "done" ? "✅" : s === "failed" ? "❌" : s === "killed" ? "🛑" : s === "timeout" ? "⏱" : s === "orphan" ? "⛓" : "👻";
}

function pgidAlive(pgid: number): boolean {
  try {
    process.kill(pgid, 0);
    return true;
  } catch (e) {
    return (e as NodeJS.ErrnoException).code === "EPERM"; // exists but not ours
  }
}

// --- persistence ------------------------------------------------------------

function dirOf(id: string): string {
  return path.join(STATE_DIR, id);
}

function metaPath(id: string): string {
  return path.join(STATE_DIR, id, "meta.json");
}

function writeMeta(meta: Meta): void {
  try {
    mkdirSync(dirOf(meta.id), { recursive: true });
    writeFileSync(metaPath(meta.id), JSON.stringify(meta, null, 1));
  } catch {
    // best-effort; listing degrades gracefully if unwritable
  }
}

function readMeta(id: string): Meta | null {
  try {
    return JSON.parse(readFileSync(metaPath(id), "utf8")) as Meta;
  } catch {
    return null;
  }
}

function listDiskMetas(): Meta[] {
  try {
    return readdirSync(STATE_DIR)
      .map((d) => readMeta(d))
      .filter((m): m is Meta => !!m)
      .sort((a, b) => b.startedAt - a.startedAt);
  } catch {
    return [];
  }
}

// --- extension state --------------------------------------------------------

const own = new Map<string, OwnTask>();
let settings = { toolsEnabled: true };
let cachedUi: { setWidget?: (k: string, lines: string[] | undefined) => void; setStatus?: (k: string, t: string) => void } | null = null;
let widgetTimer: NodeJS.Timeout | null = null;
let notify: ((msg: string, level: string) => void) | null = null;
let piApi: ExtensionAPI | null = null;
let currentSessionFile: string | undefined; // this instance's own session (set on session_start)

const DEBUG_LOG = path.join(os.homedir(), ".pi/agent/log/bg-task-debug.log");
// self-capped (~48KB) diagnostics for spawn/exit/notify — never fatal
function debugLog(line: string): void {
  try {
    mkdirSync(path.dirname(DEBUG_LOG), { recursive: true });
    let text = `${new Date().toISOString()} ${line}\n`;
    try {
      text = readFileSync(DEBUG_LOG, "utf8").slice(-48_000) + text;
    } catch {
      /* first write */
    }
    writeFileSync(DEBUG_LOG, text);
  } catch {
    /* ignore */
  }
}

function loadSettings(): void {
  try {
    settings = { toolsEnabled: true, ...JSON.parse(readFileSync(SETTINGS_FILE, "utf8")) };
  } catch {
    settings = { toolsEnabled: true };
  }
}

function saveSettings(): void {
  try {
    writeFileSync(SETTINGS_FILE, JSON.stringify(settings, null, 1));
  } catch {
    // ignore
  }
}

// --- scanning: refresh foreign tasks, prune old dirs ------------------------

function exitPath(id: string): string {
  return path.join(dirOf(id), "exitcode");
}

function refreshScan(metas?: Meta[]): void {
  const now = Date.now();
  for (const m of metas ?? listDiskMetas()) {
    if (own.has(m.id)) continue; // our tasks are handled by their own exit handlers
    if (m.state !== "running") {
      if (m.finishedAt && now - m.finishedAt > PRUNE_MS) rmSync(dirOf(m.id), { recursive: true, force: true });
      continue;
    }
    const heartbeatAge = now - (m.heartbeat ?? m.startedAt);
    if (m.detach && heartbeatAge > ORPHAN_MS) {
      // detached task whose owner session is gone: the wrapper writes the exit
      // code to <id>/exitcode on completion — use it as the authoritative finish
      try {
        const st = statSync(exitPath(m.id));
        const code = Number.parseInt(readFileSync(exitPath(m.id), "utf8").trim(), 10);
        if (Number.isFinite(code)) {
          writeMeta({ ...m, state: code === 0 ? "done" : "failed", exitCode: code, finishedAt: st.mtimeMs });
          if (shouldAdoptNotice(m, now)) attemptNotify(m, "scan"); // owner session gone or task is ours
          continue;
        }
      } catch {
        /* not finished yet — fall through to liveness below */
      }
      if (!pgidAlive(m.pgid)) writeMeta({ ...m, state: "gone", finishedAt: now });
      else writeMeta({ ...m, state: "orphan" });
      continue;
    }
    if (!pgidAlive(m.pgid)) {
      // owner pi died before pipes flushed, or the process vanished
      writeMeta({ ...m, state: "gone", finishedAt: now });
    } else if (heartbeatAge > ORPHAN_MS) {
      // process alive but no live instance is heartbeating/watching it
      writeMeta({ ...m, state: "orphan" });
    } else if (m.state === "orphan" && heartbeatAge <= ORPHAN_MS) {
      writeMeta({ ...m, state: "running" }); // owner came back
    }
    if (m.state === "gone" && now - (m.finishedAt ?? now) > PRUNE_MS) rmSync(dirOf(m.id), { recursive: true, force: true });
  }
}

function pruneOld(): void {
  const now = Date.now();
  for (const m of listDiskMetas()) {
    if (m.state === "running") continue;
    const end = m.finishedAt ?? now;
    if (now - end > PRUNE_MS) rmSync(dirOf(m.id), { recursive: true, force: true });
  }
}

function runningCount(metas: Meta[] = listDiskMetas()): { total: number; mine: number } {
  let total = 0;
  let mine = 0;
  for (const m of metas) {
    if (m.state !== "running") continue;
    total++;
    if (own.has(m.id)) mine++;
  }
  return { total, mine };
}

// --- widget / status --------------------------------------------------------

function renderWidget(metas: Meta[]): string[] {
  const lines: string[] = [];
  const now = Date.now();
  for (const t of own.values()) {
    const m = t.meta;
    if (m.state === "running") lines.push(`⚙️ ${m.name} · ${m.id} · ${fmtDur(now - m.startedAt)} · ${((m.bytes ?? t.bytesCurrent) / 1024).toFixed(0)}KB`);
    else if (m.finishedAt && now - m.finishedAt < 90_000)
      lines.push(`${stateIcon(m.state)} ${m.name} · ${m.id} · ${m.state}${m.exitCode != null ? ` (exit ${m.exitCode})` : ""} · ${fmtDur((m.finishedAt ?? now) - m.startedAt)}`);
  }
  for (const m of metas) {
    if (own.has(m.id) || m.state !== "running") continue;
    lines.push(`⛓ ${m.name} · ${m.id} · ${m.state} · ${fmtDur(now - m.startedAt)} (other session)`);
  }
  return lines.slice(0, 6);
}

function ensureWidgetLoop(): void {
  if (widgetTimer) return;
  widgetTimer = setInterval(() => {
    try {
      // heartbeat our running tasks so other sessions don't mark them orphan
      for (const t of own.values()) {
        if (t.meta.state !== "running") continue;
        t.meta.heartbeat = Date.now();
        if (t.meta.detach) {
          try {
            t.meta.bytes = statSync(path.join(dirOf(t.meta.id), "out.log")).size;
          } catch {
            /* ignore */
          }
        }
        writeMeta(t.meta);
      }
      const metas = listDiskMetas(); // single scan per tick, shared below
      refreshScan(metas);

      const lines = renderWidget(metas);
      const { total } = runningCount(metas);
      if (cachedUi?.setWidget) cachedUi.setWidget("bg-task", lines.length ? lines : undefined);
      if (cachedUi?.setStatus) cachedUi.setStatus("bg-task", total > 0 ? `bg:${total}` : "");
      if (total === 0 && lines.length === 0) {
        if (widgetTimer) clearInterval(widgetTimer);
        widgetTimer = null;
      }
    } catch {
      // widget must never crash the host
    }
  }, WIDGET_MS);
  if (typeof widgetTimer === "object" && "unref" in widgetTimer) widgetTimer.unref();
}

// --- core: spawn / finalize / kill ------------------------------------------

// Detect follow/stream commands — scoped per command so common `-f` flags
// (rm -f, grep -f, curl -f) and heredoc/quoted content never false-positive.
// Real streamers: container logs -f (docker/podman/kubectl/...), tail -f,
// journalctl/systemctl/dmesg -f, watch/entr, and tintin's `task logs-*`
// (the Taskfile expands them to `docker compose logs --tail N -f`).
function looksLikeFollow(cmd: string): boolean {
  // heredoc bodies and quoted strings are data, not options of the main command
  const c = cmd
    .replace(/<<-?\s*(['"]?)(\w+)\1[\s\S]*?\n\s*\2\b/g, " HEREDOC ")
    .replace(/"(?:[^"\\]|\\.)*"/g, ' "" ')
    .replace(/'(?:[^'\\]|\\.)*'/g, " '' ");
  if (!c.trim()) return false;
  return c
    .split(/\||;|&&|\|\||\n|\(|\)|`/)
    .some((seg) => {
      const tokens = seg.trim().split(/\s+/).filter(Boolean);
      if (!tokens.length) return false;
      const base = (tokens[0].split("/").pop() ?? tokens[0]).toLowerCase();
      const rest = tokens.slice(1);
      const hasF = rest.some((t) => t === "-f" || t === "--follow");
      const tailF = base === "tail" && rest.some((t) => /^-[a-z]*f/i.test(t) || t === "--follow");
      const watch = base === "watch" || base === "entr";
      const contLogs = /^(docker|podman|nerdctl)(-compose)?$/.test(base) || base === "kubectl" || base === "crictl";
      const contLogF = contLogs && rest.some((t) => /^logs?\b/.test(t)) && hasF;
      const sysdF = (base === "journalctl" || base === "systemctl" || base === "dmesg") && hasF;
      const taskLogs = base === "task" && /^logs/i.test(tokens[1] ?? ""); // tintin Taskfile
      return contLogF || tailF || watch || sysdF || taskLogs;
    });
}

function nextId(): string {
  return `${Date.now().toString(36).slice(-5)}${Math.random().toString(36).slice(2, 5)}`;
}

interface SpawnOpts {
  command: string;
  name?: string;
  timeoutMin?: number;
  detach?: boolean;
  ownerSession?: string; // full session file path of the spawning session
}

function spawnTask(opts: SpawnOpts): { ok: true; meta: Meta } | { ok: false; error: string } {
  const { total } = runningCount();
  if (total >= MAX_CONCURRENT) {
    const busy = listDiskMetas()
      .filter((m) => m.state === "running")
      .map((m) => `  ${m.id} ${m.name} (${fmtDur(Date.now() - m.startedAt)})`)
      .join("\n");
    return { ok: false, error: `background task limit reached (${MAX_CONCURRENT} running):\n${busy}\nkill one with bg_kill or wait.` };
  }

  const id = nextId();
  const meta: Meta = {
    id,
    name: opts.name?.trim() || opts.command.trim().split("\n")[0].slice(0, 40),
    cmd: opts.command,
    pid: 0,
    pgid: 0,
    startedAt: Date.now(),
    state: "running",
    owner: opts.ownerSession ? shortSession(opts.ownerSession) : ownerId(),
    ownerSession: opts.ownerSession,
    heartbeat: Date.now(),
    bytes: 0,
    detach: opts.detach === true ? true : undefined,
  };

  mkdirSync(dirOf(id), { recursive: true });
  writeMeta(meta);

  // new process group (detached) + lowest background priority
  //   pipe mode (default): output piped through a rolling write stream — bounded
  //     disk + live byte counter, but the task dies if pi exits (EPIPE).
  //   detach mode: output fd-redirected straight to out.log — survives pi exit;
  //     a wrapper appends the exit code to <id>/exitcode so any later session
  //     can finalize the task's true state. No live rotation (prune covers disk).
  let child: ChildProcess;
  try {
    const bashArgs = ["-n", "15", "ionice", "-c3", "bash", "-c"];
    if (meta.detach) {
      const fd = openSync(path.join(dirOf(id), "out.log"), "a");
      // subshell group (not braces): valid for any command body incl. trailing
      // `&`, and $? is always the group's exit code
      child = spawn("nice", [...bashArgs, `(\n${opts.command}\n) ; echo $? > '${exitPath(id)}'`], {
        detached: true,
        stdio: ["ignore", fd, fd],
      });
      try {
        closeSync(fd); // parent doesn't need it; the child holds its own copy
      } catch {
        /* ignore */
      }
    } else {
      child = spawn("nice", [...bashArgs, opts.command], {
        detached: true,
        stdio: ["ignore", "pipe", "pipe"],
      });
    }
  } catch (e) {
    writeMeta({ ...meta, state: "failed", finishedAt: Date.now(), exitCode: -1 });
    return { ok: false, error: `spawn failed: ${(e as Error).message}` };
  }
  meta.pid = child.pid ?? 0;
  meta.pgid = child.pid ?? 0; // detached => child is its own process-group leader
  writeMeta(meta);

  const task: OwnTask = {
    meta,
    child,
    stream: null as unknown as ReturnType<typeof createWriteStream>,
    bytesCurrent: 0,
    timeoutTimer: null,
    killTimer: null,
  };
  own.set(id, task);

  // rolling log: out.log (active) + out.1.log (previous), bounded disk, fixed memory
  let rotating = false;
  const openStream = () => {
    task.stream = createWriteStream(path.join(dirOf(id), "out.log"), { flags: "a" });
    task.stream.on("error", () => {
      /* ENOSPC etc — stop caring, process keeps running */
    });
  };
  openStream();
  const onData = (chunk: Buffer) => {
    if (rotating) return;
    task.bytesCurrent += chunk.length;
    meta.bytes = (meta.bytes ?? 0) + chunk.length;
    task.stream.write(chunk);
    if (task.bytesCurrent >= ROTATE_BYTES) {
      rotating = true;
      task.stream.end(() => {
        try {
          renameSync(path.join(dirOf(id), "out.log"), path.join(dirOf(id), "out.1.log"));
        } catch {
          /* ignore */
        }
        task.bytesCurrent = 0;
        openStream();
        rotating = false;
      });
    }
  };
  child.stdout?.on("data", onData);
  child.stderr?.on("data", onData);

  const timeoutMin = opts.timeoutMin ?? DEFAULT_TIMEOUT_MIN;
  if (timeoutMin > 0) {
    task.timeoutTimer = setTimeout(() => {
      if (meta.state !== "running") return;
      meta.state = "timeout";
      killGroup(meta);
    }, timeoutMin * 60_000);
    if (typeof task.timeoutTimer.unref === "function") task.timeoutTimer.unref();
  }

  child.on("exit", (code, signal) => {
    if (task.timeoutTimer) clearTimeout(task.timeoutTimer);
    if (task.killTimer) clearTimeout(task.killTimer);
    try {
      task.stream?.end();
    } catch {
      /* ignore */
    }
    if (meta.state === "running") meta.state = code === 0 ? "done" : "failed";
    meta.exitCode = code;
    meta.signal = signal;
    meta.finishedAt = Date.now();
    writeMeta(meta);
    own.delete(id);

    attemptNotify(meta, "exit");
    if (typeof notify === "function") notify(`${stateIcon(meta.state)} bg '${meta.name}' ${meta.state}`, meta.state === "done" ? "info" : "warning");
  });
  child.on("error", () => {
    /* spawn-level async error; exit event will still fire */
  });

  ensureWidgetLoop();
  return { ok: true, meta };
}

// Deliver the "task finished" notice to this session via pi.sendMessage.
// ALWAYS late-bound (read piApi.sendMessage at call time): pi hands extensions
// a notInitialized placeholder at load and swaps in the real one afterwards —
// a captured reference throws silently (the bug behind lost notifications).
function attemptNotify(m: Meta, via: string): void {
  if (m.notifiedAt) return;
  m.notifyTries = (m.notifyTries ?? 0) + 1;
  const cross = isCrossSession(m);
  const tail = tailLog(m.id, 5, 600);
  const content = [
    `Background task '${m.name}' (${m.id}) finished: ${m.state}${m.exitCode != null ? ` exit=${m.exitCode}` : ""} after ${fmtDur((m.finishedAt ?? Date.now()) - m.startedAt)}.${cross ? " (from another session)" : ""}`,
    tail ? `Last output:\n${tail}` : "",
    `Full log: ${dirOf(m.id)}/out.log — inspect with bg_log, results on disk stay until pruned.`,
  ]
    .filter(Boolean)
    .join("\n");
  const api = piApi;
  let outcome = "sendMessage unavailable";
  if (api && typeof api.sendMessage === "function") {
    try {
      (api.sendMessage as unknown as (msg: unknown, opts: unknown) => void)(
        { customType: "bg-task", display: true, content, details: { id: m.id, state: m.state, exitCode: m.exitCode ?? null } },
        { deliverAs: "followUp", triggerTurn: true },
      );
      outcome = "sent";
    } catch (e) {
      outcome = `FAILED: ${(e as Error).message}`;
    }
  }
  debugLog(`notify[${via}] id=${m.id} '${m.name}' state=${m.state} tries=${m.notifyTries} -> ${outcome}`);
  if (outcome === "sent" || m.notifyTries >= 3) m.notifiedAt = Date.now();
  writeMeta(m);
}

function killGroup(meta: Meta): void {
  const sigterm = (): boolean => {
    try {
      process.kill(-meta.pgid, "SIGTERM");
      return true;
    } catch {
      try {
        process.kill(meta.pid, "SIGTERM"); // maybe not a group leader after all
        return true;
      } catch {
        return false;
      }
    }
  };
  sigterm();
  const t = setTimeout(() => {
    if (!pgidAlive(meta.pgid)) return;
    try {
      process.kill(-meta.pgid, "SIGKILL");
    } catch {
      try {
        process.kill(meta.pid, "SIGKILL");
      } catch {
        /* already gone */
      }
    }
  }, KILL_ESCALATE_MS);
  if (typeof t.unref === "function") t.unref();
}

// --- log reading ------------------------------------------------------------

function readWholeLog(id: string): string {
  let text = "";
  for (const f of ["out.1.log", "out.log"]) {
    try {
      text += readFileSync(path.join(dirOf(id), f), "utf8");
    } catch {
      /* missing rotation file is normal */
    }
  }
  return text;
}

function tailLog(id: string, lines: number, maxChars: number): string {
  const text = readWholeLog(id);
  if (!text.trim()) return "";
  const arr = text.split("\n");
  return clampChars(arr.slice(Math.max(0, arr.length - lines)).join("\n"), maxChars);
}

// --- artifact summarizing (token-safe) ---------------------------------------

function typeOf(v: unknown): string {
  if (v === null) return "null";
  if (Array.isArray(v)) return "array";
  if (typeof v === "number") return Number.isInteger(v) ? "int" : "float";
  return typeof v;
}

function shapeOf(v: unknown): string {
  if (v === null || typeof v !== "object") return typeOf(v);
  if (Array.isArray(v)) return v.length ? `array[${v.length}] of ${typeOf(v[0])}` : "array[0]";
  const keys = Object.keys(v);
  return keys.length <= 6 ? `object{${keys.join(",")}}` : `object{${keys.slice(0, 6).join(",")},+${keys.length - 6} more}`;
}

function summarizeValue(v: unknown, maxChars: number): string {
  if (v === null || typeof v !== "object") return clampChars(JSON.stringify(v) ?? "null", 120);
  return clampChars(shapeOf(v), maxChars);
}

function artifactSummary(file: string, maxEntries: number): string {
  let stat: { size: number; mtime: Date };
  try {
    const st = statSync(file);
    stat = { size: st.size, mtime: st.mtime };
  } catch {
    return `error: file not found: ${file}`;
  }
  const head = `${file}\nsize: ${(stat.size / 1024).toFixed(1)}KB · modified: ${stat.mtime.toISOString()}`;

  // too big to parse — raw head/tail only (fd reads, never the whole file)
  if (stat.size > ARTIFACT_PARSE_LIMIT) {
    return `${head} (too large to parse — raw preview)\n${clampChars(openHeadTail(file), MAX_OUTPUT_CHARS)}`;
  }

  const text = readFileSync(file, "utf8");
  const lines = text.split("\n");
  const ext = path.extname(file).toLowerCase();

  // JSON
  if (ext === ".json" || /^\s*[[{]/.test(text)) {
    try {
      const v = JSON.parse(text) as unknown;
      if (Array.isArray(v)) {
        const items = v.slice(0, maxEntries).map((it, i) => `  [${i}] ${clampChars(JSON.stringify(it) ?? "?", 400)}`);
        return [
          `${head}`,
          `type: JSON array[${v.length}]`,
          v.length ? `item shape: ${shapeOf(v[0])}` : "",
          `first ${items.length} entr${items.length === 1 ? "y" : "ies"}:`,
          ...items,
        ].filter(Boolean).join("\n");
      }
      if (v && typeof v === "object") {
        const entries = Object.entries(v as Record<string, unknown>).slice(0, 20).map(([k, val]) => `  ${k}: ${summarizeValue(val, 200)}`);
        return [`${head}`, `type: JSON object{${Object.keys(v as object).length} keys}`, ...entries].join("\n");
      }
      return `${head}\ntype: JSON scalar — ${clampChars(JSON.stringify(v) ?? "?", 200)}`;
    } catch {
      // fall through to text/JSONL handling
    }
  }

  // JSONL
  const nonEmpty = lines.filter((l) => l.trim());
  if (ext === ".jsonl" || (nonEmpty.length > 1 && nonEmpty.every((l) => /^\s*\{/.test(l)))) {
    const parsed: unknown[] = [];
    for (const l of nonEmpty) {
      try {
        parsed.push(JSON.parse(l) as unknown);
      } catch {
        break;
      }
    }
    if (parsed.length) {
      const items = parsed.slice(0, Math.min(maxEntries, 2)).map((it, i) => `  [${i}] ${clampChars(JSON.stringify(it) ?? "?", 300)}`);
      return [`${head}`, `type: JSONL, ${nonEmpty.length} records`, `record shape: ${shapeOf(parsed[0])}`, ...items].join("\n");
    }
  }

  // CSV
  if (ext === ".csv" || (nonEmpty.length > 1 && (nonEmpty[0].match(/,/g)?.length ?? 0) >= 1 && (nonEmpty[1].match(/,/g)?.length ?? 0) === (nonEmpty[0].match(/,/g)?.length ?? 0))) {
    const cols = nonEmpty[0].split(",");
    const rows = nonEmpty.slice(1, 1 + maxEntries).map((r) => `  ${clampChars(r, 300)}`);
    return [`${head}`, `type: CSV — ${cols.length} columns, ~${nonEmpty.length - 1} rows`, `columns: ${cols.join(", ")}`, ...rows].join("\n");
  }

  // plain text
  return [
    head,
    `type: text — ${lines.length} lines`,
    nonEmpty.length ? `head:\n${clampChars(lines.slice(0, 8).join("\n"), 1200)}` : "(empty)",
    lines.length > 12 ? `tail:\n${clampChars(lines.slice(-4).join("\n"), 800)}` : "",
  ].filter(Boolean).join("\n");
}

// head+tail preview for oversized files — reads only ~2.3KB via fd, O(1) memory
function openHeadTail(file: string): string {
  const { openSync, readSync, closeSync, fstatSync } = require("node:fs") as typeof import("node:fs");
  let fd: number | undefined;
  try {
    fd = openSync(file, "r");
    const size = fstatSync(fd).size;
    const headBuf = Buffer.alloc(Math.min(1500, size));
    readSync(fd, headBuf, 0, headBuf.length, 0);
    const tailLen = Math.min(800, size);
    const tailBuf = Buffer.alloc(tailLen);
    readSync(fd, tailBuf, 0, tailLen, size - tailLen);
    return `head:\n${headBuf.toString("utf8")}\n…\ntail:\n${tailBuf.toString("utf8")}`;
  } finally {
    if (fd !== undefined) closeSync(fd);
  }
}

// --- tools ------------------------------------------------------------------

function taskLine(m: Meta): string {
  const now = Date.now();
  const dur = m.finishedAt ? fmtDur(m.finishedAt - m.startedAt) : fmtDur(now - m.startedAt);
  const flag = own.has(m.id) || (m.ownerSession && m.ownerSession === currentSessionFile) ? " [this session]" : "";
  const exit = m.exitCode != null && m.exitCode !== 0 ? ` exit=${m.exitCode}` : "";
  return `${stateIcon(m.state)} ${m.id} · ${m.name} · ${m.state}${exit} · ${dur}${flag}`;
}

function bgListText(): string {
  refreshScan();
  const metas = listDiskMetas();
  if (!metas.length) return "no background tasks (state: " + STATE_DIR + ")";
  const { total } = runningCount();
  const head = `${metas.length} task(s), ${total} running (limit ${MAX_CONCURRENT}) · interceptor: ${INTERCEPTOR_MODE}:\n`;
  return clampChars(head + metas.slice(0, 20).map((m) => taskLine(m, own.has(m.id))).join("\n"), MAX_OUTPUT_CHARS);
}

function bgDetailText(id: string): string {
  const t = own.get(id);
  const m = t?.meta ?? readMeta(id);
  if (!m) return `task '${id}' not found — use bg_status without args to list tasks`;
  const now = Date.now();
  const dur = m.finishedAt ? `ran ${fmtDur(m.finishedAt - m.startedAt)}` : `running for ${fmtDur(now - m.startedAt)}`;
  const gs = m.state === "running" ? groupStats(m.pgid, (now - m.startedAt) / 1000) : null;
  const last = m.state === "running" ? tailLog(id, 3, 500) : tailLog(id, 5, 800);
  return clampChars(
    [
      `${stateIcon(m.state)} ${m.id} '${m.name}' — ${m.state}, ${dur}`,
      `cmd: ${m.cmd.slice(0, 200)}`,
      `pid/pgid: ${m.pid}/${m.pgid} · cpu: ${gs ? `${gs.cpuPct}%` : "-"} · rss: ${gs ? `${gs.rssMb}MB` : "-"} · output: ${((m.bytes ?? 0) / 1024).toFixed(1)}KB · owner: ${m.ownerSession ? shortSession(m.ownerSession) : m.owner}${m.detach ? " · detached (survives pi restart)" : ""}`,
      `log: ${dirOf(id)}/out.log`,
      last ? `last output:\n${last}` : "(no output yet)",
    ].join("\n"),
    MAX_OUTPUT_CHARS,
  );
}

// --- registration -----------------------------------------------------------

export default function bgTaskExtension(pi: ExtensionAPI): void {
  loadSettings();
  mkdirSync(STATE_DIR, { recursive: true });
  notify = null;
  piApi = pi;

  const disabled = () => textResult("bg tools are disabled (/bg on to enable)");

  pi.registerTool({
    name: "bg_run",
    label: "Background run",
    description:
      "Run a shell command in the BACKGROUND without blocking the conversation. Returns a task id immediately and you will be notified when it exits. Use for long jobs (builds, test suites, searches, log following); monitor with bg_status / bg_log, stop with bg_kill.",
    parameters: Type.Object({
      command: Type.String({ description: "Shell command to run in the background" }),
      name: Type.Optional(Type.String({ description: "Short label for the task (shown in the status widget)" })),
      timeout_min: Type.Optional(Type.Number({ description: `Kill the task after N minutes (default: ${DEFAULT_TIMEOUT_MIN || "none"}). Useful to bound exploratory scripts.` })),
      detach: Type.Optional(Type.Boolean({ description: "Survive pi restarts: output goes straight to the log file (no live rotation) and the exit code is recorded on completion" })),
    }),
    execute: (...cbArgs: unknown[]) => {
      const params = extractToolArgs(cbArgs) as Record<string, unknown>;
      if (!settings.toolsEnabled) return disabled();
      const missing = requireString(params, "command");
      if (missing) return textResult(missing.errorText);
      const res = spawnTask({
        command: String(params.command),
        name: params.name != null ? String(params.name) : undefined,
        timeoutMin: params.timeout_min != null ? Number(params.timeout_min) : undefined,
        detach: params.detach === true,
        ownerSession: typeof cbArgs[4] === "object" && cbArgs[4] !== null
          ? (cbArgs[4] as { sessionManager?: { getSessionFile?: () => string | undefined } }).sessionManager?.getSessionFile?.()
          : undefined,
      });
      if (!res.ok) return textResult(`error: ${res.error}`);
      const warn = looksLikeFollow(String(params.command))
        ? "\n⚠️ warning: this command looks like follow/stream mode (-f/--follow/watch) and may NEVER exit on its own. That is fine for background tasks (you will not be blocked), but kill it with bg_kill when you have what you need."
        : "";
      return textResult(
        `started background task '${res.meta.name}' (id: ${res.meta.id}, pid: ${res.meta.pid})\nlog: ${dirOf(res.meta.id)}/out.log\nconversation continues — monitor with bg_status, read output with bg_log, stop with bg_kill.${warn}`,
      );
    },
  });

  pi.registerTool({
    name: "bg_status",
    label: "Background status",
    description:
      "Check background tasks. With id: state, elapsed, exit code, last output. Without id: list ALL tasks across every pi session on this machine (marked [this session] where applicable).",
    parameters: Type.Object({
      id: Type.Optional(Type.String({ description: "Task id from bg_run (omit to list all tasks)" })),
    }),
    execute: (...cbArgs: unknown[]) => {
      const params = extractToolArgs(cbArgs) as Record<string, unknown>;
      if (!settings.toolsEnabled) return disabled();
      if (typeof params.id === "string" && params.id.trim()) return textResult(bgDetailText(params.id.trim()));
      return textResult(bgListText());
    },
  });

  pi.registerTool({
    name: "bg_log",
    label: "Background log",
    description: "Read recent output (stdout+stderr) of a background task. Returns the tail only — cheap even when the task printed megabytes. Use bg_status first to see state.",
    parameters: Type.Object({
      id: Type.String({ description: "Task id from bg_run" }),
      tail_lines: Type.Optional(Type.Number({ description: "Number of trailing lines to return (default 50, max 400)", minimum: 1, maximum: 400 })),
    }),
    execute: (...cbArgs: unknown[]) => {
      const params = extractToolArgs(cbArgs) as Record<string, unknown>;
      if (!settings.toolsEnabled) return disabled();
      const missing = requireString(params, "id");
      if (missing) return textResult(missing.errorText);
      const id = String(params.id).trim();
      const m = readMeta(id);
      if (!m) return textResult(`task '${id}' not found — use bg_status without args to list tasks`);
      const lines = Math.min(400, Math.max(1, Number(params.tail_lines) || 50));
      const text = tailLog(id, lines, MAX_OUTPUT_CHARS);
      return textResult(text ? `bg '${m.name}' (${m.state}) — last ${lines} lines:\n${text}` : `bg '${m.name}' (${m.state}) has no output yet`);
    },
  });

  pi.registerTool({
    name: "bg_artifact",
    label: "Background artifact",
    description:
      "Token-safe summary of a result file: JSON → array length + item shape + first entries; JSONL → record count; CSV → columns + rows + samples; text → head/tail. Never dumps the whole file — use instead of reading large outputs into context.",
    parameters: Type.Object({
      path: Type.Optional(Type.String({ description: "Path to the file (required unless id points at the task's output log)" })),
      id: Type.Optional(Type.String({ description: "Task id from bg_run — with no path, summarizes that task's captured output" })),
      max_entries: Type.Optional(Type.Number({ description: "Sample entries to show (default 3, max 10)", minimum: 1, maximum: 10 })),
    }),
    execute: (...cbArgs: unknown[]) => {
      const params = extractToolArgs(cbArgs) as Record<string, unknown>;
      if (!settings.toolsEnabled) return disabled();
      const id = typeof params.id === "string" ? params.id.trim() : "";
      const pathArg = typeof params.path === "string" ? params.path.trim() : "";
      if (!pathArg && !id) return textResult("error: provide 'path' (file to inspect) or 'id' (task whose output to inspect)");
      let file = pathArg;
      if (!file) {
        const m = readMeta(id);
        if (!m) return textResult(`task '${id}' not found — use bg_status without args to list tasks`);
        file = existsSync(path.join(dirOf(id), "out.log")) ? path.join(dirOf(id), "out.log") : path.join(dirOf(id), "out.1.log");
      }
      if (!path.isAbsolute(file) && !existsSync(file)) {
        // relative path might be relative to the task's original cwd context — try cwd first (default), that's it
        return textResult(`error: file not found: ${file} (relative paths resolve against pi's cwd)`);
      }
      const maxEntries = Math.min(10, Math.max(1, Math.round(Number(params.max_entries) || 3)));
      try {
        return textResult(clampChars(artifactSummary(file, maxEntries), MAX_OUTPUT_CHARS));
      } catch (e) {
        return textResult(`error: cannot summarize ${file}: ${(e as Error).message}`);
      }
    },
  });

  pi.registerTool({
    name: "bg_kill",
    label: "Background kill",
    description:
      "Stop a background task by id. Kills the ENTIRE process group — no orphaned children. Works on tasks from any pi session, including orphans whose session is gone.",
    parameters: Type.Object({
      id: Type.String({ description: "Task id from bg_run" }),
    }),
    execute: (...cbArgs: unknown[]) => {
      const params = extractToolArgs(cbArgs) as Record<string, unknown>;
      if (!settings.toolsEnabled) return disabled();
      const missing = requireString(params, "id");
      if (missing) return textResult(missing.errorText);
      const id = String(params.id).trim();
      const t = own.get(id);
      const m = t?.meta ?? readMeta(id);
      if (!m) return textResult(`task '${id}' not found — use bg_status without args to list tasks`);
      if (m.state !== "running" && m.state !== "orphan") return textResult(`task '${id}' (${m.name}) already finished: ${m.state}`);
      const wasRunning = m.state === "running" || m.state === "orphan";
      // mark killed BEFORE the signal: the exit handler must not overwrite it
      if (t) t.meta.state = "killed";
      else writeMeta({ ...m, state: "killed" });
      if (wasRunning) killGroup(m);
      return textResult(`sent SIGTERM to process group ${m.pgid} (task '${m.name}', id: ${id}); escalates to SIGKILL in ${KILL_ESCALATE_MS / 1000}s if still alive. Verify with bg_status ${id}.`);
    },
  });

  // --- /bg command ----------------------------------------------------------

  pi.registerCommand("bg", {
    description: "Background tasks: picker, kill, toggle tools",
    handler: async (args: string, ctx: { ui?: { notify?: (m: string, l: string) => void; confirm?: (t: string, m: string) => Promise<boolean>; select?: (title: string, options: string[]) => Promise<string | undefined> } }) => {
      if (ctx?.ui) {
        cachedUi = ctx.ui as typeof cachedUi;
        if (typeof ctx.ui.notify === "function") notify = ctx.ui.notify;
      }
      const sub = (args || "").trim();

      if (sub === "on" || sub === "off") {
        settings.toolsEnabled = sub === "on";
        saveSettings();
        ctx?.ui?.notify?.(`bg tools ${sub} (interceptor ${sub === "on" ? "active" : "disabled"} too)`, "info");
        return;
      }

      if (sub.startsWith("kill")) {
        const id = sub.replace(/^kill\s*/, "").trim();
        if (!id) {
          ctx?.ui?.notify?.("usage: /bg kill <id>  (see /bg for ids)", "warning");
          return;
        }
        const m = own.get(id)?.meta ?? readMeta(id);
        if (!m || (m.state !== "running" && m.state !== "orphan")) {
          ctx?.ui?.notify?.(`task '${id}' not running`, "warning");
          return;
        }
        if (ctx?.ui?.confirm && !(await ctx.ui.confirm("Kill background task?", `${m.name} (${m.id}, pgid ${m.pgid})`))) return;
        if (own.has(id)) own.get(id)!.meta.state = "killed";
        else writeMeta({ ...m, state: "killed" });
        killGroup(m); // unconditional here: state was running/orphan (checked above)
        ctx?.ui?.notify?.(`SIGTERM sent to '${m.name}' (${id})`, "info");
        return;
      }

      // default: interactive picker (TUI + pi-web), plain list as fallback
      refreshScan();
      const metas = listDiskMetas();
      if (!metas.length) {
        ctx?.ui?.notify?.("no background tasks", "info");
        return;
      }
      if (typeof ctx?.ui?.select === "function") {
        const sorted = [...metas].sort((a, b) => Number(a.state === "running") - Number(b.state === "running"));
        const pick = await ctx.ui.select("Background tasks (pick to inspect/kill)", [...sorted.map((m) => taskLine(m, own.has(m.id))), "✖ close"]);
        if (!pick || pick === "✖ close") return;
        const id = pick.split("·")[1]?.trim().split(" ")[0] ?? "";
        const m = own.get(id)?.meta ?? readMeta(id);
        if (!m) return;
        if (m.state === "running" || m.state === "orphan") {
          if (await ctx.ui.confirm?.("Kill this background task?", `${m.name} (${m.id}, pgid ${m.pgid})`)) {
            if (own.has(id)) own.get(id)!.meta.state = "killed";
            else writeMeta({ ...m, state: "killed" });
            killGroup(m);
            ctx.ui.notify?.(`SIGTERM sent to '${m.name}' (${m.id})`, "info");
            return;
          }
        }
        ctx.ui.notify?.(bgDetailText(id), "info");
        return;
      }
      ctx?.ui?.notify?.(bgListText(), "info");
    },
  });

  // --- follow-mode interceptor (built-in bash tool) --------------------------
  // Warn ONCE per unique command: block with guidance so the model can switch
  // to bg_run (or add `timeout`). If the model repeats the EXACT command, allow
  // it — warn, let the model decide. Disable with PI_BG_INTERCEPTOR=off.
  if (INTERCEPTOR_MODE !== "off") {
    const warned = new Map<string, number>(); // cmd -> timestamp of first block
    pi.on("tool_call", async (event: { toolName?: string; input?: { command?: unknown } }, ctx?: { ui?: { notify?: (m: string, l: string) => void } }) => {
      try {
        if (!settings.toolsEnabled) return undefined; // /bg off gates the interceptor too
        if (event?.toolName !== "bash") return undefined;
        const cmd = typeof event.input?.command === "string" ? event.input.command : "";
        if (!cmd || !looksLikeFollow(cmd)) return undefined;
        if (/^\s*timeout\s/.test(cmd)) return undefined; // explicitly bounded — fine
        // auto-bg mode: a blocking call to a follow command is ALWAYS wrong (pi
        // only sees output when the process exits — follow never exits), so
        // redirect it into a background task directly. Zero extra round trips.
        if (INTERCEPTOR_MODE === "auto-bg" || INTERCEPTOR_MODE === "auto") {
          const res = spawnTask({ command: cmd, name: `auto:${cmd.trim().split("\n")[0].slice(0, 30)}` });
          return {
            block: true,
            reason: res.ok
              ? `bg-task auto-bg: started as background task '${res.meta.name}' (id: ${res.meta.id}). Monitor with bg_status, read with bg_log, stop with bg_kill. (PI_BG_INTERCEPTOR=auto-bg)`
              : `bg-task auto-bg failed (${res.error}) — run it via bg_run yourself, or prefix with 'timeout N'.`,
          };
        }
        const key = cmd.trim();
        const now = Date.now();
        for (const [k, t] of warned) if (now - t > 3_600_000) warned.delete(k);
        if (warned.has(key)) {
          warned.delete(key); // model insisted — let it through, tell the user
          ctx?.ui?.notify?.("bg-task: follow-mode command allowed on retry", "warning");
          return undefined;
        }
        warned.set(key, now);
        ctx?.ui?.notify?.("bg-task: blocked a follow-mode bash call once (model decides)", "warning");
        return {
          block: true,
          reason:
            "⚠️ bg-task: follow-mode command (-f/--follow/watch) never exits — blocking would hang this session. Run it via bg_run (recommended), prefix with 'timeout N', or repeat this exact command to force-run.",
        };
      } catch {
        return undefined; // interceptor must never break execution
      }
    });
  }

  // reload-proof finish notices. Strict ownership: a session only reports its
  // OWN tasks; foreign tasks are surfaced only when their owner session is
  // gone (file deleted) or past ADOPT_GRACE_MS without any notification
  // (a live owner's exit handler notifies within milliseconds).
  pi.on("session_start", async (_event: unknown, ctx: unknown) => {
    try {
      const sf = (ctx as { sessionManager?: { getSessionFile?: () => string | undefined } } | undefined)?.sessionManager?.getSessionFile?.();
      if (sf) currentSessionFile = sf;
      const metas = listDiskMetas();
      refreshScan(metas);
      const now = Date.now();
      const pending = metas.filter((m) => m.state !== "running" && !m.notifiedAt && m.finishedAt && now - m.finishedAt < PRUNE_MS && shouldAdoptNotice(m, now));
      if (!pending.length || !piApi || typeof piApi.sendMessage !== "function") return;
      const lines = pending.slice(0, 5).map((m) => `${stateIcon(m.state)} ${m.name} (${m.id}) — ${m.state}${m.exitCode != null ? `, exit=${m.exitCode}` : ""}, ran ${fmtDur(m.finishedAt - m.startedAt)}${isCrossSession(m) ? " · from another session" : ""}`);
      (piApi.sendMessage as unknown as (msg: unknown, opts: unknown) => void)(
        {
          customType: "bg-task",
          display: true,
          content: `Background task${pending.length === 1 ? "" : "s"} finished since you were away:\n${lines.join("\n")}\nInspect with bg_status / bg_log.`,
          details: { ids: pending.map((m) => m.id) },
        },
        { deliverAs: "followUp", triggerTurn: true },
      );
      for (const m of pending) {
        m.notifiedAt = now;
        writeMeta(m);
      }
      debugLog(`session_start: surfaced ${pending.length} finished task(s)`);
    } catch (e) {
      debugLog(`session_start notice failed: ${(e as Error).message}`);
    }
  });

  // housekeeping on load + hourly
  refreshScan();
  pruneOld();
  const housekeeper = setInterval(() => {
    try {
      refreshScan();
      pruneOld();
    } catch {
      /* never crash the host */
    }
  }, 3_600_000);
  if (typeof housekeeper.unref === "function") housekeeper.unref();
}
