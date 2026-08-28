# pi-extensions

pi coding agent extensions for the TinTin setup. Installed as a pi package.

## Extensions

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
  ext.ts           /ext — manage extensions from within pi
  quota.ts         AI provider quota status + quota_check tool
  web-search.ts    web_search tool (Tavily/Exa/DuckDuckGo fallback)
  web-fetch.ts     web_fetch tool (Jina/Exa/Tavily/Scrapling fallback)
  tool-compat.ts   shared helpers: signature normalization + loud param validation
scripts/
  smoke-test.mjs   run after any pi upgrade (see web-search section above)
```

## Install

VM (dev, live-edit): registered as a local-path package by `task pi-extensions-setup`
(tintin-hq-infra). Edits take effect after `/reload` in pi.

Other machines:

```bash
pi install git:github.com/hiiamtin/pi-extensions@v1
```

Update pinned ref:

```bash
pi install git:github.com/hiiamtin/pi-extensions@v2   # move to new tag
pi update --extensions                                  # reconcile to configured ref
```
