// Figma export persistence: sanitized filenames, atomic writes, a self-capped
// JSONL export log, and a small JSON state file ("last export") for pickup
// after a pi process restart or extension reload.
//
// Pure Node with zero pi imports so the bridge server and the e2e test can use
// it directly (Node >=24 type-stripping does the rest).

import {
  appendFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  statSync,
  writeFileSync,
} from "node:fs";
import * as path from "node:path";

export type ExportFormat = "png" | "svg" | "jpg";

/** One persisted export. JSON-safe (serialized into state + log files). */
export interface SavedExport {
  /** Absolute file path on disk. */
  path: string;
  nodeName: string;
  nodeId: string;
  format: ExportFormat;
  scale: number;
  bytes: number;
  /** ISO 8601 timestamp of when the bytes landed. */
  createdAt: string;
  createdAtMs: number;
}

export interface StoreState {
  port: number;
  exportsCount: number;
  lastExport: SavedExport | null;
}

const LOG_MAX_BYTES = 5 * 1024 * 1024;
const LOG_TAIL_BYTES = 1024 * 1024;
const NAME_MAX = 80;

/**
 * Keep only [A-Za-z0-9._-]; everything else becomes "_". Suitable for
 * filenames and URLs alike (no spaces, no path separators, no control chars).
 */
export function sanitizeName(name: string): string {
  const clean = String(name ?? "")
    .replace(/[^\w.-]+/g, "_")
    .replace(/^[._-]+|[._-]+$/g, "")
    .slice(0, NAME_MAX);
  return clean || "node";
}

function formatTimestamp(d: Date): string {
  const p = (n: number, w = 2) => String(n).padStart(w, "0");
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}_${p(d.getHours())}-${p(d.getMinutes())}-${p(d.getSeconds())}`;
}

export class FigmaExportStore {
  readonly rootDir: string;
  readonly stateFile: string;
  readonly logFile: string;

  constructor(opts: { rootDir: string; stateFile?: string; logFile?: string }) {
    this.rootDir = opts.rootDir;
    this.stateFile = opts.stateFile ?? path.join(this.rootDir, "bridge-state.json");
    this.logFile = opts.logFile ?? path.join(this.rootDir, "export-log.jsonl");
  }

  ensureDirs(): void {
    mkdirSync(this.rootDir, { recursive: true });
  }

  /**
   * Atomically write export bytes to disk and return the SavedExport record.
   * On filename collision appends "-2", "-3", … .
   */
  save(input: {
    bytes: Uint8Array;
    format: ExportFormat;
    nodeName: string;
    nodeId: string;
    scale: number;
  }): SavedExport {
    this.ensureDirs();
    const base = `${formatTimestamp(new Date())}_${sanitizeName(input.nodeName)}@${input.scale || 1}x.${input.format}`;
    let file = path.join(this.rootDir, base);
    for (let i = 2; existsSync(file); i++) {
      const stem = path.basename(base, path.extname(base));
      file = path.join(this.rootDir, `${stem}-${i}.${input.format}`);
    }
    const tmp = `${file}.tmp-${process.pid}`;
    writeFileSync(tmp, Buffer.from(input.bytes));
    renameSync(tmp, file);
    const now = new Date();
    return {
      path: file,
      nodeName: input.nodeName,
      nodeId: input.nodeId,
      format: input.format,
      scale: input.scale || 1,
      bytes: input.bytes.byteLength,
      createdAt: now.toISOString(),
      createdAtMs: now.getTime(),
    };
  }

  /** Append one JSON line to the export log; self-capped to a fixed budget. */
  appendLog(rec: SavedExport): void {
    this.ensureDirs();
    let line = `${JSON.stringify(rec)}\n`;
    try {
      if (existsSync(this.logFile) && statSync(this.logFile).size + line.length > LOG_MAX_BYTES) {
        const tail = readFileSync(this.logFile).slice(-LOG_TAIL_BYTES);
        line = `[…truncated…]\n${tail}${line}`;
        writeFileSync(this.logFile, line);
        return;
      }
    } catch {
      /* first write */
    }
    appendFileSync(this.logFile, line);
  }

  readState(): StoreState {
    try {
      const raw = JSON.parse(readFileSync(this.stateFile, "utf8")) as StoreState;
      if (typeof raw.exportsCount === "number" && (!raw.lastExport || typeof raw.lastExport.path === "string")) {
        return { port: raw.port ?? 0, exportsCount: raw.exportsCount, lastExport: raw.lastExport ?? null };
      }
    } catch {
      /* corrupt/absent — start fresh */
    }
    return { port: 0, exportsCount: 0, lastExport: null };
  }

  /** Shallow-merge the given fields into the state file (atomic write). */
  writeState(partial: Partial<StoreState>): void {
    this.ensureDirs();
    const merged: StoreState = { ...this.readState(), ...partial };
    const tmp = `${this.stateFile}.tmp-${process.pid}`;
    writeFileSync(tmp, JSON.stringify(merged, null, 2));
    renameSync(tmp, this.stateFile);
  }
}