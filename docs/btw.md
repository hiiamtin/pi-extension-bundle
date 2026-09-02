# /btw — Side-Question Extension for Pi

> **Status: v1 implemented** (`extensions/btw.ts`, commit `4ad694f`).
> Wire verification (§9) PASSED in live use — measured on a real thread:
> `cache read 140,992 · in 1,286 · out 1,075 · $0.0025` → **99.1% of input
> tokens served from the main thread's prompt cache**, confirming the
> byte-identical prefix replay works as designed. Deferred: bring-to-main,
> mid-stream steering, snapshot fallback.

Design document, pre-development. Everything below is verified against pi source
(`@earendil-works/pi-coding-agent` 0.x, `pi-ai` 0.84.4) or reverse-engineered
prior art. Sources listed at the end.

**Home: `@tintin/pi-extensions`** (`/opt/tintin/pi-extensions`, git
`github.com/hiiamtin/pi-extension-bundle`) — added as a single file
`extensions/btw.ts` (+ optional helpers in `lib/`), following the bundle's
flat-file convention. The bundle is already a pi local-path package, so the dev
loop is: edit → `/reload`. No new repo, no publishing step. pi-web shares
`~/.pi/agent`, so the command works in both TUI and web automatically.

---

## 1. Goal

A `/btw <question>` command: ask a quick side question **while the main agent is
working (or right after a turn)** and get an answer in an overlay — without the
question or answer ever entering the main conversation history.

Non-goals (v1):

- No tools execution in the side query (read-only Q&A).
- No modification of the main session file, ever.
- No agent loop — single completion per turn.

---

## 2. Prior art (research summary)

### 2.1 Claude Code `/btw` (reverse-engineered, v2.1.73)

- **Forks the real conversation context** (`forkContextMessages`) and sends a
  single-turn query through the **same shared agent loop**, neutered via:
  `maxTurns: 1`, `canUseTool → deny`, `maxThinkingTokens: 0`, `skipCacheWrite: true`.
- **Full tool schema is still sent to the API** (only execution is denied).
- Injects a `<system-reminder>` after the question: no tools, one-off, never
  promise actions.
- One-shot only (no follow-ups), uses the main model, overlay UI.
- `querySource`/`forkLabel: "side_question"` for telemetry.

### 2.2 `@narumitw/pi-btw` (npm, source read)

- Builds a **plain-text snapshot** of the main branch (user/assistant/tool lines),
  hard-capped at **40,000 chars**, truncated from the start.
- Calls `provider.streamSimple()` directly — no agent runtime, **no tools sent at all**.
- Multi-turn in-memory side threads, resume menu, model + thinkingLevel overrides,
  "bring to main" (insert Q&A into the main editor draft), heavy UI (~4,200 lines).
- Lossy: images, thinking blocks, and tool-result structure are dropped; tool
  results are `JSON.stringify`-dumped.

### 2.3 Rejected approach: fork the session / reuse the agent loop

- Forking creates session files (pollution, edge cases) and the loop adds
  tool-execution risk and latency for zero benefit in a no-tools Q&A.

### 2.4 Why Claude Code sends the tool schema (key insight)

On Anthropic, the prompt-cache reference is **`tools + system + messages` as one
byte-exact prefix**. Sending the same tools + system + history as the main thread
is what makes the side query a **cache hit** on the entire prefix (billed at
~10%). Sanitizing *anything* (dropping tools, rewriting the system prompt,
converting tool blocks to text) changes the prefix → guaranteed miss → full price
on every token.

Cost comparison (example: 60k-token history, 5k tool schema, 300-token question):

| Approach | Hit vs main? | Cost when hit | Cost when miss | Fidelity |
|---|---|---|---|---|
| No-cut (Claude-style) | yes | ~6.8k equiv (10% × 65k + 300) | 65k full (rare; see TTL note) | 100% |
| Cut/sanitize (pi-btw style) | never | — | ~25–30k every call (after compression) | ~95% |

`/btw` is typically used while the agent is running or seconds after a turn — the
main thread's cache (TTL 5 min, refreshed on every turn/hit) is almost always
warm, so hit rate is high in practice. A miss costs full price once; nothing
breaks.

---

## 3. Platform facts (verified in pi source)

| Fact | Source |
|---|---|
| Sessions store real `pi-ai` messages (incl. images, tool blocks, thinking blocks) | session format |
| `ctx.sessionManager.getBranch()` → current branch entries, read-only | extensions API |
| `Context = { systemPrompt?, messages, tools? }` — tools optional | `pi-ai/dist/types.d.ts` |
| `provider.streamSimple(model, context, options)` callable via `ctx.modelRegistry` (`completeSimple` pattern) | pi-ai, used by pi-btw |
| Cache: pi-ai auto-attaches `cache_control` to **system prompt, last tool, last user message**; `cacheRetention: "none" \| "short" \| "long"`, default `"short"` (`PI_CACHE_RETENTION=long` → 1h where supported) | `pi-ai/dist/api/anthropic-messages.js` |
| Anthropic cache entries are content-addressed and **additive** — a side query cannot overwrite the main thread's entry | Anthropic caching model |
| `transformMessages(messages, model)` is deterministic per model → prefix chains stay consistent per model | `pi-ai/dist/api/transform-messages.js` |
| Usage reports `cacheRead` / `cacheWrite` → we can display and verify savings | `pi-ai/dist/types.d.ts` |
| `before_agent_start` event carries the **fully assembled `systemPrompt`**; `pi.getSystemPromptOptions()` can rebuild it | extensions API types |
| Anthropic API rejects `tool_use`/`tool_result` blocks in messages when no `tools` are sent → sanitizing tool blocks is mandatory *if* we go the no-tools route | Anthropic validation |
| Model-switch + append-only history: switching back to a model used within TTL still hits its old chain; only the delta (messages added since) is billed full price. Chain breaks: tool set changes, system prompt changes, compaction, TTL expiry | derived from caching model |

**`skipCacheWrite` is irrelevant for us.** It exists in Claude Code because their
side query always shares the main model's cache namespace and one-shot suffixes
are never reused. In our multi-provider world: different side model → separate
namespace, nothing to clash; same model → entries are additive, the main chain
cannot be overwritten. Decision: leave `cacheRetention` at default (`"short"`),
which also lets side-thread follow-ups cache-hit their own first turn.

---

## 4. Design decisions (proposed for implementation)

| # | Decision | Choice |
|---|---|---|
| D1 | Context | **Real fork, byte-identical replay**: main tools schema (identical order/content), main system prompt, verbatim branch messages (incl. thinking blocks). Side question + `<system-reminder>` appended as the **last user message** (reminder at the end — the only non-replayed content) |
| D2 | Engine | `provider.streamSimple()` via `ctx.modelRegistry` (`completeSimple`). **No tool executor exists** → tool calls physically cannot run. If the response contains tool-call blocks, show a notice instead of the (missing) text |
| D3 | Cache | Default `cacheRetention: "short"` (configurable). Prefix-stability rule: replayed content must be byte-identical to the main thread's request; all volatile content (question, reminder) goes last |
| D4 | Model / thinking | Default = current model + current thinking level. Settings overrides: `model: "provider/id"`, `thinkingLevel`. Validate credentials via `getApiKeyAndHeaders`, fall back gracefully; clamp level with `getSupportedThinkingLevels(model)` |
| D5 | Follow-ups & threads | Yes. In-memory side threads (Map on the extension instance — pi rebuilds instances on session switch/reload, so threads are per-session by design). `/btw <question>` always **starts a new thread**; follow-ups go through the composer inside the thread; bare `/btw` opens a **resume menu** (newest first, pick manually — never auto-resume). First turn writes cache (+25% on suffix), follow-ups read it |
| D6 | System prompt source | Capture the assembled prompt from the `before_agent_start` event (store on the extension instance). Fallback: rebuild via `getSystemPromptOptions()`. If the session never ran a request, proceed with rebuilt prompt + empty/short history |
| D7 | UI | `ctx.ui.custom` fullscreen overlay: streaming answer, scrollable transcript, Esc = abort (AbortSignal), composer for follow-ups |
| D8 | Session purity | Zero writes to the session file. Nothing appended, nothing forked on disk. `/btw` traffic must not change session size |
| D9 | "Bring to main" | Deferred (post-v1). When added: format Q&A into the main editor via `ctx.ui.setEditorText()` (explicit user action, like pi-btw) |

### Why not the no-tools/sanitized variant?

It is a valid fallback (cheap on short threads, provider-agnostic, "cleaner"
requests), but it forfeits main-thread cache (100% miss) and drops fidelity. The
no-cut variant is strictly better for our stated usage (mid-task questions on a
warm cache) and is the same trade Claude Code made. Keep the sanitized snapshot
code path out of v1; revisit only if a use case appears for non-caching providers.

---

## 5. Request shape (no-cut)

```
POST <provider>
  tools:   <exactly the main thread's tool definitions>
  system:  <exactly the main thread's assembled system prompt>
  messages:
    ... <verbatim branch history, byte-identical, incl. thinking blocks>
    [user]  "<question>

             <system-reminder>This is a side question from the user. Answer it
             directly in a single response.

             CRITICAL CONSTRAINTS:
             - You have NO tools available — you cannot take any action
             - This is a one-off context addition; follow-ups exist but each is
               a separate single response
             - NEVER say 'Let me try…' or promise to take any action
             - If you don't know, say so — do not offer to investigate

             Simply answer with the information you have.</system-reminder>"
```

Options: `reasoning: <thinkingLevel>` (if ≠ off), `signal` (abort), default
`cacheRetention`. Auth via `modelRegistry.getApiKeyAndHeaders(model)`.

Cache behavior:

- Same model as main + warm TTL → prefix read ~10%, only the question+reminder
  full price. `usage.cacheRead > 0` proves the hit.
- Follow-up turn: previous Q&A becomes part of the prefix → previous turn's
  content read at 10%.
- Different side model (config): separate namespace, full price on everything we
  send — the "cheap model" trade-off is the user's choice.

---

## 6. Settings

`~/.pi/agent/pi-btw.json` — do **not** install `@narumitw/pi-btw` alongside
(command-name collision).

```json
{
  "model": "anthropic/claude-...-haiku",
  "thinkingLevel": "medium",
  "rememberThinkingLevelChanges": true,
  "cacheRetention": "short"
}
```

All fields optional. Missing `model` → current model; missing `thinkingLevel` →
current level (clamped to the resolved model's supported levels); invalid values
→ warn + fallback, never hard-fail.

---

## 7. Architecture

Added to the existing bundle (`/opt/tintin/pi-extensions`):

```
opt/tintin/pi-extensions/
├── docs/
│   └── btw.md                 ← this document
├── extensions/
│   └── btw.ts                 registerCommand("btw"), thread registry,
│                              context capture, message assembly, streamSimple
│                              call, overlay UI (single file, bundle convention)
└── lib/
    └── (only if btw.ts outgrows one file)
```

- No `package.json` changes needed (`"extensions": ["./extensions"]` already
  loads every `.ts` in that directory).
- Dev loop: edit `extensions/btw.ts` → `/reload` in pi. No build, no install.
- Commit style: `feat(btw): ...` / `fix(btw): ...` (bundle convention).
- Unit tests: the bundle currently has no test setup; if needed, a standalone
  `scripts/btw-test.ts` runner or keep tests out and rely on the wire-verification
  checklist in §9. Decide at implementation time.

Estimated size: ~400–500 lines (vs 4,200 in pi-btw — we skip the heavy UI kit,
bring-to-main, text-range selector, and per-screen menu framework).

---

## 8. Edge cases & risks

| Case | Handling |
|---|---|
| Model answers with a tool call | No executor exists; if response has tool-call blocks and no text, show "model tried to use a tool — side questions can't run tools" notice. Prompt already forbids it |
| Empty branch (fresh session) | Works: system prompt + tools + single user message (reminder notes no prior context). No cache to hit — fine |
| Main thread compacts mid-session | History shape changes → next side query is a miss once, then rebuilds. No failure |
| Thinking-block replay validation | Risk: providers may validate signatures. pi-ai handles signature compat (`allowEmptySignature`); Claude Code's real-world use of this exact pattern (thinking blocks in forked context, thinking off in request) indicates Anthropic accepts it. **Verify on first live test** |
| Non-Anthropic providers | Prefix identity still the right shape; OpenAI implicit caching (≥1024 tokens) hits with identical prefixes; providers without caching just bill full price. No code branches needed |
| TTL expiry (asked >5 min after last main request) | One full-price call, then warm again. Acceptable |
| Session replacement / extension reload | Thread Map resets (documented pi behavior); /btw degrades to fresh thread, never crashes |
| Abort mid-stream | AbortSignal wired to view Esc; partial text discarded, thread turn not recorded |
| Cost display | Render from `usage` (cacheRead/cacheWrite/input/output) so savings are visible |

---

## 9. Test plan

1. **Unit** (no network): context capture, byte-stable assembly (snapshot the
   `Context` for two consecutive follow-ups and diff the prefix), settings
   validation, abort path, tool-call-response path.
2. **Wire verification** (first live run): intercept request (proxy or debug log)
   and assert `tools`/`system`/`messages` are byte-identical to the main thread's
   last request; assert response `usage.cacheRead > 0` for same-model side query
   within TTL; assert follow-up reads cache.
3. **Manual**: session file size unchanged after `/btw`; abort mid-stream;
   model fallback when configured model lacks credentials; resume menu after
   in-session reload; empty-session `/btw`.

### Success criteria

- `/btw` produces **zero** growth in the session file.
- Same-model side query within TTL: `cacheRead` covers the entire prefix.
- Follow-up turn: cache read on prior turns; only the new question is full price.
- Answer latency ≈ single completion (no agent-loop overhead).

---

## 10. Decisions

Resolved 2025 (user-confirmed):

1. **Command name**: `/btw` (no `@narumitw/pi-btw` installed — no collision).
2. **Steering mid-stream**: deferred.
3. **Bring-to-main**: deferred to post-v1.
4. **Sanitized-snapshot fallback**: cut — single request shape for all providers.
5. **Bare `/btw`**: resume menu, newest first (never auto-resume); see D5 for
   thread semantics (`/btw xxx` then `/btw yyy` = two threads; follow-ups via
   composer, not repeated `/btw`).
6. **Verification**: wire verification on first live run (dump real request/response,
   assert prefix byte-identical to the main thread's last request and
   `usage.cacheRead > 0`) before adding any test runner.
7. **Web/pi-web**: **/ext-style mode split** — one core, UI layer by mode:
   `tui` → full overlay (streaming, composer, resume menu); `rpc` (pi-web) →
   answer via `ctx.ui.notify`, resume via `ctx.ui.select` (dialogs work in RPC),
   and in rpc mode `/btw <q>` continues the latest thread if one exists so
   follow-ups work without a persistent composer; `json`/`print` → guard + error.
   Custom components (`ui.custom`) are TUI-only per pi docs; dialogs are
   TUI+RPC capable — same pattern as `ext.ts`.

---

## 11. Sources

- Claude Code `/btw` reverse engineering:
  https://gist.github.com/ZhangHanDong/a123f194fc0e68c9d408355bd10746c6
  (static analysis of `@anthropic-ai/claude-code@2.1.73` + wire capture)
- Claude Code `/btw` writeup: https://ossama.is/writing/btw
- Official docs: https://code.claude.com/docs/en/commands
- `@narumitw/pi-btw` source: https://github.com/narumiruna/pi-extensions
  (`packages/pi-btw`)
- pi docs: extensions, sessions, tui; pi-ai source:
  `anthropic-messages.js` (cache_control placement, `cacheRetention`),
  `transform-messages.js`, `types.d.ts` (`Context`, usage)
