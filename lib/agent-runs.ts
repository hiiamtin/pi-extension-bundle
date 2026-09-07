// Notification and session-tracking machinery for background subagent runs.
//
// Lifted from extensions/bg-task.ts (which stays untouched — the duplication
// is documented debt, see docs/subagent.md §8) and adapted to the subagent
// run shape. Invariants preserved verbatim:
//   - session→api mapping is claimed by monotonic capture `seq`, never array
//     position (the capture list cap splices, which broke a positional cursor);
//   - strict per-session notice ownership (`canNotifyHere`): foreign finished
//     runs are adopted only when the owner session file is gone;
//   - `notifiedAt` is set ONLY on real delivery — it blocks the guaranteed
//     channels (sweep on session activation, context-hook injection);
//   - capture registries live on `globalThis` so they survive module re-eval
//     (pi-web reloads extensions in one process);
//   - sendMessage is late-bound at send time, never captured for later use.

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

export const ADOPT_GRACE_MS = 60_000;
export const NOTIFY_MAX_TRIES = 12;
export const SWEEP_CAP = 5;
export const DEFAULT_PRUNE_MS = 7 * 24 * 3_600_000;
const DEBUG_LOG_CAP = 48_000;
const NOTICE_TAIL_CHARS = 600;

// Minimal meta shape the machinery needs (RunMeta in subagent.ts satisfies it
// structurally — the lib never needs the full type).
export interface RunNoticeMeta {
  id: string;
  agent: string;
  state: string;
  pgid: number;
  startedAt: number;
  finishedAt?: number;
  exitCode?: number | null;
  error?: string;
  ownerSession?: string;
  notifiedAt?: number;
  notifyTries?: number;
  resultPath: string;
}

export interface RunsIo {
  list: () => RunNoticeMeta[];
  save: (meta: RunNoticeMeta) => void;
  remove?: (id: string) => void;
  read?: (id: string) => RunNoticeMeta | null;
}

// --- debug log (self-capped: rewrite-truncate to a fixed budget) ------------

const DEBUG_LOG = process.env.PI_SUBAGENT_DEBUG_LOG || path.join(os.homedir(), ".pi/agent/log/subagent-debug.log");

export function debugLog(line: string): void {
  try {
    mkdirSync(path.dirname(DEBUG_LOG), { recursive: true });
    let text = `${new Date().toISOString()} ${line}\n`;
    if (existsSync(DEBUG_LOG)) text = readFileSync(DEBUG_LOG, "utf8").slice(-DEBUG_LOG_CAP) + text;
    writeFileSync(DEBUG_LOG, text);
  } catch {
    // logging must never break the host
  }
}

// --- capture registry (globalThis: survives module re-eval) -----------------

const g = globalThis as {
  __subagentCaptures?: Array<{ pi: ExtensionAPI; at: number; seq: number }>;
  __subagentSeq?: number;
  __subagentClaimedSeq?: number;
};
const capturedPis = (g.__subagentCaptures ??= []);
g.__subagentSeq ??= 0;
g.__subagentClaimedSeq ??= 0;

let currentSessionFile: string | undefined;
let eventCtx: { sendMessage?: unknown } | null = null;

const seenSessionFiles = new Set<string>();
const isSingleSession = () => seenSessionFiles.size <= 1;

// session → api mapping: the loader runs the factory for a session a few ms
// BEFORE that session's session_start, so each session_start claims every
// not-yet-claimed capture since the previous claim — matched by monotonic
// `seq`, never array position.
const sessionApis = new Map<string, Array<{ pi: ExtensionAPI; at: number; seq: number }>>();

function associateCapturesWith(sessionFile: string): void {
  const claimed = capturedPis.filter((capture) => capture.seq > (g.__subagentClaimedSeq ?? 0));
  if (!claimed.length) return;
  const existing = sessionApis.get(sessionFile);
  if (existing) existing.push(...claimed);
  else {
    while (sessionApis.size >= 64) {
      const oldest = sessionApis.keys().next().value;
      if (oldest === undefined) break;
      sessionApis.delete(oldest);
    }
    sessionApis.set(sessionFile, [...claimed]);
  }
  g.__subagentClaimedSeq = Math.max(g.__subagentClaimedSeq ?? 0, ...claimed.map((capture) => capture.seq));
}

export function captureExtensionApi(pi: ExtensionAPI): void {
  capturedPis.push({ pi, at: Date.now(), seq: ++g.__subagentSeq! });
  if (capturedPis.length > 64) capturedPis.splice(0, capturedPis.length - 64);
}

// Record the session making this event; return its session file if known.
export function trackSession(ctx: unknown): string | undefined {
  const sessionFile = (ctx as { sessionManager?: { getSessionFile?: () => string | undefined } } | undefined)
    ?.sessionManager?.getSessionFile?.();
  if (sessionFile) {
    seenSessionFiles.add(sessionFile);
    associateCapturesWith(sessionFile);
    currentSessionFile = sessionFile;
  }
  if (ctx) eventCtx = ctx as { sendMessage?: unknown };
  return sessionFile;
}

// --- ownership ---------------------------------------------------------------

// Whose notice is this? Sessions are separated by their session FILE. Strict
// ownership: deliver only to the owning session; adopt a foreign run only
// when the owner session file has been deleted. Runs without an owner keep a
// grace rule (adoptable elsewhere after ADOPT_GRACE_MS).
export function canNotifyHere(
  ownerSession: string | undefined,
  finishedAt: number | undefined,
  now: number,
  currentSessionFile?: string,
): boolean {
  if (!ownerSession) return now - (finishedAt ?? now) > ADOPT_GRACE_MS;
  if (currentSessionFile && ownerSession === currentSessionFile) return true;
  return !existsSync(ownerSession);
}

// --- delivery -----------------------------------------------------------------

// Deliver through the first WORKING sendMessage. Every candidate is late-bound:
//   1. apis claimed by `target` (the message lands in exactly that session);
//   2. single-session fallback: the last event ctx, then all captured apis
//      newest-first (any bound api belongs to the only session ever seen).
// The blind fallback must additionally respect ownership (fallbackAllowed):
// otherwise a restarted single-session host would leak another session's
// notice into the one session it knows.
export function sendToSession(message: unknown, opts: unknown, target?: string, fallbackAllowed = true): { ok: boolean; outcome: string } {
  const tried: string[] = [];
  let outcome = "sendMessage unavailable";
  const trySend = (label: string, fn: unknown): boolean => {
    if (typeof fn !== "function") return false;
    tried.push(label);
    try {
      (fn as (msg: unknown, sendOpts: unknown) => void)(message, opts);
      return true;
    } catch (error) {
      outcome = `FAILED via ${label}: ${(error as Error).message}`.slice(0, 300);
      return false;
    }
  };
  if (target) {
    const apis = sessionApis.get(target);
    if (apis?.length) {
      for (let index = apis.length - 1; index >= 0; index--) {
        if (trySend(`pi(@${apis[index].at})→target`, apis[index].pi.sendMessage)) {
          return { ok: true, outcome: "sent via targeted session api" };
        }
      }
    }
  }
  if (fallbackAllowed && isSingleSession()) {
    if (eventCtx?.sendMessage && trySend("event ctx", eventCtx.sendMessage)) return { ok: true, outcome: "sent via event ctx" };
    for (let index = capturedPis.length - 1; index >= 0; index--) {
      const capture = capturedPis[index];
      if (capture && trySend(`pi#${index}(@${capture.at})`, capture.pi.sendMessage)) return { ok: true, outcome: `sent via pi#${index}` };
    }
  }
  if (tried.length) outcome += ` [tried: ${tried.join(", ")}]`;
  return { ok: false, outcome };
}

function fmtDur(ms: number): string {
  const seconds = Math.max(0, Math.round(ms / 1000));
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m${String(seconds % 60).padStart(2, "0")}s`;
  return `${Math.floor(minutes / 60)}h${String(minutes % 60).padStart(2, "0")}m`;
}

function resultTail(resultPath: string, maxChars = NOTICE_TAIL_CHARS): string {
  try {
    const text = readFileSync(resultPath, "utf8").trim();
    return text.length <= maxChars ? text : `…${text.slice(-maxChars)}`;
  } catch {
    return "";
  }
}

export function buildRunNotice(meta: RunNoticeMeta, now = Date.now()): { content: string; details: Record<string, unknown> } {
  const duration = fmtDur((meta.finishedAt ?? now) - meta.startedAt);
  const content = [
    `Background subagent '${meta.agent}' (${meta.id}) finished: ${meta.state}${meta.exitCode != null ? `, exit=${meta.exitCode}` : ""} after ${duration}.${meta.error ? ` Error: ${meta.error}` : ""}`,
    resultTail(meta.resultPath) && `Last output:\n${resultTail(meta.resultPath)}`,
    `Full result: ${meta.resultPath} — continue with subagent({ continue: "${meta.id}", task: "..." })`,
  ].filter(Boolean).join("\n");
  return { content, details: { id: meta.id, agent: meta.agent, state: meta.state } };
}

// Push one finished run's notice. notifiedAt is set ONLY on real delivery —
// failed pushes stay pending for the guaranteed channels (sweep, context pump).
export function deliverRunNotice(meta: RunNoticeMeta, io: RunsIo, now = Date.now()): { ok: boolean; outcome: string } {
  if (meta.notifiedAt) return { ok: false, outcome: "already notified" };
  if ((meta.notifyTries ?? 0) >= NOTIFY_MAX_TRIES) return { ok: false, outcome: "push tries exhausted" };
  const target = meta.ownerSession;
  meta.notifyTries = (meta.notifyTries ?? 0) + 1;
  const foregroundOwner = !!target && target === currentSessionFile;
  const fallbackAllowed = !target || foregroundOwner || !existsSync(target);
  const { content, details } = buildRunNotice(meta, now);
  const { ok, outcome } = sendToSession(
    { customType: "subagent-run", display: true, content, details },
    foregroundOwner ? { deliverAs: "followUp", triggerTurn: true } : { deliverAs: "nextTurn", triggerTurn: false },
    target,
    fallbackAllowed,
  );
  debugLog(`notify id=${meta.id} agent=${meta.agent} state=${meta.state} tries=${meta.notifyTries} -> ${outcome}`);
  if (ok) {
    meta.notifiedAt = now;
    io.save(meta);
  }
  return { ok, outcome };
}

// --- scans ---------------------------------------------------------------------

// Finished, undelivered runs this session may surface, oldest-pending last.
export function pendingRuns(io: RunsIo, opts: { now?: number; maxAgeMs?: number } = {}): RunNoticeMeta[] {
  const now = opts.now ?? Date.now();
  const maxAgeMs = opts.maxAgeMs ?? DEFAULT_PRUNE_MS;
  return io.list()
    .filter((meta) => meta.state !== "running" && meta.state !== "queued")
    .filter((meta) => !meta.notifiedAt && meta.finishedAt && now - meta.finishedAt < maxAgeMs)
    .filter((meta) => canNotifyHere(meta.ownerSession, meta.finishedAt, now, currentSessionFile));
}

// Grouped catch-up notice on session activation. Marks ONLY the shown runs as
// notified — the rest stay pending for the next sweep / context pump.
export function sweepFinishedRuns(io: RunsIo, opts: { now?: number; maxAgeMs?: number } = {}): number {
  const now = opts.now ?? Date.now();
  const pending = pendingRuns(io, { now, maxAgeMs: opts.maxAgeMs });
  if (!pending.length) return 0;
  const shown = pending.slice(0, SWEEP_CAP);
  const lines = shown.map((meta) => `${meta.id} · ${meta.agent} — ${meta.state}, ran ${fmtDur((meta.finishedAt ?? now) - meta.startedAt)}`);
  const { ok, outcome } = sendToSession(
    {
      customType: "subagent-run",
      display: true,
      content: `Background subagent run${pending.length === 1 ? "" : "s"} finished since you were away:\n${lines.join("\n")}\nInspect with /subagents list.`,
      details: { ids: shown.map((meta) => meta.id) },
    },
    { deliverAs: "followUp", triggerTurn: true },
    currentSessionFile,
  );
  debugLog(`sweep: ${ok ? `surfaced ${shown.length}` : `failed (${outcome})`}${pending.length > shown.length ? ` (${pending.length - shown.length} still pending)` : ""}`);
  if (!ok) return 0;
  for (const meta of shown) {
    meta.notifiedAt = now;
    io.save(meta);
  }
  return shown.length;
}

// GUARANTEED model-facing delivery: the context hook fires before every LLM
// call; in multi-session hosts (where push is ambiguous) the session's own
// pending notices are injected into its next prompt. Re-checks notifiedAt on
// disk right before injecting — disk is the lock (single-writer discipline).
export function pumpContext(
  io: RunsIo,
  event: { messages?: Array<Record<string, unknown>> },
  ctx: unknown,
): { messages?: Array<Record<string, unknown>> } {
  trackSession(ctx);
  if (isSingleSession()) return {};
  const now = Date.now();
  const pending = pendingRuns(io, { now }).filter((meta) => !(io.read?.(meta.id) ?? meta).notifiedAt);
  if (!pending.length) return {};
  const shown = pending.slice(0, SWEEP_CAP);
  const lines = shown.map((meta) => `${meta.id} · ${meta.agent} — ${meta.state}, ran ${fmtDur((meta.finishedAt ?? now) - meta.startedAt)}`);
  const text = [
    "<system-reminder>",
    `Background subagent run${shown.length === 1 ? "" : "s"} finished since you were away:`,
    ...lines,
    'Inspect with /subagents list; continue with subagent({ continue: "<id>", task: "..." }).',
    "</system-reminder>",
  ].join("\n");
  for (const meta of shown) {
    meta.notifiedAt = now;
    io.save(meta);
  }
  debugLog(`context: injected ${shown.length} finished run notice(s)`);
  return {
    messages: [
      ...(event?.messages ?? []),
      { role: "user", content: [{ type: "text", text }], timestamp: now },
    ],
  };
}

// --- orphan finalize + prune -----------------------------------------------------

function pgidAlive(pgid: number): boolean {
  if (!Number.isFinite(pgid) || pgid <= 0) return false;
  try {
    process.kill(-pgid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "EPERM";
  }
}

// P2 runs are in-process pipe children: if the host dies, the child's stdout
// breaks and the process group disappears. A `running` meta whose process
// group is gone can therefore be finalized as failed — no heartbeat needed.
// Live groups stay untouched (their in-process promise still owns them).
export function finalizeOrphans(io: RunsIo, opts: { now?: number } = {}): string[] {
  const now = opts.now ?? Date.now();
  const finalized: string[] = [];
  for (const meta of io.list()) {
    if (meta.state !== "running" && meta.state !== "queued") continue;
    if (pgidAlive(meta.pgid)) continue;
    io.save({
      ...meta,
      state: "failed",
      finishedAt: now,
      error: "host exited before completion (process group gone)",
    });
    finalized.push(meta.id);
    debugLog(`orphan: finalized ${meta.id} as failed (pgid ${meta.pgid} gone)`);
  }
  return finalized;
}

// Remove finished run dirs older than maxAgeMs. Running runs are never pruned.
export function pruneRuns(io: RunsIo & { remove: (id: string) => void }, opts: { now?: number; maxAgeMs?: number } = {}): string[] {
  const now = opts.now ?? Date.now();
  const maxAgeMs = opts.maxAgeMs ?? DEFAULT_PRUNE_MS;
  const removed: string[] = [];
  for (const meta of io.list()) {
    if (meta.state === "running" || meta.state === "queued") continue;
    if (!meta.finishedAt || now - meta.finishedAt <= maxAgeMs) continue;
    io.remove?.(meta.id);
    removed.push(meta.id);
  }
  if (removed.length) debugLog(`prune: removed ${removed.length} old run dir(s)`);
  return removed;
}
