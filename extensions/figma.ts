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
//   PI_FIGMA_EXPORT_DIR       (default <project>/.pi/figma-exports — per session cwd)
//   PI_FIGMA_MAX_EMBED_BYTES  (default 2 MiB — inline image size cap)
//
// After any pi upgrade run: node scripts/smoke-test.mjs
// Functional test:          node scripts/figma-bridge-e2e.mjs

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { extractToolArgs, textResult } from "../lib/tool-compat.ts";
import { Type } from "typebox";
import { existsSync, mkdirSync, readFileSync, readdirSync, statSync, unlinkSync, writeFileSync } from "node:fs";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import * as os from "node:os";
import * as path from "node:path";
import { nodeId as figNodeId, parseFig } from "openfig-core";
import { startBridgeServer } from "../lib/figma-bridge-server.ts";
import type { BridgeHandle } from "../lib/figma-bridge-server.ts";
import { FigmaExportStore } from "../lib/figma-export-store.ts";
import type { ExportFormat, SavedExport } from "../lib/figma-export-store.ts";

const DEFAULT_PORT = Number(process.env.PI_FIGMA_BRIDGE_PORT) || 37373;
const DEFAULT_TOKEN = process.env.PI_FIGMA_BRIDGE_TOKEN || "pi-figma-export";
const MAX_EMBED_BYTES = Number(process.env.PI_FIGMA_MAX_EMBED_BYTES) || 2 * 1024 * 1024;
const DEFAULT_TIMEOUT_SEC = 60;

/** Export root per session cwd: project-local by default (./.pi/figma-exports)
 * so captures stay with the repo they belong to; PI_FIGMA_EXPORT_DIR forces a
 * single global dir (tests, shared setups). */
function exportRootFor(cwd: string): string {
  return process.env.PI_FIGMA_EXPORT_DIR || path.join(cwd, ".pi", "figma-exports");
}

/** cwd of the pi session for this tool call (modern convention carries ctx). */
function callCwd(args: unknown[], fallback = process.cwd()): string {
  const ctx = args.length >= 5 ? (args[4] as { cwd?: string } | undefined) : undefined;
  return ctx && typeof ctx.cwd === "string" && ctx.cwd ? ctx.cwd : fallback;
}
/** If the user exported right before asking the model, still pick it up. */
const LOOKBACK_MS = 15_000;

const execFileP = promisify(execFile);

type Ui = { notify: (msg: string, level: string) => void };

type ToolContent =
  | { type: "text"; text: string }
  | { type: "image"; source: { type: "base64"; mediaType: string; data: string } };

type ToolResult = { content: ToolContent[]; details: Record<string, unknown> };

interface BridgeState {
  handle: BridgeHandle | null;
  /** one store per export root (per project cwd) */
  stores: Map<string, FigmaExportStore>;
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
      stores: new Map<string, FigmaExportStore>(),
      lastExport: null,
      handedOutMs: 0,
      exportsCount: 0,
      waiters: [],
      starting: null,
    };
  }
  return g.__figmaBridge;
}

function ensureStore(cwd = process.cwd()): FigmaExportStore {
  const st = state();
  const rootDir = exportRootFor(cwd);
  const cached = st.stores.get(rootDir);
  if (cached) return cached;
  const store = new FigmaExportStore({ rootDir });
  store.ensureDirs();
  // Adopt exports persisted earlier (e.g. before a pi restart).
  const disk = store.readState();
  if (disk.exportsCount > st.exportsCount) {
    st.exportsCount = disk.exportsCount;
    st.lastExport = disk.lastExport ?? st.lastExport;
  }
  st.stores.set(rootDir, store);
  return store;
}

function recordExport(st: BridgeState, rec: SavedExport, store: FigmaExportStore): void {
  st.lastExport = rec;
  st.exportsCount += 1;
  store.appendLog(rec);
  store.writeState({ exportsCount: st.exportsCount, lastExport: st.lastExport });
  const waiter = st.waiters.shift();
  if (waiter) waiter(rec);
}

async function ensureServer(cwd = process.cwd()): Promise<BridgeState> {
  const st = state();
  if (st.handle) return st;
  if (!st.starting) {
    const start = async (): Promise<void> => {
      const store = ensureStore(cwd);
      const handle = await startBridgeServer({
        port: DEFAULT_PORT,
        token: DEFAULT_TOKEN,
        store,
        onExport: (rec) => recordExport(st, rec, store),
      });
      store.writeState({ port: handle.port, exportsCount: st.exportsCount, lastExport: st.lastExport });
      st.handle = handle;
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

/** Pull an image off the macOS clipboard: Figma "Copy as SVG" rides as text,
 * "Copy as PNG" as the «class PNGf» binary flavor. Returns null when neither
 * is present. macOS only. */
async function readClipboardImage(): Promise<{ format: ExportFormat; bytes: Uint8Array } | null> {
  try {
    const { stdout } = await execFileP("pbpaste", [], { timeout: 5_000, maxBuffer: 64 * 1024 * 1024 });
    const head = stdout.trimStart().slice(0, 500);
    if (head.startsWith("<svg") || head.startsWith("<?xml")) {
      return { format: "svg", bytes: Buffer.from(stdout, "utf8") };
    }
  } catch {
    /* fall through to the PNG flavor */
  }
  const tmp = path.join(os.tmpdir(), `figma-clipboard-${process.pid}-${Date.now()}.png`);
  const script = [
    "set pngData to (the clipboard as «class PNGf»)",
    `set f to open for access (POSIX file "${tmp}") with write permission`,
    "set eof f to 0",
    "write pngData to f",
    "close access f",
  ].join("\n");
  try {
    await execFileP("osascript", ["-e", script], { timeout: 5_000 });
    return { format: "png", bytes: readFileSync(tmp) };
  } catch {
    return null;
  } finally {
    try {
      unlinkSync(tmp);
    } catch {
      /* never created */
    }
  }
}

/** Pull-based capture for files where the plugin cannot run (view-only):
 * the user right-clicks → Copy as PNG/SVG (free in every plan/mode), then we
 * persist whatever is on the clipboard through the same store/state/log path
 * as plugin pushes. */
async function runSaveClipboard(args: unknown[], cwd = process.cwd()): Promise<ToolResult> {
  const params = extractToolArgs(args);
  const peek = params.peek === true;
  const embed = params.embed !== false;
  if (process.platform !== "darwin") {
    return textResult(
      "error: figma_save_clipboard supports macOS only (osascript/pbpaste). " +
        "On other platforms use the pi-figma-bridge plugin flow (figma_take_latest_export).",
    );
  }
  let clip: { format: ExportFormat; bytes: Uint8Array } | null;
  try {
    clip = await readClipboardImage();
  } catch (e) {
    return textResult(`error: clipboard read failed: ${e instanceof Error ? e.message : String(e)}`);
  }
  if (!clip) {
    return textResult(
      "clipboard has no Figma PNG/SVG. In Figma: right-click the node → Copy as → PNG (or SVG), " +
        "then call figma_save_clipboard again. Copy as image works even in view-only files.",
    );
  }
  if (peek) {
    return textResult(
      `clipboard contains a ${clip.format} image, ${clip.bytes.byteLength} bytes (peek only — nothing saved).`,
    );
  }
  const st = state();
  const rec = ensureStore(cwd).save({
    bytes: clip.bytes,
    format: clip.format,
    nodeName: "clipboard",
    nodeId: "clipboard",
    scale: 1,
  });
  recordExport(st, rec); // also feeds any waiting figma_take_latest_export call
  st.handedOutMs = rec.createdAtMs;
  return {
    content: embedImage(st, rec, embed),
    details: { path: rec.path, format: rec.format, bytes: rec.bytes, source: "clipboard" },
  };
}

// ── .fig local file parsing (offline; no Figma account/license needed) ──────────
// Powered by the audited fork hiiamtin/openfig-core (MIT; audited 2026-09:
// no network/exec/eval in runtime path, no lifecycle scripts).

function resolveFigPath(raw: unknown): string | null {
  if (typeof raw !== "string" || !raw.trim()) return null;
  let p = raw.trim();
  if (p.startsWith("~/")) p = path.join(os.homedir(), p.slice(2));
  return path.isAbsolute(p) ? p : path.join(process.cwd(), p);
}

function newestFigInDownloads(): string | null {
  const dir = path.join(os.homedir(), "Downloads");
  try {
    const hits = readdirSync(dir)
      .filter((f) => f.toLowerCase().endsWith(".fig"))
      .map((f) => ({ f, t: statSync(path.join(dir, f)).mtimeMs }))
      .sort((a, b) => b.t - a.t);
    return hits.length > 0 ? path.join(dir, hits[0].f) : null;
  } catch {
    return null;
  }
}

function figColorToHex(c: any): string | undefined {
  if (!c || typeof c !== "object") return undefined;
  const clamp = (v: number) => Math.round(Math.max(0, Math.min(1, Number(v) || 0)) * 255);
  const hex = (n: number) => n.toString(16).padStart(2, "0");
  const base = `#${hex(clamp(c.r))}${hex(clamp(c.g))}${hex(clamp(c.b))}`;
  return typeof c.a === "number" && c.a < 1 ? `${base}${hex(clamp(c.a))}` : base;
}

function summarizePaints(paints: any): any[] | undefined {
  if (!Array.isArray(paints) || paints.length === 0) return undefined;
  return paints.slice(0, 4).map((p: any) => {
    if (p?.type === "SOLID") return { solid: figColorToHex(p.color) ?? "?" };
    if (p?.image) {
      const ref = typeof p.image === "string" ? p.image : (p.image.ref ?? p.image.imageHash ?? "image");
      return { image: String(ref) };
    }
    return { paint: String(p?.type ?? "unknown").toLowerCase() };
  });
}

function summarizeNode(doc: any, node: any, depth: number, maxDepth: number, budget: { left: number }): any {
  const out: Record<string, unknown> = { type: node.type };
  if (node.name) out.name = node.name;
  const id = figNodeId(node);
  if (id) out.id = id;
  if (node.size) out.size = `${Math.round(node.size.x)}x${Math.round(node.size.y)}`;
  if (node.visible === false) out.hidden = true;
  if (typeof node.opacity === "number" && node.opacity < 1) out.opacity = Math.round(node.opacity * 100) / 100;
  if (node.cornerRadius) out.radius = node.cornerRadius;
  const fills = summarizePaints(node.fillPaints);
  if (fills) out.fills = fills;
  if (node.textData?.characters) out.text = node.textData.characters;
  const kids = depth < maxDepth ? (doc.childrenMap.get(id ?? "") ?? []) : [];
  if (kids.length > 0 && depth < maxDepth) {
    const visible = kids.filter((k: any) => k.visible !== false);
    out.children = visible.slice(0, 40).map((k: any) => summarizeNode(doc, k, depth + 1, maxDepth, budget));
    if (visible.length > 40) out.children.push(`…+${visible.length - 40} more children`);
  } else if (kids.length > 0) {
    out.children = `…${kids.length} children below depth limit`;
  }
  budget.left -= JSON.stringify(out).length;
  return out;
}

async function runParseLocalFig(args: unknown[], cwd = process.cwd()): Promise<ToolResult> {
  const params = extractToolArgs(args);
  const embed = params.embed !== false;
  const maxDepth = Math.min(12, Math.max(1, Number(params.depth) || 6));
  const maxChars = Math.min(80_000, Math.max(2_000, Number(params.max_json_chars) || 20_000));

  const figPath = resolveFigPath(params.path) ?? newestFigInDownloads();
  if (!figPath || !existsSync(figPath)) {
    return textResult(
      "error: no .fig file to parse. Pass `path` to a downloaded .fig (in Figma: main menu → File → Download → .fig), " +
        "or download one into ~/Downloads and call again.",
    );
  }

  let doc: any;
  try {
    doc = parseFig(new Uint8Array(readFileSync(figPath)));
  } catch (e) {
    return textResult(`error: parsing ${figPath}: ${e instanceof Error ? e.message : String(e)}`);
  }

  // Persist thumbnail + raster assets to disk (same home as plugin exports).
  const stem = path.basename(figPath).replace(/\.fig$/i, "").replace(/[^\w.-]+/g, "_") || "fig";
  const assetsDir = path.join(exportRootFor(cwd), `fig-${stem}`);
  const imagesDir = path.join(assetsDir, "images");
  mkdirSync(imagesDir, { recursive: true });
  if (doc.thumbnail) writeFileSync(path.join(assetsDir, "thumbnail.png"), doc.thumbnail);
  let savedImages = 0;
  for (const [name, bytes] of doc.images) {
    writeFileSync(path.join(imagesDir, path.basename(name)), bytes);
    savedImages += 1;
  }

  // Top-level frames (direct children of pages).
  const frames: Array<{ name: string; size: string; id: string }> = [];
  for (const node of doc.nodes as any[]) {
    if (node.type !== "FRAME" || !node.name) continue;
    const pid = node.parentIndex ? `${node.parentIndex.guid.sessionID}:${node.parentIndex.guid.localID}` : "";
    const parent = pid ? doc.nodeMap.get(pid) : undefined;
    if (parent?.type !== "CANVAS") continue;
    frames.push({
      name: node.name,
      size: node.size ? `${Math.round(node.size.x)}x${Math.round(node.size.y)}` : "?",
      id: figNodeId(node) ?? "?",
    });
  }

  const header =
    `parsed: ${figPath}\n` +
    `kiwi v${doc.header?.version ?? "?"}, ${doc.nodes.length} nodes, ${doc.images.size} images\n` +
    `assets → ${assetsDir} (thumbnail.png + images/×${savedImages})\n` +
    `top-level frames (${frames.length}):\n` +
    frames.slice(0, 25).map((f) => `  - "${f.name}" ${f.size} [${f.id}]`).join("\n") +
    (frames.length > 25 ? `\n  …+${frames.length - 25} more (pass frame:"<name>" for a subtree)` : "");

  let subtreeText = "";
  let chosen: string | null = null;
  const wanted = typeof params.frame === "string" ? params.frame.trim().toLowerCase() : "";
  if (wanted) {
    const matches = frames.filter((f) => f.name.toLowerCase().includes(wanted));
    const target = matches.length > 0 ? doc.nodeMap.get(matches[0].id) : undefined;
    if (!target) {
      subtreeText = `\nno top-level frame matching "${params.frame}" — use one of the names above.`;
    } else {
      chosen = matches[0].name;
      const budget = { left: maxChars };
      const tree = summarizeNode(doc, target, 0, maxDepth, budget);
      subtreeText =
        (matches.length > 1 ? `\n(${matches.length} frames match — using "${matches[0].name}")\n` : "") +
        `\nsubtree of "${matches[0].name}" (depth ≤ ${maxDepth}):\n` +
        JSON.stringify(tree, null, 1).slice(0, maxChars) +
        (budget.left < 0 ? "\n…truncated (raise max_json_chars or lower depth)" : "");
    }
  } else if (frames.length > 0) {
    subtreeText = `\ncall again with frame:"<name>" to get one frame's full layout subtree.`;
  }

  const content: ToolContent[] = [{ type: "text", text: header + subtreeText }];
  if (embed && doc.thumbnail && doc.thumbnail.byteLength <= MAX_EMBED_BYTES) {
    content.push({
      type: "image",
      source: { type: "base64", mediaType: "image/png", data: Buffer.from(doc.thumbnail).toString("base64") },
    });
  }
  return {
    content,
    details: {
      path: figPath,
      nodes: doc.nodes.length,
      images: doc.images.size,
      frames: frames.length,
      frameNames: frames.slice(0, 50).map((f) => f.name),
      chosenFrame: chosen,
      assetsDir,
    },
  };
}

const FORMAT_PATTERN = /^(png|svg|jpg)$/;

async function runTakeLatest(args: unknown[], cwd = process.cwd()): Promise<ToolResult> {
  const params = extractToolArgs(args);
  const rawFormat = typeof params.format === "string" ? params.format.toLowerCase() : "";
  const format: ExportFormat | undefined = FORMAT_PATTERN.test(rawFormat) ? (rawFormat as ExportFormat) : undefined;
  const rawTimeout = Number(params.timeout_sec ?? DEFAULT_TIMEOUT_SEC);
  const timeoutSec = Number.isFinite(rawTimeout) ? Math.min(600, Math.max(1, rawTimeout)) : DEFAULT_TIMEOUT_SEC;
  const embed = params.embed !== false;

  let st: BridgeState;
  try {
    st = await ensureServer(cwd);
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

async function runStatus(args: unknown[], cwd = process.cwd()): Promise<ToolResult> {
  extractToolArgs(args);
  let st: BridgeState;
  try {
    st = await ensureServer(cwd);
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    return textResult(`error: cannot start the figma bridge: ${msg}`);
  }
  const last = st.lastExport;
  return textResult(
    [
      `figma bridge: running on ${st.handle?.address}`,
      `export root: ${exportRootFor(cwd)}`,
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
        "exports land in <project>/.pi/figma-exports/ (per session cwd; PI_FIGMA_EXPORT_DIR overrides).",
    ],
    parameters: Type.Object({
      timeout_sec: Type.Optional(Type.Number({ description: "Seconds to wait for a fresh export (default 60, max 600)." })),
      format: Type.Optional(Type.String({ description: "Only accept this format: \"png\" | \"svg\" | \"jpg\" (default: any)." })),
      embed: Type.Optional(Type.Boolean({ description: "Embed the image inline for the model (default true; skipped over PI_FIGMA_MAX_EMBED_BYTES)." })),
    }),
    execute: async (...args: unknown[]) => runTakeLatest(args, callCwd(args)),
  });

  pi.registerTool({
    name: "figma_bridge_status",
    label: "Figma Bridge Status",
    description:
      "Inspect the local Figma export bridge: listening address, export count, and the most recent export path/format/size. " +
      "Never waits; returns immediately.",
    promptSnippet: "Check the local Figma export bridge state and last export",
    parameters: Type.Object({}),
    execute: async (...args: unknown[]) => runStatus(args, callCwd(args)),
  });

  pi.registerTool({
    name: "figma_save_clipboard",
    label: "Figma Clipboard Save",
    description:
      "Save a Figma image from the macOS clipboard to disk and view it inline. For files where the " +
      "pi-figma-bridge plugin cannot run (view-only files): ask the user to right-click the node → " +
      'Copy as → PNG (or SVG), then call this tool. Use peek:true to inspect the clipboard without saving.',
    promptSnippet: "Save a Figma Copy-as-PNG/SVG from the macOS clipboard (works in view-only files)",
    parameters: Type.Object({
      peek: Type.Optional(Type.Boolean({ description: "Report clipboard contents without saving (default false)." })),
      embed: Type.Optional(Type.Boolean({ description: "Embed the image inline for the model (default true)." })),
    }),
    execute: async (...args: unknown[]) => runSaveClipboard(args, callCwd(args)),
  });

  pi.registerTool({
    name: "figma_parse_local_fig",
    label: "Figma .fig Parser",
    description:
      "Parse a downloaded Figma .fig file OFFLINE (no Figma account/license needed): node-tree JSON " +
      "(types, names, sizes, fill colors, real text), extracted raster assets, and the page thumbnail, " +
      "all saved to disk. The free equivalent of Dev Mode's structured data — use it when the design " +
      "only exists as a .fig export (view-only files: File → Download → .fig). Default path: newest " +
      ".fig in ~/Downloads. Pass frame:\"<name>\" to extract one frame's layout subtree.",
    promptSnippet: "Parse a downloaded .fig file offline into node-tree JSON + assets (view-only file path)",
    parameters: Type.Object({
      path: Type.Optional(Type.String({ description: "Path to a .fig file (default: newest .fig in ~/Downloads)." })),
      frame: Type.Optional(Type.String({ description: "Top-level frame name (substring, case-insensitive) to extract as a layout subtree." })),
      depth: Type.Optional(Type.Number({ description: "Subtree depth limit (default 6, max 12)." })),
      max_json_chars: Type.Optional(Type.Number({ description: "Subtree JSON character budget (default 20000, max 80000)." })),
      embed: Type.Optional(Type.Boolean({ description: "Embed the page thumbnail inline (default true)." })),
    }),
    execute: async (...args: unknown[]) => runParseLocalFig(args, callCwd(args)),
  });

  pi.registerCommand("figma", {
    description: "Figma export bridge control. /figma [serve|status|stop|clip|help]",
    getArgumentCompletions: (prefix: string) => {
      const n = prefix.trimStart();
      if (n.includes(" ") && !/^(serve|status|stop|clip|help)\s/.test(n)) return null;
      const items = [
        { value: "serve", label: "serve — start (or restart) the local export bridge" },
        { value: "status", label: "status — bridge state + last export" },
        { value: "clip", label: "clip — save Figma Copy-as-PNG/SVG from the clipboard" },
        { value: "stop", label: "stop — close the local export bridge" },
        { value: "help", label: "help — usage summary" },
      ].filter((i) => i.value.startsWith(n));
      return items.length > 0 ? items : null;
    },
    handler: async (args: string, ctx: { ui: Ui }) => {
      const [sub] = args.trim().split(/\s+/).filter(Boolean);
      try {
        if (sub === undefined || sub === "serve") {
          const st = await ensureServer(ctx.cwd);
          ctx.ui.notify(
            `figma bridge serving on ${st.handle?.address ?? "?"} — exports land in ${exportRootFor(ctx.cwd)}`,
            "info",
          );
        } else if (sub === "status") {
          const st = await ensureServer(ctx.cwd);
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
        } else if (sub === "clip") {
          const res = await runSaveClipboard([], ctx.cwd);
          const first = res.content[0];
          ctx.ui.notify(first.type === "text" ? first.text : "clipboard saved", "info");
        } else if (sub === "help") {
          ctx.ui.notify(
            "/figma serve|status|stop|clip|help — bridge: figma/README.md; clipboard path works in view-only files",
            "info",
          );
        } else {
          ctx.ui.notify(`unknown /figma subcommand "${sub}" — usage: /figma serve|status|stop|help`, "error");
        }
      } catch (e) {
        ctx.ui.notify(`figma: ${e instanceof Error ? e.message : String(e)}`, "error");
      }
    },
  });
}