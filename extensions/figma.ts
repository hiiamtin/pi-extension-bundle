// pi extension: Figma export bridge — capture design PNG/SVG/JPG without Dev
// Mode licenses or REST API rate limits.
//
// Why it exists: Figma's REST `GET /v1/images` is rate-limited to ~20 renders
// per MONTH on Starter (free) plans, and Dev Mode (the thing the official MCP
// needs) requires a paid seat. But rendering is client-side and free anywhere:
// right-click → Copy as PNG works on every plan. This extension automates that
// same client-side path with a tiny dev plugin:
//
//   Figma (plugin)  --POST bytes-->  127.0.0.1:<port>/export   (this extension)
//
// Flow:
//   1. The model (or human) runs /figma serve — the bridge lazy-starts on the
//      first tool call, no manual step needed.
//   2. Human selects node(s) in Figma → Plugins → Development →
//      pi-figma-bridge → "Export PNG @2x" (⌘⌥P re-runs the last plugin).
//   3. figma_take_latest_export waits for a fresh export, saves it under
//      ~/.pi/agent/figma-exports/ and returns it to the model — embedded as an
//      inline image so the model can SEE the design (base64, up to
//      PI_FIGMA_MAX_EMBED_BYTES; beyond that it gets the path only).
//
// Security: the server binds 127.0.0.1 only and every POST must carry the
// X-Figma-Bridge header (browser pages cannot set custom headers cross-origin
// and we never emit CORS headers).
//
// Env overrides:
//   PI_FIGMA_BRIDGE_PORT      (default 37373 — keep in sync with the plugin)
//   PI_FIGMA_BRIDGE_TOKEN     (default pi-figma-export — same caveat)
//   PI_FIGMA_EXPORT_DIR       (default ~/.pi/agent/figma-exports)
//   PI_FIGMA_MAX_EMBED_BYTES  (default 2 MiB — inline image size cap)
//
// After any pi upgrade run: node scripts/smoke-test.mjs
// Functional test:          node scripts/figma-bridge-e2e.mjs

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { extractToolArgs, textResult } from "../lib/tool-compat.ts";
import { Type } from "typebox";
import { readFileSync } from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { startBridgeServer } from "../lib/figma-bridge-server.ts";
import type { BridgeHandle } from "../lib/figma-bridge-server.ts";
import { FigmaExportStore } from "../lib/figma-export-store.ts";
import type { ExportFormat, SavedExport } from "../lib/figma-export-store.ts";

const DEFAULT_PORT = Number(process.env.PI_FIGMA_BRIDGE_PORT) || 37373;
const DEFAULT_TOKEN = process.env.PI_FIGMA_BRIDGE_TOKEN || "pi-figma-export";
const EXPORT_ROOT =
  process.env.PI_FIGMA_EXPORT_DIR || path.join(os.homedir(), ".pi", "agent", "figma-exports");
const MAX_EMBED_BYTES = Number(process.env.PI_FIGMA_MAX_EMBED_BYTES) || 2 * 1024 * 1024;
const DEFAULT_TIMEOUT_SEC = 60;
/** If the user exported right before asking the model, still pick it up. */
const LOOKBACK_MS = 15_000;

type Ui = { notify: (msg: string, level: string) => void };

type ToolContent =
  | { type: "text"; text: string }
  | { type: "image"; source: { type: "base64"; mediaType: string; data: string } };

type ToolResult = { content: ToolContent[]; details: Record<string, unknown> };

interface BridgeState {
  handle: BridgeHandle | null;
  store: FigmaExportStore | null;
  lastExport: SavedExport | null;
  /** createdAtMs of the export already handed to the model (0 = none). */
  handedOutMs: number;
  exportsCount: number;
  waiters: Array<(rec: SavedExport) => void>;
  starting: Promise<void> | null;
}

// Survives module re-eval (pi reloads extensions in one process); the HTTP
// server goes down with the process and lazy-restarts via ensureServer().
const g = globalThis as unknown as { __figmaBridge?: BridgeState };

function state(): BridgeState {
  if (!g.__figmaBridge) {
    g.__figmaBridge = {
      handle: null,
      store: null,
      lastExport: null,
      handedOutMs: 0,
      exportsCount: 0,
      waiters: [],
      starting: null,
    };
  }
  return g.__figmaBridge;
}

async function ensureServer(): Promise<BridgeState> {
  const st = state();
  if (st.handle) return st;
  if (!st.starting) {
    const start = async (): Promise<void> => {
      const store = new FigmaExportStore({ rootDir: EXPORT_ROOT });
      store.ensureDirs();
      // Adopt exports persisted earlier (e.g. before a pi restart).
      const disk = store.readState();
      if (disk.exportsCount > st.exportsCount) {
        st.exportsCount = disk.exportsCount;
        st.lastExport = disk.lastExport ?? st.lastExport;
      }
      const handle = await startBridgeServer({
        port: DEFAULT_PORT,
        token: DEFAULT_TOKEN,
        store,
        onExport: (rec) => {
          st.lastExport = rec;
          st.exportsCount += 1;
          st.store?.appendLog(rec);
          st.store?.writeState({ exportsCount: st.exportsCount, lastExport: st.lastExport });
          const waiter = st.waiters.shift();
          if (waiter) waiter(rec);
        },
      });
      store.writeState({ port: handle.port, exportsCount: st.exportsCount, lastExport: st.lastExport });
      st.handle = handle;
      st.store = store;
    };
    const running = start().finally(() => {
      st.starting = null; // allow retry after a failed start
    });
    st.starting = running;
  }
  await st.starting;
  return st;
}

async function stopServer(): Promise<void> {
  const st = state();
  if (st.handle) {
    await st.handle.close();
    st.handle = null;
  }
}

/**
 * Resolve with a fresh export matching `format` (undefined = any) within
 * `timeoutMs`, or null on timeout. Reuses an export the model never saw:
 * either one created within LOOKBACK_MS of the first call, or any export newer
 * than the last one handed out.
 */
function waitForExport(st: BridgeState, format: ExportFormat | undefined, timeoutMs: number): Promise<SavedExport | null> {
  const now = Date.now();
  const matches = (r: SavedExport): boolean => !format || r.format === format;
  const latest = st.lastExport;
  if (latest && matches(latest)) {
    if (st.handedOutMs === 0 && now - latest.createdAtMs < LOOKBACK_MS) return Promise.resolve(latest);
    if (latest.createdAtMs > st.handedOutMs) return Promise.resolve(latest);
  }
  return new Promise((resolve) => {
    let waiter: (rec: SavedExport) => void = () => {};
    const timer = setTimeout(() => {
      const i = st.waiters.indexOf(waiter);
      if (i >= 0) st.waiters.splice(i, 1);
      resolve(null);
    }, timeoutMs);
    waiter = (rec: SavedExport) => {
      clearTimeout(timer);
      resolve(rec);
    };
    st.waiters.push(waiter);
  });
}

function embedImage(st: BridgeState, rec: SavedExport, embed: boolean): ToolContent[] {
  const text: ToolContent = {
    type: "text",
    text:
      `saved: ${rec.path}\n` +
      `node: ${rec.nodeName || "(unnamed)"} (${rec.nodeId || "?"})\n` +
      `format: ${rec.format} @${rec.scale}x, ${rec.bytes} bytes`,
  };
  if (!embed || rec.bytes > MAX_EMBED_BYTES) return [text];
  try {
    const data = readFileSync(rec.path).toString("base64");
    text.text += `\n(inline image attached: ${(rec.bytes / 1024).toFixed(0)} KiB)`;
    return [
      text,
      {
        type: "image",
        source: {
          type: "base64",
          mediaType: rec.format === "svg" ? "image/svg+xml" : rec.format === "jpg" ? "image/jpeg" : "image/png",
          data,
        },
      },
    ];
  } catch {
    return [text]; // file vanished — still report the path
  }
}

const FORMAT_PATTERN = /^(png|svg|jpg)$/;

async function runTakeLatest(args: unknown[]): Promise<ToolResult> {
  const params = extractToolArgs(args);
  const rawFormat = typeof params.format === "string" ? params.format.toLowerCase() : "";
  const format: ExportFormat | undefined = FORMAT_PATTERN.test(rawFormat) ? (rawFormat as ExportFormat) : undefined;
  const rawTimeout = Number(params.timeout_sec ?? DEFAULT_TIMEOUT_SEC);
  const timeoutSec = Number.isFinite(rawTimeout) ? Math.min(600, Math.max(1, rawTimeout)) : DEFAULT_TIMEOUT_SEC;
  const embed = params.embed !== false;

  let st: BridgeState;
  try {
    st = await ensureServer();
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    return textResult(
      `error: cannot start the figma bridge on port ${DEFAULT_PORT}: ${msg}\n` +
        `(is another process using ${DEFAULT_PORT}? change PI_FIGMA_BRIDGE_PORT and the plugin's code.js in sync, or run /figma stop)`,
    );
  }

  const rec = await waitForExport(st, format, timeoutSec * 1000);
  if (!rec) {
    return textResult(
      `no ${format ?? "png/svg"} export received within ${timeoutSec}s.\n` +
        `Action for the user: select the node(s) in Figma, then Plugins → Development → pi-figma-bridge → "Export PNG @2x" (⌘⌥P re-runs the last plugin).\n` +
        `Check the bridge state with /figma status or figma_bridge_status.`,
    );
  }

  st.handedOutMs = rec.createdAtMs;
  st.store?.writeState({ exportsCount: st.exportsCount, lastExport: st.lastExport });
  return {
    content: embedImage(st, rec, embed),
    details: {
      path: rec.path,
      nodeName: rec.nodeName,
      nodeId: rec.nodeId,
      format: rec.format,
      scale: rec.scale,
      bytes: rec.bytes,
      createdAt: rec.createdAt,
    },
  };
}

async function runStatus(args: unknown[]): Promise<ToolResult> {
  extractToolArgs(args);
  let st: BridgeState;
  try {
    st = await ensureServer();
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    return textResult(`error: cannot start the figma bridge: ${msg}`);
  }
  const last = st.lastExport;
  return textResult(
    [
      `figma bridge: running on ${st.handle?.address}`,
      `exports: ${st.exportsCount}${st.handedOutMs ? ` (last handed to model at ${st.handedOutMs})` : ""}`,
      last
        ? `last export: ${last.path}\n  node ${last.nodeName} (${last.nodeId}), ${last.format} @${last.scale}x, ${last.bytes} bytes, ${last.createdAt}`
        : "last export: none yet — select node(s) in Figma and run the pi-figma-bridge plugin",
    ].join("\n"),
  );
}

export default function (pi: ExtensionAPI): void {
  // Quit: release the listener. Reload: keep serving — the plugin may push
  // mid-reload and globalThis state (incl. the server handle) survives.
  pi.on("session_shutdown", (event) => {
    if (event.reason === "quit") void stopServer();
  });

  pi.registerTool({
    name: "figma_take_latest_export",
    label: "Figma Export Capture",
    description:
      "Capture the design the user just exported from Figma (PNG/SVG/JPG) as a file and view it inline. " +
      "The user must first select node(s) in the Figma app and run the pi-figma-bridge plugin " +
      '(Plugins → Development → pi-figma-bridge → "Export PNG @2x"); exported bytes are pushed to a ' +
      "local bridge, saved to disk, and this tool returns the image to you. Use figma_bridge_status or " +
      "/figma status to inspect the bridge. After an export with no selection change, re-run is a no-op " +
      "until a newer export arrives.",
    promptSnippet: "Capture the design the user exported from Figma (asks the user to run the pi-figma-bridge plugin)",
    promptGuidelines: [
      "Use figma_take_latest_export when the user wants the rendered PNG/SVG of their Figma selection (e.g. to implement a design). " +
        "It waits for the human to run the plugin in Figma — tell them: select node(s), then Plugins → Development → pi-figma-bridge → Export PNG @2x (⌘⌥P re-runs the last plugin).",
      "Use figma_bridge_status (or /figma status) to check whether the bridge is up and see the last export path; " +
        "exports land in ~/.pi/agent/figma-exports/",
    ],
    parameters: Type.Object({
      timeout_sec: Type.Optional(Type.Number({ description: "Seconds to wait for a fresh export (default 60, max 600)." })),
      format: Type.Optional(Type.String({ description: "Only accept this format: \"png\" | \"svg\" | \"jpg\" (default: any)." })),
      embed: Type.Optional(Type.Boolean({ description: "Embed the image inline for the model (default true; skipped over PI_FIGMA_MAX_EMBED_BYTES)." })),
    }),
    execute: async (...args: unknown[]) => runTakeLatest(args),
  });

  pi.registerTool({
    name: "figma_bridge_status",
    label: "Figma Bridge Status",
    description:
      "Inspect the local Figma export bridge: listening address, export count, and the most recent export path/format/size. " +
      "Never waits; returns immediately.",
    promptSnippet: "Check the local Figma export bridge state and last export",
    parameters: Type.Object({}),
    execute: async (...args: unknown[]) => runStatus(args),
  });

  pi.registerCommand("figma", {
    description: "Figma export bridge control. /figma [serve|status|stop|help]",
    getArgumentCompletions: (prefix: string) => {
      const n = prefix.trimStart();
      if (n.includes(" ") && !/^(serve|status|stop|help)\s/.test(n)) return null;
      const items = [
        { value: "serve", label: "serve — start (or restart) the local export bridge" },
        { value: "status", label: "status — bridge state + last export" },
        { value: "stop", label: "stop — close the local export bridge" },
        { value: "help", label: "help — usage summary" },
      ].filter((i) => i.value.startsWith(n));
      return items.length > 0 ? items : null;
    },
    handler: async (args: string, ctx: { ui: Ui }) => {
      const [sub] = args.trim().split(/\s+/).filter(Boolean);
      try {
        if (sub === undefined || sub === "serve") {
          const st = await ensureServer();
          ctx.ui.notify(
            `figma bridge serving on ${st.handle?.address ?? "?"} — exports land in ${EXPORT_ROOT}`,
            "info",
          );
        } else if (sub === "status") {
          const st = await ensureServer();
          const last = st.lastExport;
          ctx.ui.notify(
            `figma bridge: ${st.handle?.address ?? "not running"}; ${st.exportsCount} export(s)` +
              (last ? `; last: ${last.nodeName || "(unnamed)"} ${last.format} @${last.scale}x → ${last.path}` : "; no exports yet"),
            "info",
          );
        } else if (sub === "stop") {
          const st = state();
          if (st.handle) {
            await stopServer();
            ctx.ui.notify("figma bridge stopped", "info");
          } else {
            ctx.ui.notify("figma bridge is not running", "info");
          }
        } else if (sub === "help") {
          ctx.ui.notify("/figma serve|status|stop|help — Figma export bridge (see figma/README.md for plugin install)", "info");
        } else {
          ctx.ui.notify(`unknown /figma subcommand "${sub}" — usage: /figma serve|status|stop|help`, "error");
        }
      } catch (e) {
        ctx.ui.notify(`figma: ${e instanceof Error ? e.message : String(e)}`, "error");
      }
    },
  });
}