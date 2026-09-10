# Subagent Extension for Pi — Design Document

> **Status: P1 IMPLEMENTED & LIVE-ACCEPTED (2026-09-05, HEAD `5b0d79a`).** Wire
> verification (§12) PASSED on pi 0.85.0; see §14 for the implementation
> record, roster pins, and the P2/P3 entry checklist. This document supersedes
> the earlier draft entirely — every decision below was re-derived through a
> structured grilling session (requirements first, then architecture, surface,
> lifecycle).
>
> **Home:** `@tintin/pi-extensions` (`/opt/tintin/pi-extensions`, git
> `github.com/hiiamtin/pi-extension-bundle`). Single file
> `extensions/subagent.ts` + shared machinery in `lib/agent-runs.ts` + agent
> definitions in `agents/*.md`. Dev loop: edit → `/reload`. The bundle is a
> local-path pi package; no publishing step.

---

## 1. Goal & use cases (priority order)

A `subagent` tool: delegate a task to a specialized child agent running in an
**isolated context window** (own system prompt, tool allowlist, optional own
model), returning only the result to the parent conversation.

Ranked by real usage (from grilling):

1. **Context preservation** — child reads/searches a lot, parent receives only
   the compressed finding. This is the #1 reason the extension exists.
2. **Parallel fan-out** — e.g. BE and FE work streams at the same time.
3. **Talk-while-waiting** — background opt-in: parent stays conversational
   while a long child runs; result arrives via notification.

Secondary: specialist personas (reviewer etc.); a second-opinion "oracle" is
just another agent `.md` file — zero code, evaluate by trying (evidence:
Anthropic multi-agent engineering post; Du et al. 2023 multiagent debate —
real gains, but 2–15× token cost; only worth it where mistakes are expensive).

**Primary caller is the model** (AI-first); human commands are secondary.
Agent `description` fields are therefore the interface — kept short and
delegation-oriented (Claude Code lesson).

## 2. Non-goals

- Nested subagents (children never get a `subagent` tool)
- Cron/one-shot scheduling
- Scripted JS workflow sandbox
- Git worktree isolation / auto-commit
- Mid-run steering & live transcript view in P1/P2 (P3 delivers via `--mode rpc`)
- `tasks:[]` array param and `chain` param — parallelism is N sibling tool
  calls; sequencing is the model's own planning job (it sees each result)

## 3. Architecture

- **Subprocess always.** Spawn the same pi binary that hosts us:
  `process.execPath + process.argv[1]` (fnm/bun-safe; fall back to `pi` on
  PATH) — the official example's `getPiInvocation` trick.
- **Never starve the host machine** (works on the Linux VM and macOS alike):
  wrap every child in `nice -n 15`, plus `ionice -c3` where the binary exists
  (Linux only — see `lib/low-prio.ts`), `detached: true` process group.
- **P1: `--mode json -p`** — fire, stream-parse JSONL events from stdout,
  collect. Simple lifecycle: child exits when done.
- **P3 (committed, must-not-forget): switch spawn to `--mode rpc`** — the
  child becomes a long-lived server over stdin/stdout JSONL and gains:
  `steer` (mid-run redirect), `follow_up`, `abort`, `get_messages`/`get_state`
  (live view), `set_model`/`set_thinking_level`, and graceful wrap-up (send
  `steer("wrap up now")` before timeout kill). Same spawn/discovery machinery
  underneath; protocol framing is strict LF-only JSONL (no `readline`).
- **Session file always persisted**: `--session <state-dir>/<run-id>/session.jsonl`.
  This is the foundation of all continue/resume paths (see §7).
- **Clean-room child** (§6): no ambient extensions, skills, context files,
  prompt templates, or themes — opt back in per frontmatter.

## 4. Tool surface (one tool, Claude Code shape)

```ts
subagent({ agent, task, run_in_background?, model?, cwd? })  // new run
subagent({ continue: "<run-id>", task })                     // continue a finished run
```

- Mutually exclusive shapes; validate explicitly and fail loudly per repo
  conventions (`lib/tool-compat.ts`: `extractToolArgs`, `requireString`,
  `textResult`).
- **Blocking by default** — the result returns into the same turn so the model
  can reason over it immediately (this is what keeps the agentic loop tight;
  CC works the same way).
- **`run_in_background: true`** (implemented in P2): the call returns the run
  id immediately (`Background subagent started: <id> (<agent>)` + kill hint);
  the run keeps going (same semaphore, same timeout). On finish the owner
  session is woken via the notification machinery in `lib/agent-runs.ts`
  (§8): a result notice with tail + `result.md` path + continue hint, pushed
  as `followUp`+`triggerTurn` when the owner is the active session, else
  `nextTurn`. Undelivered notices surface through the guaranteed channels
  (activation sweep, context-hook injection). Background runs ignore the
  tool-call abort signal — they are stopped via `/subagents kill`, not by
  parent-turn aborts.
- **Parallel = N sibling tool calls in the SAME assistant response.** pi
  executes sibling calls concurrently by default (docs/extensions.md §tool
  execution). Calling one, waiting for its result, then calling another is
  sequential — even if the tasks are independent. The tool `description`
  states this explicitly, including the inverse rule: sequential dispatch only
  when a later task depends on an earlier result. Guidance lives in this one
  model-facing contract instead of being duplicated into the system prompt.
  We add an internal
  **semaphore** so live children never exceed the cap: default **4**,
  `PI_SUBAGENT_MAX_CONCURRENT` (1–16). Calls beyond the cap queue transparently
  (`state: "queued"` in meta).

  **Guarantee boundary:** this single-task schema cannot force a model to batch
  independent calls in one response; prompt metadata makes the desired behavior
  explicit and testable, but only a future explicit batch parameter could make
  batching a code-level guarantee.
- **`#agent` mentions**: typing `#scout` in the editor autocompletes
  discovered agents (editor autocomplete provider, trigger `#`); the mention
  is plain text — the tool description tells the model that `#name` means
  "delegate this task to that agent". `@path` stays pi's file mention.
- `model`: explicit `provider/id` overrides; default inherits parent
  (`ctx.model`). Same precedence for frontmatter (§5).
- `continue` is **allowed cross-session** (a run is a disk artifact, not owned
  state); the owning session is recorded in meta for display only.

## 5. Agent definitions

Markdown + YAML frontmatter. Core fields stay Claude Code-compatible; extras
are additive lists that map to pi's additive CLI flags.

| Field | Type | Default | Meaning |
|---|---|---|---|
| `name` | str | required | invocation name; unique across dirs |
| `description` | str | required | what the parent model sees; drives delegation |
| `model` | str | `inherit` | `provider/id`, or `inherit` for parent's model |
| `tools` | csv | *(all allowed)* | allowlist → `--tools` (covers built-in + extension + custom tools) |
| `extensions` | list | `[]` | bundle extension names → `-e <path>` each (§6) |
| `skills` | list | `[]` | skill names → resolved paths → `--skill <path>` each (§6) |
| `mcp` | list | `[]` | MCP server names → filtered `--mcp-config` + adapter loaded via `-e` (§6) |
| `thinking` | str | `inherit` | `off…max` → `--thinking` |
| `timeout` | num (min) | `15` | per-run hard timeout (§7) |

Example — `scout.md`:

```markdown
---
name: scout
description: Fast read-only codebase recon. Returns compressed findings, never edits.
model: inherit
tools: read, grep, find, ls, code_search
extensions: [code-search]
timeout: 10
---

You are a codebase scout. Investigate precisely, read only, and return a
dense factual summary with file:line references.
```

**Discovery:** `~/.pi/agent/agents/*.md` always; `<project>/.pi/agents/*.md`
only behind project trust (confirmed via `ctx.isProjectTrusted()` or explicit
`ctx.ui.confirm` — the confirm fallback lands with P2's background
machinery). Project overrides user by name. Duplicate names within one
dir → error in `/subagents doctor` (P3). **P1 trust rule (fail-closed):**
project agents load only when the target cwd equals the session's project
cwd AND that project is trusted — an explicit `cwd` override to a foreign
repo deliberately falls back to user agents only (no UI trust prompt is
reachable from a tool call; opening one arrives with P2).

**Roster v1 (3 files, shipped in `agents/`, COPIED — not symlinked — to
`~/.pi/agent/agents/` on install; agents are user-tunable):**

| Agent | Model (TinTin default) | Tools | Timeout | Notes |
|---|---|---|---|---|
| `scout` | `9router/cx/gpt-5.6-luna` · thinking low | read, grep, find, ls + `code_search` (via bundle ext) | 10 min | read-only recon; cheap/fast reasoning tier |
| `worker` | `9router/snowy` | full | 60 min | real implementation work |
| `reviewer` | `9router/flash-research` (chain: gemini-3.8-flash-high → luna → deepseek-v4-flash) · thinking high | read, grep, bash + `code_search`/`code_find_related` | 20 min | review/audit; primary gemini-3.8-flash-high = #1 agentic/code benchmarks + ~305 tok/s, all fallbacks fast — chosen over bare luna pin for the 1M-recall cliff (MRCR 41.3%) and over snowy/smartmode for the sol-TTFT stall tail |
| `research` | `9router/flash-research` · thinking low | web_search, web_fetch, read (via bundle exts) | 15 min | web research with cited sources; keeps heavy browsing out of the parent context |
| `oracle` | `9router/smartmode` · thinking high | read, grep, bash + `code_search`/`code_find_related` | 20 min | independent second opinion on hard calls; verdict-first answers |

(`oracle` second-opinion agent joins in P3 as a pure `.md` — strong model +
critique prompt.)

## 6. Child environment — clean-room + additive resolution

Base flags on every spawn (cheap, deterministic children):

```
--no-extensions --no-skills --no-context-files --no-prompt-templates --no-themes
```

pi's `--extension/-e` and `--skill` are **additive even alongside the
`--no-*` discovery killers** (verified: `--help`, docs/skills.md) — that makes
the opt-in mechanism trivial:

| Frontmatter | Resolution | Spawn flags |
|---|---|---|
| `tools` | names as-is (pi filters built-in + extension + custom) | `--tools <csv>` |
| `extensions: [code-search]` | **bundle-relative**: sibling of `subagent.ts` → `/opt/tintin/pi-extensions/extensions/<name>.ts` (resolve via the extension file's own dir at runtime) | `-e <path>` per item |
| `skills: [code-review]` | **name → path**: search pi's documented skill locations (`~/.agents/skills/<n>/SKILL.md`, `~/.pi/agent/skills/`, project dirs, first hit wins) | `--skill <path>` per item |
| `mcp: [context7]` | read `~/.pi/agent/subagent_mcp.json` (legacy `mcp.json` still accepted; doctor warns) → keep only named servers → write temp config → load the adapter itself via `-e ~/.pi/agent/npm/node_modules/pi-mcp-adapter/<entry>` + `--mcp-config <tmp>` (tmp deleted in `finally`). This file is subagent-only by construction — the main session's adapter reads `.mcp.json` / `~/.config/mcp/mcp.json`, never this file | as stated |

System prompt: `--append-system-prompt <text>` accepts text directly
(`--help`: "Append text or file contents"); **verified on 0.85.0 (W4)** — the
child echoed the marker token, no temp file needed. The task travels as the
trailing prompt arg: `Task: <task>`.

Consequences (accepted): children do NOT inherit AGENTS.md conventions or the
ambient skill list; the parent (or the agent `.md` body) is responsible for
putting required conventions into the task/prompt.

## 7. Runs & lifecycle

- Run id: short id like bg-task's (`s-<base36>`), state dir per run:
  `~/.pi/agent/subagents/<run-id>/` containing `meta.json`,
  `session.jsonl` (child transcript, persisted by pi), `transcript.jsonl`
  (raw event stream copy), `result.md` (full final text).
- Meta: `{ id, agent, task, state, model, ownerSession, pid/pgid, createdAt,
  startedAt, finishedAt, timeoutMin, usage{input,output,cacheRead,cacheWrite,
  cost,totalTokens,turns}, error, resultPath }`.
- State machine: `queued → running → done | failed | timeout | killed`.
- Usage aggregated from `message_end` assistant messages (exact JSON shape
  recorded in §12). Final output = last assistant text part. Tool activity
  feed (for renderers) from `tool_execution_start/update/end`.
- **Output truncation:** returned text capped at 200 KB / 5,000 lines
  (head+tail splice); full text always on disk in `result.md`.
- **Model-visible run identity:** every final tool result appends a compact
  orchestration footer inside the same character cap:
  `[subagent run: <id> · <agent> · <state>]` plus the exact
  `subagent({ continue: "<id>", task: "..." })` shape. The parent model can
  therefore continue the child without a filesystem lookup; `result.md`
  remains the raw child output without this footer.
- **Timeout never loses work.** On expiry: SIGTERM → SIGKILL after 5 s →
  meta marked `timeout`; partial result = last assistant text if any; our
  captured `transcript.jsonl` is the authoritative post-mortem artifact
  (see W7 caveat in §12 — pi flushes its own session file lazily, so an early
  kill may leave it absent or stale).
- `continue` (tool + command): spawn a fresh `pi --session <same file>` with
  the follow-up task. Validated: run exists, not currently `running`.
  **Fallback (W7):** triggered when the child's `session.jsonl` is
  absent/empty OR the previous run ended `timeout`/`killed` (a live-looking
  session may be stale — W7 showed flush lag). Rebuild context from the tail
  of our captured `transcript.jsonl` — spawn fresh with a condensed
  partial-transcript summary, never fail the continue.

## 8. Background machinery (P2) — copied into `lib/`, bg-task untouched

Decision: **copy** the needed machinery out of `bg-task.ts` into
`lib/agent-runs.ts` and consume it from `subagent.ts`. `bg-task.ts` itself is
NOT refactored — the duplication (~400 lines) is accepted, documented debt;
revisit only when drift hurts. Rationale: bg-task.ts is 1,538 lines with
subtle invariants (monotonic capture-`seq` claiming, strict per-session
notice ownership, late-bound `sendToSession`, `notifiedAt` only on real
delivery); refactoring it is regression risk that P2 doesn't need to take.

Lifted (verbatim where possible): state dir layout + `meta.json` read/write,
heartbeat + orphan detection, `canNotifyHere` ownership, late-bound
`sendToSession` (NEVER capture `pi.sendMessage` at module level),
notification retry/adoption, widget tick + renderers, SIGTERM→SIGKILL
escalation, prune, debug-log capping, `envInt` knobs, settings file.
State dir is separate (`~/.pi/agent/subagents/`, not `bg-tasks/`) so scans
never collide.

**Implemented in P2** as `lib/agent-runs.ts` — lifted: capture registry +
`seq` claiming, strict `canNotifyHere` ownership, late-bound
`sendToSession`, `notifyTries`/`notifiedAt`-on-real-delivery, activation
sweep (session_start/session_info_changed/input/tool_call), context-hook
injection (multi-session only), prune, capped debug log, orphan finalize.
Deliberate deviations (all safer-or-simpler for the subagent shape):

- **No heartbeat/orphan scanner:** P2 runs are in-process pipe children — if
  the host dies, the child's stdout breaks and the process group disappears,
  so a `running` meta with a dead pgid is finalized `failed` on the next scan
  (heartbeat is redundant here).
- **No widget tick:** `/subagents list` covers progress display; a UI widget
  is deferred until it earns its complexity.
- **No execute-ctx push in `sendToSession`:** the spawning call's ctx is
  stale the moment the call returns; delivery uses targeted session apis
  (claimed at session_start by `seq`) plus an ownership-gated single-session
  fallback (blind push only when the only known session is the owner or the
  owner file is gone — otherwise a restarted TUI would leak another
  session's notice).
- **No settings file:** nothing user-configurable yet.

## 9. Commands

`/subagents list` (table: id, agent, state, elapsed, usage) ·
`/subagents cont <id> <message>` (continue a finished run) ·
`/subagents kill <id>` · `/subagents steer <id> <message>` (redirect a live
rpc child mid-run) · `/subagents inspect <id>` (live: `get_messages` tail;
finished: transcript tail) · `/subagents doctor` (pi invocation, state dir
writable, agents parse, duplicate names, referenced extensions/skills/mcp
resolvable).

Steering is also model-facing: `subagent({ continue: "<id>", task })` on a
RUNNING run delivers the task as a steering message instead of erroring.

## 10. Naming & configuration

| Thing | Value |
|---|---|
| Tool | `subagent` |
| Command | `/subagents` |
| Extension file | `extensions/subagent.ts` |
| Shared lib | `lib/agent-runs.ts` |
| Agent files | `agents/*.md` in bundle → copied to `~/.pi/agent/agents/` |
| State dir | `~/.pi/agent/subagents/<run-id>/` (env: `PI_SUBAGENT_STATE_DIR`) |

Env knobs: `PI_SUBAGENT_MAX_CONCURRENT` (4, 1–16) · `PI_SUBAGENT_TIMEOUT_MIN`
(15, 0 = none — frontmatter still applies) · `PI_SUBAGENT_PRUNE_HOURS` (168) ·
`PI_SUBAGENT_OUT_CHARS` (200,000) · `PI_SUBAGENT_OUT_LINES` (5,000).

## 11. Phasing

**P3 record (2026-09-05) — rpc upgrade, DONE.**

- Children now spawn `pi --mode rpc` (no `-p`); the task goes to the child as
  an rpc `prompt` request (`lib/rpc-child.ts`: manual LF framing per protocol
  docs — never readline — id-correlated requests, capped stderr). Agent events
  are identical to json mode, so usage/activities/result code is unchanged.
- Completion = `turn_end` with no steered turn starting within a 700 ms quiet
  window (steering delivered between turns starts a new turn). stdin is then
  half-closed; a lingering child gets SIGTERM (no zombies).
- **Steer:** `subagent({ continue: id, task })` or `/subagents steer` on a
  running run pushes a `steer` into the live child (in-process registry;
  cross-process/reload steers fail loudly). W9b verified real pi honors it
  mid-tool-execution.
- **Graceful timeout:** expiry steers "wrap up NOW" → grace
  `PI_SUBAGENT_WRAPUP_SEC` (45s) → `abort` → SIGTERM group → SIGKILL.
  Finishing inside the grace window = `done`; only exceeding it = `timeout`.
- **`inspect` / `doctor`:** see §9. **`pi.events`:** `subagent:started` /
  `subagent:finished` emitted through `pi.events` (guarded for hosts without
  a bus). **`oracle` agent** added to the roster (§5).
- Gates: e2e (incl. steer/pivot, wrap-up-in-grace, hang-timeout, inspect,
  doctor, events), smoke-test now also spawns a real rpc child under BOTH
  calling conventions, bg-e2e, bg-regression — ALL PASS.

Per-phase scope:| Phase | Scope |
|---|---|
| **P1 — core** | discovery + frontmatter (incl. `timeout`, resolution of `tools/extensions/skills/mcp`) + spawn json -p + JSONL parse + usage aggregation + truncation + blocking + **continue (tool param + command)** + parallel-via-sibling-calls + semaphore + renderCall/renderResult + `/subagents list\|cont\|kill` + roster `.md` files |
| **P2 — background** | `run_in_background` + lift machinery into `lib/agent-runs.ts` + notify/ownership + prune + bg tests isolation (`PI_BG_STATE_DIR`-style env) |
| **P3 — rpc upgrade** | spawn via `--mode rpc`: steer, live inspect, graceful wrap-up, abort; `doctor`; `pi.events` lifecycle emits; `oracle` agent; extend `scripts/smoke-test.mjs` for subagent spawn |

Before P1: wire verification (§12). Tests are the real gate (transpile-only
loader — no runtime typechecking).

## 12. Wire verification (0.85.0) — RESULTS ✅

> Run 2026-09-05 with real headless children (default model
> zai/glm-5.3-flash, clean-room flags). All checks PASSED; two behavioral
> caveats discovered (W3b, W7) are folded into the design above.

| # | Check | Result |
|---|---|---|
| W1 | `--mode json -p` event schema + usage fields | ✅ schema recorded below |
| W2 | `--session <path>` + `-p` + `--mode json` coexist; file created | ✅ file created on completed run |
| W3 | `--tools` accepted; invalid tool name error shape | ✅ accepted; **invalid names silently ignored** (no error) |
| W4 | `--append-system-prompt` accepts direct text | ✅ marker echoed; no temp file needed |
| W5 | `-e <bundle ext>` additive with `--no-extensions` | ✅ `code_search` loaded AND invoked; clean-room preserved |
| W6 | `--skill <path>` additive with `--no-skills` | ✅ marker skill named by the child |
| W9a | `--mode rpc`: prompt via stdin, event schema, usage fields | ✅ identical `message_end`/usage schema to json mode; session file flushed immediately (no W7 lag); clean exit on stdin EOF |
| W9b | `steer` mid-tool-execution | ✅ accepted; model pivots and answers the steering instead (W9 run: `STEER-OK`, stop=stop) |
| W9c | `abort` while streaming | ✅ accepted; clean termination; partial output preserved |
| W9d | `get_messages` while live | ✅ full conversation returned (powers `/subagents inspect`) |
| W9e | rpc exit semantics | ✅ no exit command; child exits on stdin EOF → transport half-closes after idle, SIGTERM fallback kills stragglers |
| W7 | SIGTERM mid-run | ✅ exit 143; **caveat:** pi's session file flushes lazily — absent/stale after early kill |
| W8 | adapter via `-e` + `--mcp-config <filtered tmp>` | ✅ clean start, empty stderr, normal completion |

### Recorded wire facts

- Event stream (stdout, one JSON per line): `session` (header, v3),
  `agent_start`, `turn_start`, `message_start`, `message_update` (streaming
  deltas), `message_end`, `turn_end`, `agent_end` (carries all messages),
  `agent_settled`.
- Usage lives on assistant `message_end`: `message.usage = { input, output,
  cacheRead, cacheWrite, reasoning, totalTokens, cost: { input, output,
  cacheRead, cacheWrite, total } }`; `message.stopReason` (`"stop"`, …).
- Final output = last assistant text part (`message.content[-1].text`).
- `--tools` with an unknown name does NOT error — pi just filters; agent-
  `.md` tool typos surface only as "model lacks the tool". `/subagents
  doctor` (P3) should validate frontmatter tool names against a known set.
- `-e` / `--skill` are additive even with `--no-extensions` / `--no-skills`
  — the clean-room + opt-in mechanism (§6) is confirmed end-to-end,
  including the MCP adapter path (`pi-mcp-adapter/index.ts` loads as-is).
- **Session flush lag (W7):** pi persists its session file lazily (observed:
  first flush minutes-of-tokens later than the first completed message; a
  child killed at 8 s produced 322 stdout events but no session file).
  Consequences, already designed in (§7): our `transcript.jsonl` capture is
  the authoritative artifact; `continue` falls back to a fresh spawn with a
  transcript-tail summary when `session.jsonl` is absent/empty.

## 13. Risks & mitigations

1. **CLI/event drift** — flags and JSONL schema are semi-internal. Pin the
   host binary (`getPiInvocation`); §12 findings recorded here; extend
   `scripts/smoke-test.mjs` to re-assert the event contract after every pi
   upgrade.
2. **Cost runaway** — children re-pay system prompt + tool schemas. Mitigated
   by clean-room default, tight per-agent `tools:`, hard timeouts, visible
   usage line in every result, semaphore cap.
3. **pi-web multi-session** — solved by reusing ownership/late-bound delivery
   from bg-task (§8); never capture `pi.sendMessage` at module level.
4. **MCP adapter flags semi-internal** — `--mcp-config` generation verified in
   W8; if fragile, degrade to "mcp requires adapter in ambient mode" (drop
   clean-room for that agent only) — never silently.
5. **Timeout harshness on long worker runs** — worker gets 60 min by default
   and every timeout is resumable (§7); wrap-up warning in P3 softens it.

When `mcp:` is combined with a `tools:` allowlist, the adapter gateway tools
(`mcp`, `mcpScript`) are added automatically — otherwise `--tools` would
filter away the very tools the opt-in loaded. Test seams (NOT user-facing):
`PI_SUBAGENT_PI_SCRIPT` (override the spawned binary; empty = unset) and
`PI_SUBAGENT_BUNDLE_DIR`. The `getPiInvocation` host-binary pin matches only
scripts that look like the pi CLI entrypoint — an arbitrary harness script
must never be recursively spawned (found live during self-review).

## 14. P1 implementation record (2026-09-05)

Shipped as `extensions/subagent.ts` (+ `agents/{scout,worker,reviewer}.md`,
`scripts/subagent-e2e.mjs`, `scripts/fixtures/fake-subagent-pi.mjs`, smoke-test
integration). Reviewed along two axes (Standards vs Spec) by two parallel
subagents — the extension's own first real job. Findings folded back in:
stderr capped (32 KB), `turns` counted in usage, `/subagents list` shows
elapsed + usage columns, roster `.md` files realigned to §5, stale-session
recovery widened to timeout/killed runs, kill-vs-writer meta races merged via
read-modify-write (`mergeMeta`), duplicated continue paths extracted,
`getPiInvocation` hardened against recursive spawn. Accepted deviations
(documented in §5/§6/§7): blocking default until P2, cwd-equality trust rule,
ui.confirm fallback deferred, test-seam env knobs.

### Status after live acceptance (all pushed, HEAD `5b0d79a`)

- Gates: `subagent-e2e` (14 behavioral tests incl. trust/queue-kill/recovery),
  `smoke-test` (both calling conventions, isolated state), `bg-e2e`,
  `bg-regression` — ALL PASS.
- Live-verified in real pi sessions: blocking run, model-visible run-id footer
  + AI-driven continue on the same child (context preserved), worker edits on
  a real tree, reviewer read-only boundary (scout correctly refuses bash),
  sibling-call parallelism (two children started 11 ms apart), pinned models
  resolve per roster.
- Roster pins (shipped defaults, user-tunable in `~/.pi/agent/agents/`):
  scout `opencode-go/gpt-5.6-luna` (thinking low), worker `9router/snowy`,
  reviewer `9router/snowy` (thinking high, + code_search/code_find_related),
  research `9router/flash-research` (web_search/web_fetch exts).
- Deliberately untracked: `.agents/` (local skills) and `skills-lock.json`.

### P4 record (2026-09-06) — interactive viewer, fleet widget, mentions, toggles

Live-verified in the real TUI and in pi-web/ttyd (browser terminal).

- **Chat viewer** (`/subagents chat [id]`, global `ctrl+alt+s` via
  `pi.registerShortcut`): `ui.custom` component — colored you/agent dialogue
  with tool calls interleaved in place, fixed-height scrolling
  (arrows/jk/PgUp/PgDn/g/G/space), running runs re-read state every second
  (LIVE marker). `esc`/`q`/`ctrl+c` exit; pi hands focused components RAW
  terminal data, so keys are matched as bytes, not parsed names.
- **Two-way actions**: `s` composes a message — live run ⇒ steer, finished
  run ⇒ background continue on the SAME run id (viewer follows, LIVE again).
  `D` twice stops the run (explicit two-press confirmation).
- **Quiet vs notify (per-round policy `meta.notifyOnDone`)**: AI
  `subagent({continue})` always notifies (push + triggerTurn). Viewer sends
  default QUIET (user is watching; completion silently marked delivered —
  sweeps never resurface it); `n` toggles notify:on for the next send (full
  push). Steering never changes the policy — it belongs to whoever started
  the latest round. Every new round resets notifiedAt/notifyTries (inherited
  markers used to silence all future completions).
- **FleetView widget** (key `subagents`, placement belowEditor): run count +
  per-run id/agent/state/elapsed/task lines while anything is active, clears
  when idle; refreshed on start/settle/inline-delivery, session activity,
  and a 2s ticker. Setter + live theme captured from the first TUI context
  carrying `ui.setWidget`; rows render dim (thinking-style) via `theme.fg`,
  state token in accent. String arrays only — RPC/pi-web ignores factories.
- **Widget scope** (`/subagents widget [owner|all|off]`, bare = cycle,
  default `owner`): owner filters to runs whose `ownerSession` equals the
  current session file; all shows every active run on the machine; off hides
  the widget. Persisted in `<state-dir>/widget-mode.json` — shared by every
  session's ticker, so one switch updates all TUIs within 2s.
- **Agent mentions**: `#name` (editor autocomplete provider, trigger `#`,
  prefix-filtered) — plain text; the tool description teaches the model that
  `#name` = delegate. `@path` stays pi's file mention.
- **Roster & toggles**: `/subagents agents` (model/tools/timeout/state),
  `agents off|on <name>` per-session in-memory disable;
  `enabled: false` frontmatter = durable disable (hidden from catalog, loud
  invoke/continue errors). Disabled vs unknown invoke errors are distinct.
- **Known platform limits**: `#` autocomplete popup and `ctrl+alt+s` do not
  fire in browser terminals (ttyd) — macOS Option-key encoding and browser
  key interception; works in real terminal emulators. `ui.custom` viewer,
  widget, and commands DO work in pi-web (it renders extension custom UI and
  forwards keys).

### P2 entry checklist (next phase — background mode)

> **P2 DONE (2026-09-05, same day).** See the P2 record below the checklist;
> items kept as written, with the deviations recorded in §8.

1. Copy machinery from `bg-task.ts` into `lib/agent-runs.ts` (meta/heartbeat/
   `canNotifyHere`/late-bound `sendToSession`/widget tick/kill escalation/
   prune/debug-log cap) — bg-task.ts itself stays untouched; state dir stays
   `~/.pi/agent/subagents/`.
2. `run_in_background: true` (single mode first): return run id immediately,
   notify the owner session on finish (followUp + triggerTurn), result.md as
   artifact; adopt §8 invariants verbatim (seq-claim, notifiedAt-on-real-
   delivery, never capture pi.sendMessage at module level).
3. Add `ctx.ui.confirm` fallback for project agents in untrusted-but-promptable
   sessions (deferred from P1).
4. Extend `subagent-e2e.mjs` for background flows with fake-child timing.
5. P3 (after P2): `--mode rpc` spawn upgrade (steer / live inspect / graceful
   wrap-up before timeout kill), `doctor`, `pi.events` emits, optional
   `oracle` agent (.md only).

### P2 record (2026-09-05) — background mode + notify

- `lib/agent-runs.ts`: capture registry (`globalThis`, seq-claiming), strict
  ownership, late-bound `sendToSession` (targeted apis + ownership-gated
  single-session fallback), `deliverRunNotice` (notifiedAt only on real
  delivery, 12-try push cap), activation sweep, context-hook pump, orphan
  finalize (dead pgid), 7-day prune, capped debug log. Deviations in §8.
- `extensions/subagent.ts`: `run_in_background` fires the run without
  awaiting (same semaphore/timeout), returns id + kill hint immediately;
  `launchBackground` pushes the finish notice; `continue` also accepts
  background. `ui.confirm` fallback lets untrusted-but-promptable sessions
  opt in to project agents per run.
- e2e coverage added: immediate return, finish notice content + followUp
  opts + notifyTries, sweep catch-up, live-owner adoption block + adopt after
  owner deletion, hook-driven orphan finalize (+ result file), prune matrix,
  canNotifyHere matrix, single/multi-session context pump incl. the
  foreign-owner negative, confirm deny/allow.
- Gates after P2: subagent-e2e, smoke-test, bg-e2e, bg-regression — ALL PASS.

## 15. Sources

- pi 0.85.0 docs: `docs/extensions.md` (parallel tool execution, tool-compat),
  `docs/rpc.md` (steer/follow_up/abort/get_messages), `docs/json.md` (event
  schema), `docs/skills.md` (skill locations, additive `--skill`),
  `docs/sdk.md` (AgentSession — reference only, not our path).
- Official example: `examples/extensions/subagent/{index,agents}.ts`
  (getPiInvocation, JSONL parse, renderCall/renderResult patterns).
- Prior art: tintinweb/pi-subagents (in-process contrast, notification cards),
  nicobailon/pi-subagents (truncation hygiene, doctor), Claude Code subagents
  docs + Task tool behavior (blocking default, 20 concurrent cap, no timeout
  — we deliberately improve on timeout), disler/pi-vs-claude-code
  (persistent-`--session` resume trick).
- Evidence for second-opinion value: Anthropic "How we built our multi-agent
  research system" (2025); Du et al. 2023, "Improving Factuality and
  Reasoning in Language Models through Multiagent Debate".
- House prior art: `extensions/bg-task.ts` (§8 inventory),
  `lib/tool-compat.ts`, `docs/btw.md` (doc style).
