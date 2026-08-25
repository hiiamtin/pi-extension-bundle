// pi extension: web search for the model — Tavily → Exa → DuckDuckGo fallback
//
// Source of truth: /opt/tintin/pi-extensions (github.com/hiiamtin/pi-extensions)
// Registered as a pi package via `task pi-extensions-setup` (tintin-hq-infra).
//
// web_search tool:
//   tries Tavily (needs key) → Exa (needs key) → DuckDuckGo (keyless, always available)
//   missing keys skip their provider; all failures fall through to the next.
//
// Keys: ~/.pi/agent/web-search-config.json { "tavilyApiKey": "...", "exaApiKey": "..." }
// (synced from Infisical by `task pi-web-search-keys`; hand-edit works too)

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { extractToolArgs, requireString, textResult } from "./tool-compat.ts";
import { Type } from "typebox";
import { readFileSync, appendFileSync, statSync, writeFileSync } from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

const CONFIG_FILE = path.join(os.homedir(), ".pi/agent/web-search-config.json");
const FETCH_TIMEOUT_MS = 15_000;
const SNIPPET_MAX = 220;
const DEFAULT_RESULTS = 5;

type SearchResult = { title: string; url: string; snippet: string };
type SearchConfig = { tavilyApiKey?: string; exaApiKey?: string };

type Ui = { notify: (msg: string, level: string) => void };

const DEBUG_LOG = process.env.PI_WEBSEARCH_DEBUG_LOG
  || path.join(os.homedir(), ".pi/agent/web-search-debug.log");

// Append a timestamped line to ~/.pi/agent/web-search-debug.log (best-effort).
// Self-capping: file is truncated to its last DEBUG_TAIL bytes once it exceeds
// DEBUG_MAX, so it can never grow unbounded.
const DEBUG_MAX = 128 * 1024;
const DEBUG_TAIL = 32 * 1024;

function dbg(msg: string): void {
  try {
    if (!DEBUG_LOG.endsWith("debug.log")) return; // sanity guard
    let line = `[${new Date().toISOString()}] ${msg}\n`;
    try {
      if (statSync(DEBUG_LOG).size + line.length > DEBUG_MAX) {
        const tail = readFileSync(DEBUG_LOG).slice(-DEBUG_TAIL);
        line = `[…truncated…]\n${tail}${line}`;
        writeFileSync(DEBUG_LOG, line);
        return;
      }
    } catch { /* first write */ }
    appendFileSync(DEBUG_LOG, line);
  } catch {
    /* never break search over logging */
  }
}

function loadConfig(): SearchConfig {
  try {
    return JSON.parse(readFileSync(CONFIG_FILE, "utf8")) as SearchConfig;
  } catch {
    return {};
  }
}

function clip(s: string, max = SNIPPET_MAX): string {
  const t = s.replace(/\s+/g, " ").trim();
  return t.length <= max ? t : `${t.slice(0, max - 1)}…`;
}

function dedupe(results: SearchResult[]): SearchResult[] {
  const seen = new Set<string>();
  return results.filter((r) => {
    if (!r.url || seen.has(r.url)) return false;
    seen.add(r.url);
    return true;
  });
}

async function searchTavily(query: string, numResults: number, key: string): Promise<SearchResult[]> {
  dbg(`tavily: query=${JSON.stringify(query)} numResults=${numResults} key=${key.slice(0, 12)}…`);
  const res = await fetch("https://api.tavily.com/search", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ api_key: key, query, max_results: numResults }),
    signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
  });
  if (!res.ok) {
    const body = await res.text().catch(() => "<unreadable>");
    dbg(`tavily: HTTP ${res.status} body=${body.slice(0, 500)}`);
    throw new Error(`tavily HTTP ${res.status}: ${body.slice(0, 200)}`);
  }
  dbg("tavily: OK");
  const data = (await res.json()) as { results?: Array<{ title?: string; url?: string; content?: string }> };
  const out = (data.results ?? []).map((r) => ({
    title: r.title ?? "",
    url: r.url ?? "",
    snippet: clip(r.content ?? ""),
  }));
  if (out.length === 0) throw new Error("tavily returned no results");
  return out;
}

async function searchExa(query: string, numResults: number, key: string): Promise<SearchResult[]> {
  dbg(`exa: query=${JSON.stringify(query)} numResults=${numResults} key=${key.slice(0, 8)}…`);
  const res = await fetch("https://api.exa.ai/search", {
    method: "POST",
    headers: { "Content-Type": "application/json", "x-api-key": key },
    body: JSON.stringify({ query, numResults, contents: { text: { maxCharacters: SNIPPET_MAX } } }),
    signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
  });
  if (!res.ok) {
    const body = await res.text().catch(() => "<unreadable>");
    dbg(`exa: HTTP ${res.status} body=${body.slice(0, 500)}`);
    throw new Error(`exa HTTP ${res.status}: ${body.slice(0, 200)}`);
  }
  dbg("exa: OK");
  const data = (await res.json()) as { results?: Array<{ title?: string; url?: string; text?: string }> };
  const out = (data.results ?? []).map((r) => ({
    title: r.title ?? "",
    url: r.url ?? "",
    snippet: clip(r.text ?? ""),
  }));
  if (out.length === 0) throw new Error("exa returned no results");
  return out;
}

// Keyless last resort: DDG's HTML endpoint. hrefs arrive as /l/?uddg=<urlencoded>.
async function searchDuckDuckGo(query: string, numResults: number): Promise<SearchResult[]> {
  dbg(`ddg: query=${JSON.stringify(query)}`);
  const res = await fetch("https://html.duckduckgo.com/html/", {
    method: "POST",
    headers: {
      "Content-Type": "application/x-www-form-urlencoded",
      "User-Agent": "Mozilla/5.0 (X11; Linux x86_64; rv:130.0) Gecko/20100101 Firefox/130.0",
    },
    body: new URLSearchParams({ q: query }).toString(),
    signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
  });
  if (!res.ok) {
    const body = await res.text().catch(() => "<unreadable>");
    dbg(`ddg: HTTP ${res.status} body=${body.slice(0, 300)}`);
    throw new Error(`duckduckgo HTTP ${res.status}`);
  }
  const html = await res.text();
  const out: SearchResult[] = [];
  const anchor = /<a[^>]+class="[^"]*result__a[^"]*"[^>]+href="([^"]+)"[^>]*>([\s\S]*?)<\/a>/g;
  let m: RegExpExecArray | null;
  while ((m = anchor.exec(html)) !== null && out.length < numResults) {
    let url = m[1];
    const uddg = /[?&]uddg=([^&]+)/.exec(url);
    if (uddg) url = decodeURIComponent(uddg[1]);
    if (!/^https?:\/\//.test(url)) continue;
    const title = m[2].replace(/<[^>]+>/g, "");
    out.push({ title: clip(title, 120), url, snippet: "" });
  }
  dbg(`ddg: parsed ${out.length} results (httpBody ${(html ?? "").length} bytes)`);
  if (out.length === 0) throw new Error("duckduckgo returned no results");
  return out;
}

async function webSearch(query: string, numResults: number): Promise<{ provider: string; results: SearchResult[]; errors: string[] }> {
  const config = loadConfig();
  const errors: string[] = [];
  const attempts: Array<[string, () => Promise<SearchResult[]>]> = [];
  if (config.tavilyApiKey) attempts.push(["tavily", () => searchTavily(query, numResults, config.tavilyApiKey!)]);
  if (config.exaApiKey) attempts.push(["exa", () => searchExa(query, numResults, config.exaApiKey!)]);
  attempts.push(["duckduckgo", () => searchDuckDuckGo(query, numResults)]);

  for (const [provider, run] of attempts) {
    try {
      const results = dedupe(await run());
      if (results.length > 0) return { provider, results, errors };
      errors.push(`${provider}: no usable results`);
    } catch (e) {
      errors.push(`${provider}: ${e instanceof Error ? e.message : String(e)}`);
    }
  }
  return { provider: "none", results: [], errors };
}

function formatResults(query: string, provider: string, results: SearchResult[]): string {
  const lines = results.map((r, i) => {
    const title = r.title || r.url;
    const snippet = r.snippet ? `\n   ${r.snippet}` : "";
    return `${i + 1}. ${title} — ${r.url}${snippet}`;
  });
  return `[web_search via ${provider}] "${query}"\n${lines.join("\n")}`;
}

export default function webSearchExtension(pi: ExtensionAPI): void {
  pi.registerTool({
    name: "web_search",
    label: "Web search",
    description: "Search the web. Use for current information, error messages, library docs, or anything not in the codebase.",
    parameters: Type.Object({
      query: Type.String({ description: "Search query" }),
      numResults: Type.Optional(Type.Number({ description: `Number of results (default ${DEFAULT_RESULTS}, max 10)`, minimum: 1, maximum: 10 })),
    }),
    // Uses extractToolArgs(): compatible with pi <0.84 execute(params) and
    // pi >=0.84 execute(toolCallId, params, ...). See tool-compat.ts.
    async execute(...cbArgs) {
      const args = extractToolArgs(cbArgs);
      const missing = requireString(args, "query");
      if (missing) return textResult(`web_search ${missing.errorText}`);
      const query = (args.query as string).trim();
      const numResults = Math.min(10, Math.max(1, Math.round(Number(args.numResults) || DEFAULT_RESULTS)));
      const { provider, results, errors } = await webSearch(query, numResults);
      if (results.length === 0) {
        return textResult(`web_search failed for all providers: ${errors.join("; ")}`);
      }
      return textResult(formatResults(query, provider, results));
    },
  });

  pi.registerCommand("websearch", {
    description: "Test web search providers (tavily → exa → duckduckgo)",
    handler: async (args: string, ctx: { ui: Ui }) => {
      const query = args.trim() || "pi coding agent";
      const { provider, results, errors } = await webSearch(query, 3);
      if (results.length > 0) {
        ctx.ui.notify(`web_search OK via ${provider}:\n${formatResults(query, provider, results)}`, "info");
      } else {
        ctx.ui.notify(`web_search failed: ${errors.join("; ")}`, "error");
      }
    },
  });
}

export { webSearchExtension };
