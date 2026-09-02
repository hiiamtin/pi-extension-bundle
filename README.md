# pi-extensions

pi coding agent extensions for the TinTin setup. Installed as a pi package.

## Extensions

### code-search.ts — instant code search via semble

Registers `code_search` + `code_find_related` tools wrapping semble's CLI
(uvx, JSON output on stdout) — no MCP needed:

- `code_search`: natural-language / symbol query over a local dir or https
git URL → file paths + exact line ranges.
- `code_find_related`: find similar code from a known location (all
implementations of an interface, callers of a function, tests for a class).
- Both accept `repo?` (default `pi.cwd`), `top_k?`, `max_snippet_lines?`
(0 = locations only, null = full chunk), `content?` (`code|docs|config|all`
— extra surface the MCP server lacks).
- Version pinned via `SEMBLE_VERSION` env (default `0.5.5`).
- `/codesearch <query>` — human test command.

Why native instead of the semble MCP server: tools appear directly in the
model's toolset (1-step, no proxy search+execute round trip), no
lazy-connect lifecycle, process spawns only when actually called.

### quota.ts — AI provider quota status

Bridges the ai-cost MCP server (`get_quota`):
- Footer status line: `/quota status all|current|off`
- `/quota` — full panel (widget above editor)
- `/quota refresh` — bypass the 5-min cache
- `/quota tools on|off` — expose `quota_check` tool to the model

No-ops silently on machines without the ai-cost binary at `~/.local/bin/ai-cost`.

### web-search.ts — web search for the model

Registers the `web_search` tool with a 3-provider fallback chain:

```
Tavily (if key) → Exa (if key) → DuckDuckGo (keyless, always available)
```

- Missing keys skip their provider — DuckDuckGo works with zero config.
- Keys: `~/.pi/agent/web-search-config.json`:
  ```json
  { "tavilyApiKey": "tvly-...", "exaApiKey": "..." }
  ```
- `/websearch [query]` — human test command showing which provider served.

### web-fetch.ts — web fetch for the model

Registers the `web_fetch` tool: fetch a URL, return clean markdown/text for LLM
consumption. Optional `provider` param forces one provider; default runs the
fallback chain:

```
Jina Reader (key optional) → Exa (if key) → Tavily (if key) → Scrapling (local python)
```

- Params: `url` (required), `provider?` (`jina|exa|tavily|scrapling`), `maxChars?`
  (default 20000, max 60000).
- Jina works keyless (free tier, ~20 RPM); `JINA_API_KEY` raises limits and
  avoids anonymous blocks.
- Keys (env vars take priority, then the shared config file):
  `JINA_API_KEY`, `EXA_API_KEY`, `TAVILY_API_KEY` — synced from Infisical (omo
  project) via `task omo-sync` + `~/.bashrc` export.
- `/webfetch [url]` — human test command showing which provider served.
- Debug log: `~/.pi/agent/log/web-fetch-debug.log` (same self-cap pattern;
  override with `PI_WEBFETCH_DEBUG_LOG=/path`).

#### Scrapling tier (optional, one-time setup)

The last-resort tier spawns `python3` with an inline script — the extension
does NOT install Scrapling itself. Missing setup only breaks this tier
(graceful error; jina/exa/tavily still cover the chain). One-time install:

```bash
pip install --user --break-system-packages "scrapling[fetchers]" "camoufox[geoip]"
python3 -m camoufox fetch          # stealth browser (~150MB)
python3 -m playwright install chromium
```

The script itself double-falls-back: StealthyFetcher (Camoufox, bypasses
Cloudflare Turnstile) → Fetcher (TLS-spoofed HTTP, fast) → JSON error.

### bg-task.ts — background task runner

Keeps the conversation responsive while long jobs run (real-world trigger: a
brute-force node solver pinned a session for 10+ minutes; `task logs-*` with
`logs -f` never exits). The model gets non-blocking tools:

- `bg_run(command, name?, timeout_min?, detach?)` — spawn detached in its own
  process group at `nice 15 / ionice -c3` (can never starve the docker stack);
  returns a task id immediately. Warns (in the tool result) when the command
  looks like follow mode (`-f`/`--follow`/`watch`) so the model can decide to
  kill it later — it never blocks the chat either way. `detach: true` streams
  output straight to the log file via fd: the task survives pi restarts and
  its real exit code is recorded to `<id>/exitcode` by a wrapper shell (no
  live rotation in this mode). `watch: ["ready", "ERROR"]` wakes the agent
  mid-run (once per pattern) when the output matches — pipe mode only.
- `bg_status(id_or_name?)` — one task or ALL tasks **across every pi session on
  the machine** (shared state dir), incl. orphans from dead sessions.
- `bg_log(id_or_name, tail_lines?)` — cheap tail of the rolling log (rotates at
  `PI_BG_LOG_CAP_MB`, keeps one old file; fixed memory, bounded disk).
- `bg_wait(id_or_name, timeout_sec?)` — block up to N seconds for a short task
  and get its result in the same turn (returns immediately if already done;
  on timeout the task keeps running and the exit notification still fires).
- `bg_artifact(id?, path?, max_entries?)` — token-safe summary of a result
  file: JSON → array length + item shape + first entries; JSONL → record
  count + shape; CSV → columns + rows + sample; text → head/tail. Files over
  8MB are previewed via fd reads (head+tail only, O(1) memory). With `id` and
  no path it summarizes the task's captured output instead.
- `bg_kill(id_or_name)` — SIGTERM the whole process group, SIGKILL after 5s —
  verified zero leftover children in e2e (`pgrep -g` = 0 after kill).

All id params also accept the unique case-insensitive task **name** (latest
match) — e.g. `bg_kill("dev-server")`.

**Follow-mode interceptor** (`PI_BG_INTERCEPTOR`, default `auto-bg`): the
built-in `bash` tool is watched. Detection is **scoped per command** (heredoc
bodies and quoted strings are data, never options) so common `-f` flags never
false-positive:

- Caught: `docker[/compose|podman|kubectl|crictl] logs -f`, `tail -f`,
  `journalctl/systemctl/dmesg -f`, `watch`/`entr`, and tintin's
  `task logs-*` (the Taskfile expands to `logs --tail N -f`) — anywhere in a
  pipeline (`&&`, `;`, `|`).
- Never caught: `rm -f`, `grep -f`, `curl -fsSL`, `git log -f`, `ping -f`,
  quoted/heredoc mentions, and anything prefixed with `timeout` (bounded).

Modes:

- `auto-bg` (default) — don't ask: the command is started as a background
  task directly and the model gets the task id back. A blocking call to a
  follow command is always wrong (pi only sees output when a process exits —
  follow never does), and this saves the block→retry round trip entirely.
- `warn` — a caught command is blocked ONCE with a short reason telling the
  model to use `bg_run` or add `timeout`; repeating the exact command is
  allowed through (warn, let the model decide).
- `off` — no interception.

On exit, the owning session gets a `bg-task` custom message with
`triggerTurn: true`, so the model announces the result proactively (elapsed,
exit code, last output, log path) instead of the user polling.
`pi.sendMessage` is late-bound (read at call time) — capturing it at load
got a `notInitialized` placeholder and silently broke every notification.
Delivery is **strictly scoped to the owning session** (identity = the
session file, not pid — pid is shared across pi-web sessions): foreign
finished tasks wait for their owner session's next activation; another
session adopts them only when the owner session file has been deleted.
If the watcher dies anyway (reload/restart), `notifiedAt` stays unset and
the owner session surfaces the finished task at its own next `session_start`.

Delivery is **mode-aware** (detected from how many session files have ever
been seen):

- **Single session (TUI / one pi-web tab):** the plain sendMessage push always
  works — one bound api, nothing ambiguous. The context-hook injector and the
  input/tool_call/session_info_changed sweeps are skipped entirely (zero disk
  I/O, zero prompt mutation, provider prompt caches stay untouched). Only the
  exit fast path + session_start adoption are active.
- **Multi-session (pi-web, 2+ tabs):** `sendMessage` learns which api belongs
  to which session — the loader runs a session's factory milliseconds before
  that session's `session_start`, so each start claims the captures since the
  previous one (per-session api list, splice-proof by holding object refs).
  Delivery targets ONLY the owner's own apis — the notice queues in the
  owner's session (`deliverAs: nextTurn`, no wake) even while you watch
  another tab. The `context` hook stays as the guarantee layer: it injects the
  pending notice into the owner's very next LLM call when no push landed.
Retention of finished-but-unnotified tasks is 7 days. All attempts are logged
to `~/.pi/agent/log/bg-task-debug.log`.

Human commands: `/bg` (interactive picker — pick a task to inspect or kill
with confirm), `/bg kill <id>`, `/bg on|off` (expose tools to the model AND
gate the interceptor, default on).

- State: `~/.pi/agent/bg-tasks/<id>/{meta.json,out.log,out.1.log}` with
  heartbeats (stale heartbeat + live process ⇒ `orphan`), auto-prune after
  `PI_BG_PRUNE_HOURS` (168 = 7 days).
- Config: `PI_BG_STATE_DIR`, `PI_BG_MAX_CONCURRENT` (8), `PI_BG_LOG_CAP_MB`
  (2), `PI_BG_PRUNE_HOURS` (168 = 7d), `PI_BG_DEFAULT_TIMEOUT_MIN` (0 = none),
  `PI_BG_INTERCEPTOR` (`auto-bg` | `warn` | `off`),
  `PI_BG_TICK_MS` (5000 — scan/heartbeat cadence while tasks run).
- Limitation: pipe-mode tasks whose output exceeds the pipe buffer die if the
  pi process itself exits mid-run (marked `gone` on the next scan) — use
  `detach: true` for jobs that must survive restarts.
- `/bg` commands in pi-web work too (widget renders above the editor in both
  TUI and pi-web).

#### pi-version compatibility (IMPORTANT)

pi ≥0.84 changed the tool calling convention from `execute(params)` to
`execute(toolCallId, params, signal, onUpdate, context)`. All tools in this
package go through `extensions/tool-compat.ts::extractToolArgs()`, which works
with BOTH conventions, and validate required params via `requireString()` so a
missing param fails loudly instead of silently sending `undefined` upstream.

- Debug log: `~/.pi/agent/log/web-search-debug.log` (self-capped at 128KB,
  truncates to last 32KB). Override location with `PI_WEBSEARCH_DEBUG_LOG=/path`.
- **After every `pi` upgrade, run the smoke test:**
  ```bash
  node scripts/smoke-test.mjs
  ```
  It loads all extensions and calls each registered tool under BOTH calling
  conventions; exit code 0 (`ALL OK`) means safe to use. Detects the silent
  param-loss failure mode that once broke web_search (query=undefined →
  upstream HTTP 422/400).

## Repo layout

```
extensions/
  ext.ts           /ext — manage extensions, packages & skills from within pi
  code-search.ts   code_search / code_find_related tools (semble CLI bridge)
  quota.ts         AI provider quota status + quota_check tool
  web-search.ts    web_search tool (Tavily/Exa/DuckDuckGo fallback)
  web-fetch.ts     web_fetch tool (Jina/Exa/Tavily/Scrapling fallback)
  bg-task.ts       bg_run / bg_status / bg_log / bg_kill background tasks + /bg
lib/
  tool-compat.ts   shared helpers: signature normalization + loud param validation
scripts/
  smoke-test.mjs   run after any pi upgrade (see web-search section above)
```

Note: tool-compat.ts lives under `lib/` (extensions import it as
`../lib/tool-compat.ts`).

## Install

VM (dev, live-edit): registered as a local-path package by `task pi-extensions-setup`
(tintin-hq-infra). Edits take effect after `/reload` in pi.

Other machines:

```bash
pi install git:github.com/hiiamtin/pi-extension-bundle@v1
```

Update pinned ref:

```bash
pi install git:github.com/hiiamtin/pi-extension-bundle@v2   # move to new tag
pi update --extensions                                  # reconcile to configured ref
```
