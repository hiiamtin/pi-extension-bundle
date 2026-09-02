// pi extension: live tok/s in the working row.
//
// WHY: with `hideThinkingBlock: true` the terminal shows only the working row
// during long thinking stretches — nothing moves, so you cannot tell "live"
// from "hung". This extension counts streaming deltas (thinking_delta /
// text_delta delivered on the message_update event) and rewrites the working
// message every 400ms:
//
//   ✻ Thinking… ↑ 38.4 tok/s · 1.2k tok · 12s
//   ✎ Writing…  ↑ 61.8 tok/s · 2.0k tok · 28s
//
// tok count is chars/4 (heuristic — this is a liveness meter, not billing);
// the rate is windowed + EMA-smoothed so chunk-size jitter does not make the
// number jump around. toolcall deltas (streamed JSON args) count toward the
// rate/total but never change the phase label. On message_end the default
// working message is restored.
//
// No UI (pi-web bridge, SDK headless) or PI_TOK_RATE=off → the extension stays
// completely idle. No persistent state, no tools, no commands.
//
// After any pi upgrade run: node scripts/smoke-test.mjs

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

const UPDATE_MS = 400;
const CHARS_PER_TOKEN = 4;

// rate tier thresholds for the colors: PI_TOK_RATE_TIERS="fast,ok,slow"
// (accent >= fast, success >= ok, warning >= slow, error below). Defaults 50/30/15.
const tierThresholds = (process.env.PI_TOK_RATE_TIERS || "")
  .split(",")
  .map((v) => Number(v.trim()))
  .filter((v) => Number.isFinite(v) && v > 0);
const TIER_FAST = tierThresholds[0] ?? 50;
const TIER_OK = tierThresholds[1] ?? 30;
const TIER_SLOW = tierThresholds[2] ?? 15;

interface WorkingUi {
  setWorkingMessage?: (msg?: string) => void;
  theme?: { fg(color: string, text: string): string };
}

interface StreamEvent {
  message?: { role?: string };
  assistantMessageEvent?: { type?: string; delta?: string };
}

function fmtTok(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 1_000) return `${(n / 1_000).toFixed(1)}k`;
  return String(Math.round(n));
}

function fmtDur(ms: number): string {
  const s = Math.round(ms / 1000);
  if (s < 60) return `${s}s`;
  return `${Math.floor(s / 60)}m${String(s % 60).padStart(2, "0")}s`;
}

export default function tokRateExtension(pi: ExtensionAPI): void {
  if ((process.env.PI_TOK_RATE || "").toLowerCase() === "off") return;

  let ui: WorkingUi | null = null;
  let active = false;
  let chars = 0;
  let ema = 0; // smoothed tok/s
  let startedAt = 0;
  let lastRateAt = 0; // windowed rate: fold chars into the EMA at most every 200ms
  let charsAtLastRate = 0;
  let lastPaintAt = 0;
  let phase: "Thinking" | "Writing" = "Thinking";
  let icon = "✻";
  let timer: NodeJS.Timeout | null = null;

  const stop = (restore: boolean): void => {
    if (timer) {
      clearInterval(timer);
      timer = null;
    }
    active = false;
    if (restore) {
      try {
        ui?.setWorkingMessage?.(); // no args → pi's default working message
      } catch {
        /* stale ui after reload — nothing to restore */
      }
    }
  };

  const render = (force = false): void => {
    if (!active || !ui) return;
    const now = Date.now();
    // windowed rate — per-delta dt can be ~0ms (burst deltas in one tick),
    // which makes instant rates explode and poisons the EMA; folding over a
    // >=200ms window keeps the number sane and naturally smooth
    const dt = now - lastRateAt;
    if (dt >= 200) {
      const instant = (chars - charsAtLastRate) / CHARS_PER_TOKEN / (dt / 1000);
      ema = ema === 0 ? instant : ema * 0.5 + instant * 0.5;
      lastRateAt = now;
      charsAtLastRate = chars;
    }
    if (!force && now - lastPaintAt < 100) return; // paint throttle (deltas can burst)
    if (force && now - lastPaintAt < 50) return; // even phase switches can't paint-storm
    lastPaintAt = now;
    const elapsed = Math.max(1, now - startedAt);
    const rate = ema > 0 ? ema.toFixed(1) : "--"; // "--" until the first window closes
    // rate tier colors (theme roles — same idea as pi-web's tps badge)
    const tier = ema >= TIER_FAST ? "accent" : ema >= TIER_OK ? "success" : ema >= TIER_SLOW ? "warning" : "error";
    const th = ui.theme;
    const paint = (text: string, color?: string): string => (th && color ? th.fg(color, text) : text);
    const msg =
      paint(`${icon} ${phase}… `, "accent") +
      paint(`↑ ${rate} tok/s`, tier) +
      paint(` · ${fmtTok(chars / CHARS_PER_TOKEN)} tok · ${fmtDur(elapsed)}`, "dim");
    try {
      ui.setWorkingMessage?.(msg);
    } catch {
      stop(false); // ui went stale (reload) — stop updating it
    }
  };

  pi.on("message_start", (event: StreamEvent, ctx: { hasUI?: boolean; ui?: WorkingUi } | undefined) => {
    if (event.message?.role !== "assistant") return;
    if (ctx?.hasUI === false) return;
    const nextUi = ctx?.ui ?? ui;
    if (!nextUi?.setWorkingMessage) return; // no working row in this host — stay idle
    ui = nextUi;
    chars = 0;
    ema = 0;
    startedAt = Date.now();
    lastRateAt = startedAt;
    charsAtLastRate = 0;
    lastPaintAt = 0;
    phase = "Thinking";
    icon = "✻";
    active = true;
    if (!timer) {
      timer = setInterval(render, UPDATE_MS);
      if (typeof timer.unref === "function") timer.unref();
    }
  });

  pi.on("message_update", (event: StreamEvent) => {
    if (!active) return;
    const ev = event.assistantMessageEvent;
    if (!ev) return;
    let nextPhase: "Thinking" | "Writing" | null;
    if (ev.type === "thinking_delta") {
      nextPhase = "Thinking";
    } else if (ev.type === "text_delta") {
      nextPhase = "Writing";
    } else if (ev.type === "toolcall_delta") {
      // streamed JSON args count toward rate/total (matches pi-web) but never
      // relabel the phase — they are not prose
      const argLen = ev.delta?.length ?? 0;
      if (argLen) chars += argLen;
      render();
      return;
    } else {
      return; // start/end markers carry nothing countable
    }
    const len = ev.delta?.length ?? 0;
    if (!len) return;
    const phaseChanged = nextPhase !== phase;
    phase = nextPhase;
    icon = nextPhase === "Thinking" ? "✻" : "✎";
    chars += len;
    render(phaseChanged); // phase switch paints immediately; prose deltas are throttled
  });

  pi.on("message_end", (event: StreamEvent) => {
    if (event.message?.role !== "assistant") return;
    stop(true);
  });

  // belt+braces: aborted/errored turns must never leave our text stuck in the row
  pi.on("turn_end", () => {
    if (active) stop(true);
  });
  pi.on("session_shutdown", () => stop(false));
}
