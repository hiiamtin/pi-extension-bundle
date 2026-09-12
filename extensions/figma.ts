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
import { parseFig } from "openfig-core";
import { guidStr, mergeNodeChanges, resolveSubtree } from "../lib/figma-instance-resolver.ts";
import type { ResolvedNode } from "../lib/figma-instance-resolver.ts";
import { matchFigFiles, parseFigmaUrl } from "../lib/figma-link.ts";
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
  // NOTE: pi-ai ImageContent is FLAT (data + mimeType) — the Anthropic-style
  // nested `source` shape makes pi's image normalization crash with
  // Buffer.from(undefined) and the tool result gets discarded.
  | { type: "image"; data: string; mimeType: string };

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
        data,
        mimeType: rec.format === "svg" ? "image/svg+xml" : rec.format === "jpg" ? "image/jpeg" : "image/png",
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
// Instance/component data resolves via lib/figma-instance-resolver.ts
// (symbolData.symbolID + symbolOverrides + componentPropAssignments) so the
// REAL rendered texts of library components come out — no screenshots needed.

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

/** roots scanned when matching a Figma URL to a downloaded .fig */
function figSearchRoots(cwd: string): string[] {
  return [path.join(os.homedir(), "Downloads"), cwd, exportRootFor(cwd)];
}

function listLocalFigs(cwd: string): Array<{ path: string; mtimeMs: number }> {
  const seen = new Set<string>();
  const out: Array<{ path: string; mtimeMs: number }> = [];
  for (const dir of figSearchRoots(cwd)) {
    let entries: string[] = [];
    try {
      entries = readdirSync(dir);
    } catch {
      continue;
    }
    for (const f of entries) {
      if (!f.toLowerCase().endsWith(".fig")) continue;
      const p = path.join(dir, f);
      if (seen.has(p)) continue;
      seen.add(p);
      try {
        out.push({ path: p, mtimeMs: statSync(p).mtimeMs });
      } catch {
        /* raced */
      }
    }
  }
  return out.sort((a, b) => b.mtimeMs - a.mtimeMs).slice(0, 12);
}

function renderResolved(n: ResolvedNode, depth: number, lines: string[], budget: { left: number }): void {
  if (budget.left <= 0 || depth > 14) return;
  const pad = "  ".repeat(depth);
  let line = `${pad}- ${n.type}${n.name ? ` "${n.name}"` : ""}${n.size ? ` ${n.size}` : ""}`;
  if (n.component) line += ` → component "${n.component}"`;
  if (n.hidden) line += " (hidden)";
  lines.push(line);
  budget.left -= line.length + 1;
  if (n.fills?.length) {
    const l = `${pad}    fills: ${n.fills.join(", ")}`;
    lines.push(l);
    budget.left -= l.length + 1;
  }
  if (n.text) {
    const l = `${pad}    text: "${n.text}"`;
    lines.push(l);
    budget.left -= l.length + 1;
  }
  if (n.overrideTexts?.length) {
    const l = `${pad}    texts: ${n.overrideTexts.map((t) => `"${t}"`).join(" → ")}`;
    lines.push(l);
    budget.left -= l.length + 1;
  }
  if (n.propTexts?.length) {
    const l = `${pad}    prop texts: ${n.propTexts.map((t) => `"${t}"`).join(", ")}`;
    lines.push(l);
    budget.left -= l.length + 1;
  }
  for (const c of n.children ?? []) renderResolved(c, depth + 1, lines, budget);
}

async function runParseLocalFig(args: unknown[], cwd = process.cwd()): Promise<ToolResult> {
  const params = extractToolArgs(args);
  const embed = params.embed !== false;
  const maxDepth = Math.min(14, Math.max(1, Number(params.depth) || 10));
  const maxChars = Math.min(80_000, Math.max(2_000, Number(params.max_json_chars) || 20_000));

  const parsedUrl = typeof params.url === "string" && params.url.trim() ? parseFigmaUrl(params.url) : null;
  if (typeof params.url === "string" && params.url.trim() && !parsedUrl) {
    return textResult(
      `error: cannot parse "${params.url}" as a Figma link (expected figma.com/design/<key>/<slug>?node-id=... or a bare file key).`,
    );
  }
  const rawNode = typeof params.node === "string" ? params.node.trim() : "";
  const nodeId = rawNode ? rawNode.replace("-", ":") : parsedUrl?.nodeId ?? null;

  // file resolution: explicit path → URL name match → newest in ~/Downloads
  let figPath = resolveFigPath(params.path);
  let matchedBy = figPath ? "explicit path" : null;
  let urlMeta: any = null;
  if (!figPath && parsedUrl) {
    const candidates = listLocalFigs(cwd);
    if (candidates.length === 0) {
      return textResult(
        "no .fig files found on this machine. Ask the user to download the linked file — in Figma: main menu → File → Download → .fig — then call this tool again with the same url.",
      );
    }
    const withNames = candidates.map((c) => {
      let fileName = path.basename(c.path);
      let fileMeta: any = null;
      try {
        fileMeta = parseFig(new Uint8Array(readFileSync(c.path))).meta ?? null;
        if (fileMeta?.file_name) fileName = String(fileMeta.file_name);
      } catch {
        /* unreadable candidate — keep the path stem */
      }
      return { ...c, fileName, altName: path.basename(c.path).replace(/\.fig$/i, ""), meta: fileMeta };
    });
    const matches = matchFigFiles(withNames, parsedUrl);
    if (matches.length === 0) {
      const list = withNames.map((c) => `  - "${c.fileName}" (exported ${c.meta?.exported_at ?? "unknown date"}) → ${c.path}`).join("\n");
      return textResult(
        `no local .fig matches the link's file "${parsedUrl.slug ?? parsedUrl.fileKey}". Local files:\n${list}\n` +
          `Ask the user which file to use (pass path), or to download the linked file (File → Download → .fig) and call again.`,
      );
    }
    if (matches.length > 1) {
      const list = matches.map((c) => `  - "${c.fileName}" (exported ${c.meta?.exported_at ?? "?"}) → ${c.path}`).join("\n");
      return textResult(`multiple local .fig files match "${parsedUrl.slug}". Ask the user which one:\n${list}`);
    }
    figPath = matches[0].path;
    urlMeta = matches[0].meta;
    matchedBy = "url name match";
  }
  if (!figPath) figPath = newestFigInDownloads();
  if (!figPath || !existsSync(figPath)) {
    return textResult(
      "error: no .fig file to parse. Pass `url` (Figma link) or `path` to a downloaded .fig (in Figma: main menu → File → Download → .fig).",
    );
  }

  let doc: any;
  try {
    doc = parseFig(new Uint8Array(readFileSync(figPath)));
  } catch (e) {
    return textResult(`error: parsing ${figPath}: ${e instanceof Error ? e.message : String(e)}`);
  }
  const meta: any = urlMeta ?? doc.meta ?? null;
  const exportedAt = String(meta?.exported_at ?? "unknown date");

  // persist thumbnail + raster assets to disk (per-project export root)
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

  const fig = mergeNodeChanges(doc.message?.nodeChanges ?? []);

  // locate the requested node / frame
  let rootId: string | null = nodeId ?? null;
  if (rootId && !fig.nodes.has(rootId)) {
    return textResult(
      `node ${rootId} is not present in this snapshot (${figPath}, exported ${exportedAt}).\n` +
        `The node was likely created after the download. Ask the user to re-download (File → Download → .fig) and call again.`,
    );
  }
  let chosen: string | null = null;
  const topLevel: Array<{ id: string; name: string }> = [];
  for (const [id, nc] of fig.nodes) {
    if (nc.type !== "FRAME" || !nc.name) continue;
    const pid = guidStr(nc.parentIndex?.guid);
    if (pid && fig.nodes.get(pid)?.type === "CANVAS") topLevel.push({ id, name: nc.name });
  }
  if (!rootId) {
    const wanted = typeof params.frame === "string" ? params.frame.trim().toLowerCase() : "";
    if (wanted) {
      const hit = topLevel.find((f) => f.name.toLowerCase().includes(wanted));
      if (!hit) {
        return textResult(
          `no top-level frame matching "${params.frame}". Frames:\n` +
            topLevel.slice(0, 30).map((f) => `  - "${f.name}"`).join("\n"),
        );
      }
      rootId = hit.id;
      chosen = hit.name;
    }
  }

  const header =
    `parsed: ${figPath}\n` +
    `file: "${meta?.file_name ?? doc.meta?.file_name ?? "?"}" | exported: ${exportedAt} | matched via ${matchedBy}\n` +
    `kiwi v${doc.header?.version ?? "?"}, ${fig.nodes.size} nodes, ${doc.images.size} images\n` +
    `assets → ${assetsDir} (thumbnail.png + images/×${savedImages})`;

  const content: ToolContent[] = [];
  const lines: string[] = [header];
  const budget = { left: maxChars };
  if (rootId) {
    const resolved = resolveSubtree(fig, rootId, { maxDepth });
    lines.push(`\nresolved node ${rootId}${chosen ? ` (frame "${chosen}")` : ""}:`);
    if (resolved) renderResolved(resolved, 0, lines, budget);
    lines.push(
      budget.left < 0
        ? "\n…truncated (raise max_json_chars or lower depth)"
        : "\n(instance texts are the REAL rendered values: symbolOverrides + componentPropAssignments)",
    );
  } else {
    lines.push(
      `\ntop-level frames (${topLevel.length}):` +
        "\n" +
        topLevel
          .slice(0, 25)
          .map((f) => `  - "${f.name}" [${f.id}]`)
          .join("\n") +
        (topLevel.length > 25 ? `\n  …+${topLevel.length - 25} more` : "") +
        `\ncall again with node:"<id>" (or the figma url) or frame:"<name>" for a fully resolved subtree.`,
    );
  }
  content.push({ type: "text", text: lines.join("\n") });
  if (embed && doc.thumbnail && doc.thumbnail.byteLength <= MAX_EMBED_BYTES) {
    content.push({
      type: "image",
      data: Buffer.from(doc.thumbnail).toString("base64"),
      mimeType: "image/png",
    });
  }
  return {
    content,
    details: {
      path: figPath,
      fileName: meta?.file_name ?? null,
      exportedAt,
      matchedBy,
      urlNodeId: nodeId,
      nodes: fig.nodes.size,
      images: doc.images.size,
      frames: topLevel.length,
      frameNames: topLevel.slice(0, 50).map((f) => f.name),
      assetsDir,
      chosenNode: rootId,
      chosenFrame: chosen,
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
      "Turn a figma.com design link (or a downloaded .fig file) into structured design data OFFLINE — " +
      "no Figma account, no Dev Mode license, no screenshots. Give it the url and it matches the link's " +
      "file to a local .fig snapshot (asks the user to download one if missing), locates the node from " +
      "the URL's node-id, and returns the resolved tree: layout, fill colors, REAL component texts " +
      "(symbolOverrides + componentPropAssignments resolved against the component definitions), plus " +
      "extracted raster assets and the page thumbnail saved to disk. If the snapshot's export date looks " +
      "older than the user's changes, ask for a fresh download.",
    promptSnippet: "Extract design data from a figma.com link or downloaded .fig file — offline, real component texts",
    parameters: Type.Object({
      url: Type.Optional(Type.String({ description: "Figma design link (figma.com/design/...). Its file is matched to a local .fig by name; its node-id selects the node." })),
      node: Type.Optional(Type.String({ description: 'Node id, e.g. "470-25675" or "470:25675". Defaults to the URL\'s node-id.' })),
      path: Type.Optional(Type.String({ description: "Path to a .fig file (default: URL matching, else newest .fig in ~/Downloads)." })),
      frame: Type.Optional(Type.String({ description: "Top-level frame name (substring, case-insensitive) when no node is given." })),
      depth: Type.Optional(Type.Number({ description: "Subtree depth limit (default 10, max 14)." })),
      max_json_chars: Type.Optional(Type.Number({ description: "Output character budget (default 20000, max 80000)." })),
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