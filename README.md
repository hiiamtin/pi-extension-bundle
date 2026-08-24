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
