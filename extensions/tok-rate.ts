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
// the rate is EMA-smoothed (0.7 prev + 0.3 instant) so chunk-size jitter does
// not make the number jump around. On message_end the default working message
// is restored; toolcall deltas are ignored (JSON args, not prose).
//
// No UI (pi-web bridge, SDK headless) or PI_TOK_RATE=off → the extension stays
// completely idle. No persistent state, no tools, no commands.
//
// After any pi upgrade run: node scripts/smoke-test.mjs

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

const UPDATE_MS = 400;
const CHARS_PER_TOKEN = 4;

interface WorkingUi {
  setWorkingMessage?: (msg?: string) => void;
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
  let lastDeltaAt = 0;
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

  const render = (): void => {
    if (!active || !ui) return;
    const elapsed = Math.max(1, Date.now() - startedAt);
    const msg = `${icon} ${phase}… ↑ ${ema.toFixed(1)} tok/s · ${fmtTok(chars / CHARS_PER_TOKEN)} tok · ${fmtDur(elapsed)}`;
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
    lastDeltaAt = startedAt;
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
    if (ev.type === "thinking_delta") {
      phase = "Thinking";
      icon = "✻";
    } else if (ev.type === "text_delta") {
      phase = "Writing";
      icon = "✎";
    } else {
      return; // start/end markers and toolcall JSON deltas are not prose
    }
    const len = ev.delta?.length ?? 0;
    if (!len) return;
    const now = Date.now();
    const instant = (len / CHARS_PER_TOKEN) / (Math.max(1, now - lastDeltaAt) / 1000);
    lastDeltaAt = now;
    chars += len;
    ema = ema === 0 ? instant : ema * 0.7 + instant * 0.3;
    render(); // immediate first paint; the timer keeps it fresh during pauses
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
