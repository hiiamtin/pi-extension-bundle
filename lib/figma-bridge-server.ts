// Local HTTP bridge that receives PNG/SVG/JPG exports pushed by the
// pi-figma-bridge Figma plugin and persists them via FigmaExportStore.
//
// Design notes:
//   - Binds 127.0.0.1 by default (never reachable from the network).
//   - Every POST to /export must carry the `X-Figma-Bridge` header matching
//     the configured token. Browsers cannot set custom headers cross-origin
//     without a CORS preflight, and we never emit CORS headers, so a hostile
//     web page cannot CSRF a file write onto the user's disk.
//   - Pure Node with zero pi imports so the e2e test can drive it directly.

import { createServer } from "node:http";
import type { IncomingMessage, ServerResponse } from "node:http";
import type { ExportFormat, FigmaExportStore, SavedExport } from "./figma-export-store.ts";

export interface BridgeServerOptions {
  port: number;
  /** Value the plugin must present in the X-Figma-Bridge header. */
  token: string;
  store: FigmaExportStore;
  host?: string;
  maxBodyBytes?: number;
  /** Called (sync, after disk write) for every accepted export. */
  onExport?: (rec: SavedExport) => void;
}

export interface BridgeHandle {
  port: number;
  host: string;
  address: string;
  close: () => Promise<void>;
}

class HttpError extends Error {
  code: number;
  constructor(code: number, message: string) {
    super(message);
    this.code = code;
  }
}

const MIME_FORMATS: Record<string, ExportFormat> = {
  "image/png": "png",
  "image/svg+xml": "svg",
  "image/jpeg": "jpg",
};

function json(res: ServerResponse, code: number, body: unknown): void {
  const payload = JSON.stringify(body);
  res.writeHead(code, { "Content-Type": "application/json; charset=utf-8" });
  res.end(payload);
}

function safeDecode(header: string | string[] | undefined): string {
  const raw = Array.isArray(header) ? header[0] : header;
  if (!raw) return "";
  try {
    return decodeURIComponent(raw);
  } catch {
    return raw;
  }
}

function readBody(req: IncomingMessage, maxBytes: number): Promise<Uint8Array> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let total = 0;
    req.on("data", (chunk: Buffer) => {
      total += chunk.length;
      if (total > maxBytes) {
        // Signal the cap but keep the connection readable so the 413 JSON
        // response actually reaches the client. Destroying the socket here
        // would surface as ECONNRESET on the fetching side with no status.
        req.pause();
        reject(new HttpError(413, `body exceeds ${maxBytes} bytes`));
        return;
      }
      chunks.push(chunk);
    });
    req.on("end", () => resolve(new Uint8Array(Buffer.concat(chunks))));
    req.on("error", (e) => reject(e));
  });
}

type RouteResult = { code: number; body: unknown };

async function route(
  req: IncomingMessage,
  opts: BridgeServerOptions,
  maxBytes: number,
): Promise<RouteResult> {
  const url = (req.url ?? "/").split("?")[0];

  if (req.method === "GET" && url === "/healthz") {
    return { code: 200, body: { ok: true, service: "pi-figma-bridge" } };
  }
  // Never emit Access-Control-Allow-* headers; OPTIONS is refused outright.
  if (req.method === "OPTIONS") {
    return { code: 405, body: { ok: false, error: "method not allowed" } };
  }
  if (req.method !== "POST" || url !== "/export") {
    return { code: 404, body: { ok: false, error: "not found" } };
  }
  if (req.headers["x-figma-bridge"] !== opts.token) {
    return { code: 403, body: { ok: false, error: "forbidden" } };
  }

  const body = await readBody(req, maxBytes);

  const headerFormat = safeDecode(req.headers["x-format"]).toLowerCase();
  const contentType = Array.isArray(req.headers["content-type"])
    ? req.headers["content-type"][0].split(";")[0].trim()
    : req.headers["content-type"]?.split(";")[0].trim() ?? "";
  let format: ExportFormat;
  if (headerFormat === "svg" || headerFormat === "jpg" || headerFormat === "png") {
    format = headerFormat;
  } else if (MIME_FORMATS[contentType]) {
    format = MIME_FORMATS[contentType];
  } else {
    format = "png";
  }

  const scaleRaw = Number(Array.isArray(req.headers["x-scale"]) ? req.headers["x-scale"][0] : req.headers["x-scale"]);
  const scale = Math.min(16, Math.max(0.5, Number.isFinite(scaleRaw) ? scaleRaw : 1));

  const rec = opts.store.save({
    bytes: body,
    format,
    nodeName: safeDecode(req.headers["x-node-name"]),
    nodeId: safeDecode(req.headers["x-node-id"]),
    scale,
  });
  opts.onExport?.(rec);

  return {
    code: 200,
    body: {
      ok: true,
      path: rec.path,
      nodeName: rec.nodeName,
      nodeId: rec.nodeId,
      format: rec.format,
      scale: rec.scale,
      bytes: rec.bytes,
    },
  };
}

/** Start the bridge. Rejects on bind errors (e.g. EADDRINUSE). */
export function startBridgeServer(opts: BridgeServerOptions): Promise<BridgeHandle> {
  return new Promise((resolve, reject) => {
    const maxBytes = opts.maxBodyBytes ?? 256 * 1024 * 1024;
    const host = opts.host ?? "127.0.0.1";
    let settled = false;

    const server = createServer((req, res) => {
      void (async () => {
        let code = 500;
        let body: unknown = { ok: false, error: "internal" };
        try {
          const out = await route(req, opts, maxBytes);
          code = out.code;
          body = out.body;
        } catch (e) {
          const err = e instanceof Error ? e : new Error(String(e));
          code = err instanceof HttpError ? err.code : 500;
          body = { ok: false, error: err.message };
        }
        json(res, code, body);
      })();
    });

    server.on("error", (e) => {
      if (settled) return;
      settled = true;
      reject(e);
    });

    server.listen(opts.port, host, () => {
      if (settled) return;
      settled = true;
      // Don't hold the event loop open: in a live pi session the agent loop
      // keeps the process alive anyway, but a short-lived host (smoke tests,
      // scripts) must be able to exit with the bridge still listening.
      server.unref();
      const addr = server.address();
      const port = typeof addr === "object" && addr !== null ? addr.port : opts.port;
      const handle: BridgeHandle = {
        port,
        host,
        address: `http://${host}:${port}`,
        close: () =>
          new Promise((res) => {
            server.closeAllConnections?.();
            server.close(() => res());
          }),
      };
      resolve(handle);
    });
  });
}