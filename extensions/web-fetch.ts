// pi extension: web fetch for the model — Jina → Exa → Tavily → Scrapling fallback
//
// Source of truth: /opt/tintin/pi-extensions (github.com/hiiamtin/pi-extension-bundle)
//
// web_fetch tool:
//   fetches a URL and returns clean markdown/text for LLM consumption.
//   tries Jina Reader (key optional) → Exa (needs key) → Tavily (needs key)
//   → Scrapling (local python, stealth browser, no key).
//   missing keys skip their provider; failures fall through to the next.
//   `provider` param forces a specific provider instead of the chain.
//
// Keys (env vars take priority, then config file):
//   JINA_API_KEY, EXA_API_KEY, TAVILY_API_KEY
//   ~/.pi/agent/web-search-config.json { "tavilyApiKey", "exaApiKey", "jinaApiKey" }
//   (synced from Infisical omo project via `task omo-sync` + ~/.bashrc export)
//
// Scrapling tier requires: pip install scrapling[fetchers] && scrapling install

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { extractToolArgs, requireString, textResult } from "../lib/tool-compat.ts";
import { Type } from "typebox";
import { execFile } from "node:child_process";
import { readFileSync, appendFileSync, statSync, writeFileSync } from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

const CONFIG_FILE = path.join(os.homedir(), ".pi/agent/web-search-config.json");
const FETCH_TIMEOUT_MS = 30_000;
const SCRAPLING_TIMEOUT_MS = 90_000;
const DEFAULT_MAX_CHARS = 20_000;
const HARD_MAX_CHARS = 60_000;

export type FetchedPage = { title: string; content: string; url: string };
type FetchConfig = { tavilyApiKey?: string; exaApiKey?: string; jinaApiKey?: string };
type ProviderName = "jina" | "exa" | "tavily" | "scrapling";

type Ui = { notify: (msg: string, level: string) => void };

const DEBUG_LOG = process.env.PI_WEBFETCH_DEBUG_LOG
  || path.join(os.homedir(), ".pi/agent/web-fetch-debug.log");

// Same self-capping debug log pattern as web-search.ts (128KB max, keeps 32KB tail).
const DEBUG_MAX = 128 * 1024;
const DEBUG_TAIL = 32 * 1024;

function dbg(msg: string): void {
  try {
    if (!DEBUG_LOG.endsWith("debug.log")) return;
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
    /* never break fetch over logging */
  }
}

function loadConfig(): FetchConfig {
  const out: FetchConfig = {
    jinaApiKey: process.env.JINA_API_KEY || undefined,
    exaApiKey: process.env.EXA_API_KEY || undefined,
    tavilyApiKey: process.env.TAVILY_API_KEY || undefined,
  };
  try {
    const file = JSON.parse(readFileSync(CONFIG_FILE, "utf8")) as FetchConfig;
    if (!out.tavilyApiKey) out.tavilyApiKey = file.tavilyApiKey;
    if (!out.exaApiKey) out.exaApiKey = file.exaApiKey;
    if (!out.jinaApiKey) out.jinaApiKey = file.jinaApiKey;
  } catch { /* no config file */ }
  return out;
}

function clip(s: string, max: number): string {
  const t = s.trim();
  return t.length <= max ? t : `${t.slice(0, max - 1)}…\n[truncated ${t.length - max} chars]`;
}

// Strip Jina's "Title: / URL Source: / Markdown Content:" envelope.
function parseJina(raw: string, url: string): FetchedPage {
  const titleMatch = /^Title:\s*(.+)$/m.exec(raw);
  const contentMatch = /^Markdown Content:\s*\n?([\s\S]*)$/.exec(raw);
  return {
    title: titleMatch?.[1]?.trim() || url,
    content: (contentMatch?.[1] ?? raw).trim(),
    url,
  };
}

async function fetchJina(url: string, key?: string): Promise<FetchedPage> {
  dbg(`jina: url=${url} key=${key ? `${key.slice(0, 8)}…` : "(none, free tier)"}`);
  const headers: Record<string, string> = { Accept: "text/plain" };
  if (key) headers.Authorization = `Bearer ${key}`;
  const res = await fetch(`https://r.jina.ai/${url}`, {
    headers,
    signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
  });
  if (!res.ok) {
    const body = await res.text().catch(() => "<unreadable>");
    dbg(`jina: HTTP ${res.status} body=${body.slice(0, 300)}`);
    throw new Error(`jina HTTP ${res.status}: ${body.slice(0, 150)}`);
  }
  const page = parseJina(await res.text(), url);
  if (!page.content) throw new Error("jina returned empty content");
  dbg(`jina: OK ${page.content.length} chars`);
  return page;
}

async function fetchExa(url: string, key: string): Promise<FetchedPage> {
  dbg(`exa: url=${url} key=${key.slice(0, 8)}…`);
  const res = await fetch("https://api.exa.ai/contents", {
    method: "POST",
    headers: { "Content-Type": "application/json", "x-api-key": key },
    body: JSON.stringify({ ids: [url], text: true }),
    signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
  });
  if (!res.ok) {
    const body = await res.text().catch(() => "<unreadable>");
    dbg(`exa: HTTP ${res.status} body=${body.slice(0, 300)}`);
    throw new Error(`exa HTTP ${res.status}: ${body.slice(0, 150)}`);
  }
  const data = (await res.json()) as { results?: Array<{ title?: string; text?: string; url?: string }> };
  const r = data.results?.[0];
  if (!r?.text) throw new Error("exa returned no content");
  dbg(`exa: OK ${r.text.length} chars`);
  return { title: r.title || url, content: r.text, url: r.url || url };
}

async function fetchTavily(url: string, key: string): Promise<FetchedPage> {
  dbg(`tavily: url=${url} key=${key.slice(0, 12)}…`);
  const res = await fetch("https://api.tavily.com/extract", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ api_key: key, urls: [url] }),
    signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
  });
  if (!res.ok) {
    const body = await res.text().catch(() => "<unreadable>");
    dbg(`tavily: HTTP ${res.status} body=${body.slice(0, 300)}`);
    throw new Error(`tavily HTTP ${res.status}: ${body.slice(0, 150)}`);
  }
  const data = (await res.json()) as { results?: Array<{ raw_content?: string; title?: string; url?: string }>; failed_results?: unknown[] };
  const r = data.results?.[0];
  if (!r?.raw_content) throw new Error("tavily returned no content");
  dbg(`tavily: OK ${r.raw_content.length} chars`);
  return { title: r.title || url, content: r.raw_content, url: r.url || url };
}

// Last resort: local python Scrapling. Tries StealthyFetcher (bypasses
// Cloudflare etc.); falls back to plain Fetcher (TLS-spoofed HTTP) on ANY
// stealth failure — browser missing, launch error, blocked — before giving up.
async function fetchScrapling(url: string): Promise<FetchedPage> {
  dbg(`scrapling: url=${url} (spawning python)`);
  const script = [
    "import sys, json",
    "url = sys.argv[1]",
    "errors = []",
    "def extract(p):",
    "    t = p.css_first('title') if hasattr(p, 'css_first') else None",
    "    return ((t.text if t else '') or ''), p.get_all_text(separator='\\n')",
    "try:",
    "    from scrapling.fetchers import StealthyFetcher",
    "    p = StealthyFetcher.fetch(url, headless=True, network_idle=True)",
    "    if p.status and p.status >= 400:",
    "        errors.append(f'stealth HTTP {p.status}')",
    "    else:",
    "        title, text = extract(p)",
    "        if text.strip(): print(json.dumps({'title': title, 'text': text, 'error': None})); sys.exit(0)",
    "        errors.append('stealth: empty content')",
    "except Exception as e:",
    "    errors.append(f'stealth: {e}')",
    "try:",
    "    from scrapling.fetchers import Fetcher",
    "    p = Fetcher.get(url, impersonate='chrome')",
    "    if p.status >= 400:",
    "        errors.append(f'http HTTP {p.status}')",
    "    else:",
    "        title, text = extract(p)",
    "        if text.strip(): print(json.dumps({'title': title, 'text': text, 'error': None})); sys.exit(0)",
    "        errors.append('http: empty content')",
    "except Exception as e:",
    "    errors.append(f'http: {e}')",
    "print(json.dumps({'title': '', 'text': '', 'error': '; '.join(errors)}))",
  ].join("\n");
  const out = await new Promise<string>((resolve, reject) => {
    execFile("python3", ["-c", script, url], { timeout: SCRAPLING_TIMEOUT_MS, maxBuffer: 16 * 1024 * 1024 }, (e, stdout, stderr) => {
      if (stdout && stdout.trim().startsWith("{")) return resolve(stdout);
      reject(new Error(e?.message || stderr?.slice(0, 200) || "scrapling produced no output"));
    });
  });
  let parsed: { title?: string; text?: string; error?: string };
  try { parsed = JSON.parse(out); } catch { throw new Error(`scrapling unparseable output: ${out.slice(0, 150)}`); }
  if (parsed.error) throw new Error(parsed.error);
  const text = (parsed.text || "").trim();
  if (!text) throw new Error("scrapling returned empty content");
  dbg(`scrapling: OK ${text.length} chars`);
  return { title: parsed.title || url, content: text, url };
}

async function webFetch(url: string, provider?: string): Promise<{ provider: string; page: FetchedPage; errors: string[]; quotaWarnings: string[] }> {
  const config = loadConfig();
  const errors: string[] = [];
  const quotaWarnings: string[] = [];

  type Attempt = { name: ProviderName; run: () => Promise<FetchedPage>; needs: string | null };
  const attempts: Attempt[] = [
    { name: "jina", run: () => fetchJina(url, config.jinaApiKey), needs: null },
    { name: "exa", run: () => fetchExa(url, config.exaApiKey!), needs: config.exaApiKey ? null : "EXA_API_KEY" },
    { name: "tavily", run: () => fetchTavily(url, config.tavilyApiKey!), needs: config.tavilyApiKey ? null : "TAVILY_API_KEY" },
    { name: "scrapling", run: () => fetchScrapling(url), needs: null },
  ];

  const selected = provider
    ? attempts.filter((a) => a.name === provider)
    : attempts;

  if (selected.length === 0) {
    return { provider: "none", page: { title: "", content: "", url }, errors: [`unknown provider '${provider}' (use: jina | exa | tavily | scrapling)`], quotaWarnings };
  }

  // HTTP 402 / quota / balance errors mean the key is out of credit — surface
  // these in the tool result (not just the debug log) so the operator learns
  // the key needs top-up or removal instead of silently burning fallback quota.
  const isQuotaError = (msg: string) => /\b402\b|insufficient|out of (credit|token|quota)|quota.*(exhaust|exceed)|payment required/i.test(msg);

  for (const attempt of selected) {
    if (attempt.needs) {
      errors.push(`${attempt.name}: skipped (missing ${attempt.needs})`);
      dbg(`${attempt.name}: skipped, missing key`);
      continue;
    }
    try {
      const page = await attempt.run();
      if (page.content) return { provider: attempt.name, page, errors, quotaWarnings };
      errors.push(`${attempt.name}: empty content`);
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      errors.push(`${attempt.name}: ${msg}`);
      if (isQuotaError(msg)) {
        quotaWarnings.push(`${attempt.name} quota exhausted — top up or remove its key to stop burning fallback quota`);
        dbg(`${attempt.name}: QUOTA WARNING ${msg}`);
      }
    }
  }
  return { provider: "none", page: { title: "", content: "", url }, errors, quotaWarnings };
}

function formatPage(provider: string, page: FetchedPage, chars: number): string {
  const content = clip(page.content, chars);
  const title = page.title ? `\n\n# ${page.title}` : "";
  return `[web_fetch via ${provider}] ${page.url}${title}\n\n${content}`;
}

const PROVIDER_DESC = "Provider: jina | exa | tavily | scrapling. Omit for fallback chain (jina → exa → tavily → scrapling).";

export default function webFetchExtension(pi: ExtensionAPI): void {
  pi.registerTool({
    name: "web_fetch",
    label: "Web fetch",
    description: "Fetch a URL and return its content as clean markdown/text. Use after web_search to read a specific page, or to read docs/articles directly. Falls back jina → exa → tavily → scrapling automatically.",
    parameters: Type.Object({
      url: Type.String({ description: "URL to fetch (http/https)" }),
      provider: Type.Optional(Type.String({ description: PROVIDER_DESC })),
      maxChars: Type.Optional(Type.Number({ description: `Max characters of content to return (default ${DEFAULT_MAX_CHARS}, max ${HARD_MAX_CHARS})`, minimum: 500, maximum: HARD_MAX_CHARS })),
    }),
    // Uses extractToolArgs(): compatible with pi <0.84 execute(params) and
    // pi >=0.84 execute(toolCallId, params, ...). See tool-compat.ts.
    async execute(...cbArgs) {
      const args = extractToolArgs(cbArgs);
      const missing = requireString(args, "url");
      if (missing) return textResult(`web_fetch ${missing.errorText}`);
      const url = (args.url as string).trim();
      if (!/^https?:\/\//i.test(url)) return textResult(`web_fetch error: url must start with http:// or https:// (got ${url})`);
      const provider = typeof args.provider === "string" && args.provider.trim() ? args.provider.trim().toLowerCase() : undefined;
      const maxChars = Math.min(HARD_MAX_CHARS, Math.max(500, Math.round(Number(args.maxChars) || DEFAULT_MAX_CHARS)));

      const { provider: used, page, errors, quotaWarnings } = await webFetch(url, provider);
      if (!page.content) {
        return textResult(`web_fetch failed${provider ? ` (provider=${provider})` : " for all providers"}: ${errors.join("; ")}`);
      }
      let out = formatPage(used, page, maxChars);
      if (quotaWarnings.length > 0) out += `\n\n⚠ ${quotaWarnings.join(" | ")}`;
      return textResult(out);
    },
  });

  pi.registerCommand("webfetch", {
    description: "Test web fetch providers (jina → exa → tavily → scrapling)",
    handler: async (args: string, ctx: { ui: Ui }) => {
      const url = args.trim() || "https://example.com";
      const { provider, page, errors } = await webFetch(url);
      if (page.content) {
        ctx.ui.notify(`web_fetch OK via ${provider} (${page.content.length} chars):\n${formatPage(provider, page, 600)}`, "info");
      } else {
        ctx.ui.notify(`web_fetch failed: ${errors.join("; ")}`, "error");
      }
    },
  });
}

export { webFetch };
