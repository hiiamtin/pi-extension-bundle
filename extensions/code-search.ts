// pi extension: instant code search via semble — native tools, no MCP needed.
//
// Why a native extension (instead of the semble MCP server via pi-mcp-adapter):
//   - Tools appear directly in the model's toolset (code_search / code_find_related)
//     — 1-step call, no proxy search + execute round trip.
//   - No MCP gateway/lazy-connect lifecycle; the CLI process is spawned only
//     when a tool is actually called.
//   - Extra surface the MCP server lacks: --content code|docs|config|all.
//
// Implements a thin wrapper around `semble search` / `semble find-related`
// (JSON output on stdout). Uses uvx so no permanent Python env is needed.
//
// Version: pinned via SEMBLE_VERSION env override, default 0.5.5 (latest).
// After any pi upgrade run: node scripts/smoke-test.mjs

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { extractToolArgs, requireString, textResult } from "../lib/tool-compat.ts";
import { Type } from "typebox";
import { execFile } from "node:child_process";
import { promisify } from "node:util";

const execFileP = promisify(execFile);

const SEMBLE_VERSION = process.env.SEMBLE_VERSION || "0.5.5";
const RUN_TIMEOUT_MS = 90_000; // first index of a remote repo can take a while
const DEFAULT_TOP_K = 5;
const DEFAULT_SNIPPET_LINES = 10; // signature + opening lines; 0 = locations only

type Ui = { notify: (msg: string, level: string) => void };

type SembleHit = { file_path: string; start_line: number; end_line: number; score: number; content?: string };

interface SembleOutput {
  query?: string;
  results: SembleHit[];
}

function sembleBaseArgs(): string[] {
  return ["--from", `semble[mcp]==${SEMBLE_VERSION}`, "semble"];
}

async function runSemble(subCmd: string, args: string[]): Promise<SembleOutput> {
  const cliArgs = [...sembleBaseArgs(), subCmd, ...args];
  try {
    const { stdout, stderr } = await execFileP("uvx", cliArgs, {
      timeout: RUN_TIMEOUT_MS,
      maxBuffer: 8 * 1024 * 1024,
      killSignal: "SIGKILL",
    });
    if (stderr && !stdout.trim()) throw new Error(stderr.trim().slice(0, 400));
    const parsed = JSON.parse(stdout.trim()) as SembleOutput;
    if (!Array.isArray(parsed.results)) throw new Error("unexpected semble output shape");
    return parsed;
  } catch (e) {
    const err = e as NodeJS.ErrnoException;
    if (err && err.killed) throw new Error(`semble ${subCmd} timed out after ${RUN_TIMEOUT_MS / 1000}s`);
    throw new Error(`semble ${subCmd} failed: ${err.message ?? String(err)}`);
  }
}

function formatHits(label: string, repo: string, hits: SembleHit[]): string {
  if (hits.length === 0) return `${label} in ${repo}: no matches`;
  const lines = hits.map((h, i) => {
    const at = `${h.file_path}:${h.start_line}${h.end_line && h.end_line !== h.start_line ? `-${h.end_line}` : ""}`;
    const score = h.score != null ? ` — score ${h.score.toFixed(3)}` : "";
    const snippet = h.content ? `\n${h.content.split("\n").map((l) => `   ${l}`).join("\n")}` : "";
    return `${i + 1}. ${at}${score}${snippet}`;
  });
  return `${label} in ${repo} (${hits.length} hit${hits.length === 1 ? "" : "s"})\n${lines.join("\n")}`;
}

function contentTypesArg(content: string | undefined): string[] {
  if (!content) return [];
  const allowed = new Set(["code", "docs", "config", "all"]);
  const v = content.trim().toLowerCase();
  return allowed.has(v) ? ["--content", v] : [];
}

export default function codeSearchExtension(pi: ExtensionAPI): void {
  pi.registerTool({
    name: "code_search",
    label: "Code search",
    description:
      "Instant code search (semble) across a local directory or git repo. Returns file paths and exact line ranges — use read at the reported location instead of re-searching. Query with function/class names or behavior descriptions, not error messages. User's cwd is used when repo is omitted.",
    parameters: Type.Object({
      query: Type.String({ description: "Natural language or code query describing what the code does or its name" }),
      repo: Type.Optional(Type.String({ description: "Local dir or https:// git URL (default: current working directory)" })),
      top_k: Type.Optional(Type.Number({ description: `Number of results (default ${DEFAULT_TOP_K})`, minimum: 1, maximum: 20 })),
      max_snippet_lines: Type.Optional(Type.Number({ description: `Lines of source per result. ${DEFAULT_SNIPPET_LINES} = signature + body, 0 = location only, null = full chunk`, minimum: 0 })),
      content: Type.Optional(Type.String({ description: "Content types: code (default) | docs | config | all" })),
    }),
    async execute(...cbArgs) {
      const args = extractToolArgs(cbArgs);
      const missing = requireString(args, "query");
      if (missing) return textResult(`code_search ${missing.errorText}`);
      const query = (args.query as string).trim();
      const repo = (args.repo as string | undefined)?.trim() || pi.cwd;
      const topK = Math.max(1, Math.min(20, Math.round(Number(args.top_k) || DEFAULT_TOP_K)));
      const snippetLines = args.max_snippet_lines === undefined || args.max_snippet_lines === null
        ? DEFAULT_SNIPPET_LINES
        : Math.max(0, Math.round(Number(args.max_snippet_lines)));
      const cliArgs = [query, repo, "-k", String(topK), "--max-snippet-lines", String(snippetLines), ...contentTypesArg(args.content as string | undefined)];
      const out = await runSemble("search", cliArgs);
      return textResult(formatHits("[code_search]", repo, out.results));
    },
  });

  pi.registerTool({
    name: "code_find_related",
    label: "Find related code",
    description:
      "Find code similar to a known location (semble) — all implementations of an interface, callers of a function, or tests for a class. Use after code_search; pass file_path and line from a search result.",
    parameters: Type.Object({
      file_path: Type.String({ description: "File path as reported by code_search (e.g. src/lib/foo.ts)" }),
      line: Type.Number({ description: "Line number (1-indexed) from a code_search result", minimum: 1 }),
      repo: Type.Optional(Type.String({ description: "Local dir or https:// git URL (default: current working directory)" })),
      top_k: Type.Optional(Type.Number({ description: `Number of results (default ${DEFAULT_TOP_K})`, minimum: 1, maximum: 20 })),
      max_snippet_lines: Type.Optional(Type.Number({ description: `Lines of source per result. ${DEFAULT_SNIPPET_LINES} = signature + body, 0 = location only, null = full chunk`, minimum: 0 })),
      content: Type.Optional(Type.String({ description: "Content types: code (default) | docs | config | all" })),
    }),
    async execute(...cbArgs) {
      const args = extractToolArgs(cbArgs);
      const missing = requireString(args, "file_path");
      if (missing) return textResult(`code_find_related ${missing.errorText}`);
      const filePath = (args.file_path as string).trim();
      const line = Math.max(1, Math.round(Number(args.line) || 1));
      const repo = (args.repo as string | undefined)?.trim() || pi.cwd;
      const topK = Math.max(1, Math.min(20, Math.round(Number(args.top_k) || DEFAULT_TOP_K)));
      const snippetLines = args.max_snippet_lines === undefined || args.max_snippet_lines === null
        ? DEFAULT_SNIPPET_LINES
        : Math.max(0, Math.round(Number(args.max_snippet_lines)));
      const cliArgs = [filePath, String(line), repo, "-k", String(topK), "--max-snippet-lines", String(snippetLines), ...contentTypesArg(args.content as string | undefined)];
      const out = await runSemble("find-related", cliArgs);
      return textResult(formatHits("[code_find_related]", repo, out.results));
    },
  });

  pi.registerCommand("codesearch", {
    description: "Human test: run semble search and print results (uses cwd)",
    handler: async (args: string, ctx: { ui: Ui }) => {
      const query = args.trim();
      if (!query) {
        ctx.ui.notify("usage: /codesearch <query> [top_k] [content=code|docs|config|all]", "error");
        return;
      }
      try {
        const out = await runSemble("search", [query, pi.cwd, "-k", String(DEFAULT_TOP_K), "--max-snippet-lines", String(DEFAULT_SNIPPET_LINES)]);
        ctx.ui.notify(formatHits("[code_search]", pi.cwd, out.results), out.results.length > 0 ? "info" : "warning");
      } catch (e) {
        ctx.ui.notify(e instanceof Error ? e.message : String(e), "error");
      }
    },
  });
}

export { codeSearchExtension };