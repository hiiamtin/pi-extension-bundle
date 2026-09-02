# AGENTS.md — pi-extension-bundle

Guidance for AI agents working in this repo: TypeScript extensions loaded by
pi (the coding agent). Package manifest is `package.json` (`pi.extensions` →
`./extensions`). On this VM the repo is registered as a local-path package —
edits take effect after `/reload` in pi; new sessions pick them up automatically.

## Hard rules

- Everything written to disk (code, docs, commits) is in English.
- pi loads extension TS with a transpile-only loader: **no typechecking at
  runtime**, erasable TS syntax only (no enums / namespaces / parameter
  properties). Tests are the real gate, not `tsc`.
- Never touch the REAL state from tests. bg-task tests must isolate via
  `PI_BG_STATE_DIR` + tmp dirs (see `scripts/bg-e2e.mjs`,
  `scripts/bg-regression.mjs`). Same for settings files.
- `getArgumentCompletions` must be READ-ONLY: it runs on every keystroke.

## Conventions

- **Tools**: wrap `execute` with `lib/tool-compat.ts::extractToolArgs()`,
  validate required params with `requireString()`, return `textResult()`.
  This normalizes the pi calling convention (≥0.84 changed the signature to
  `(toolCallId, params, signal, onUpdate, ctx)`). Validate explicitly and fail
  loudly — never let `undefined` params reach an upstream API.
- **Commands**: every `pi.registerCommand()` implements
  `getArgumentCompletions(argumentPrefix)` returning `{ value, label }` items
  or `null`, capped at ~8 entries. Reference impls: `quota.ts` (static tree),
  `bg-task.ts` (live task ids from disk).
- **Long-running work belongs in a background task**, never a blocking tool
  call (see the bg-task extension).
- **Debug logs are self-capped** (rewrite-truncate to a fixed budget), never
  appended unbounded.
- **bg-task internals**: read the inline comments BEFORE changing
  notification/ownership logic. Key invariants:
  - session→api mapping is claimed by monotonic capture `seq` (NOT array
    position — the capturedPis cap splices, which broke a positional cursor);
  - strict per-session notice ownership (`canNotifyHere`); cross-session
    adoption only when the owner session file is gone;
  - `notifiedAt` is set ONLY on real delivery — it blocks the guaranteed
    channels (owner context hook, session_start sweep);
  - apis/seq counters persist on `globalThis` to survive module re-eval
    (pi-web reloads extensions in one process).

## Testing (gate before commit)

```bash
node scripts/smoke-test.mjs     # after ANY pi upgrade — calling-convention check
node scripts/bg-e2e.mjs         # bg-task functional flows (spawn/kill/detach/interceptor)
node scripts/bg-regression.mjs  # bg-task regression suite (must print ALL ... PASSED)
```

Typecheck note: the codebase has known strict-`tsc` baseline noise (compat
handler signatures, event typings). When typechecking, compare error
CATEGORIES before/after your change — don't chase zero errors.

## Git

- Conventional commits with scope, English: `fix(bg-task): ...`,
  `feat(quota): ...`, `docs(readme): ...`.
- Commit after verified changes; push to `origin main` when the user asks.
