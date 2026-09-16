#!/usr/bin/env node
// UI regression test for the /btw TUI streaming view (BtwStreamView).
//
//   node scripts/btw-view-e2e.mjs   (exit 0 = ALL OK)
//
// Regression: the view docked where the editor is but rendered the answer
// unbounded, so a long answer pushed the main chat out of the viewport and
// nothing could scroll. It must now keep a row-capped, internally scrollable
// body (follow-tail while streaming, keys for history).

import path from "node:path";

const here = path.dirname(new URL(import.meta.url).pathname);
const pkgRoot = path.dirname(here);

const { BtwStreamView, bodyRowBudget } = await import(path.join(pkgRoot, "extensions", "btw.ts"));

let failures = 0;
function check(label, cond, detail = "") {
  console.log(`${cond ? "PASS" : "FAIL"}  ${label}${cond || !detail ? "" : ` — ${detail}`}`);
  if (!cond) failures++;
}

// Fake TUI/theme — the component must not reach outside these two objects.
let renders = 0;
const tui = { terminal: { rows: 30 }, requestRender: () => { renders++; } };
const theme = { fg: (_color, text) => text };

const WIDTH = 60;
const ROWS = bodyRowBudget(30);
// Header + question + spacer + body rows + spacer + footer
const CHROME = 5;
// 120 appended lines, plus the empty row from the trailing newline
const BODY_LINES = 121;

function makeView({ long = 120 } = {}) {
  const events = { abort: 0, close: 0 };
  const view = new BtwStreamView(tui, theme, "why?", () => { events.abort++; }, () => { events.close++; });
  for (let i = 1; i <= long; i++) view.append(`line-${String(i).padStart(3, "0")}\n`);
  return { view, events };
}

const bodyOf = (lines) => lines.slice(3, 3 + ROWS);

check("bodyRowBudget keeps a bounded window", ROWS >= 6 && ROWS <= 20, `got ${ROWS} for 30 rows`);
check("bodyRowBudget clamps tiny terminals", bodyRowBudget(10) >= 6, `got ${bodyRowBudget(10)}`);
check("bodyRowBudget clamps huge terminals", bodyRowBudget(500) <= 20, `got ${bodyRowBudget(500)}`);
check("bodyRowBudget tolerates a missing row count", bodyRowBudget(0) >= 6 && bodyRowBudget(Number.NaN) >= 6);

{
  // Height cap: the rendered frame must not grow with the answer length.
  const short = makeView({ long: 3 });
  const long = makeView({ long: 400 });
  const shortLines = short.view.render(WIDTH);
  const longLines = long.view.render(WIDTH);
  check(
    "render height is capped regardless of answer length",
    shortLines.length === ROWS + CHROME && longLines.length === ROWS + CHROME,
    `short=${shortLines.length} long=${longLines.length} expected=${ROWS + CHROME}`,
  );
}

{
  // Follow-tail: streaming must keep the newest text visible.
  const { view } = makeView();
  const lines = view.render(WIDTH);
  check("follow-tail shows the newest line", lines.includes("line-120"), "line-120 missing");
  check("follow-tail does not show the oldest line", !lines.includes("line-001"));
  check("header marks the tail position", lines[0].includes("↓tail"), `header="${lines[0]}"`);
  const window = lines[0].match(/(\d+)-(\d+)\/(\d+) ↓tail/);
  check(
    "position window ends at the last body line",
    !!window && window[2] === window[3] && Number(window[3]) === BODY_LINES,
    `header="${lines[0]}"`,
  );
  check("footer advertises scroll keys", lines[lines.length - 1].includes("↑↓/jk scroll"), `footer="${lines.at(-1)}"`);
}

{
  // Keyboard scrolling: g = top, G = tail, j/k = one line, page keys = window.
  const { view } = makeView();
  view.render(WIDTH); // seeds lastMax

  check("g jumps to the top", view.handleInput("g") === true && view.render(WIDTH).includes("line-001"));
  check("render after g no longer marks follow", !view.render(WIDTH)[0].includes("↓tail"));

  view.handleInput("j");
  check("j scrolls one line down", bodyOf(view.render(WIDTH))[0] === "line-002", `got "${bodyOf(view.render(WIDTH))[0]}"`);
  view.handleInput("k");
  check("k scrolls one line up", bodyOf(view.render(WIDTH))[0] === "line-001", `got "${bodyOf(view.render(WIDTH))[0]}"`);

  view.handleInput("\x1b[6~"); // legacy page-down sequence
  check(
    "page-down advances by a full window",
    bodyOf(view.render(WIDTH))[0] === `line-${String(ROWS + 1).padStart(3, "0")}`,
    `got "${bodyOf(view.render(WIDTH))[0]}"`,
  );
  view.handleInput("\x1b[5~"); // legacy page-up sequence
  check("page-up returns a full window", bodyOf(view.render(WIDTH))[0] === "line-001");

  view.handleInput("G");
  const tail = view.render(WIDTH);
  check("G jumps back to the tail and re-follows", tail.includes("line-120") && tail[0].includes("↓tail"));
  view.handleInput("k");
  view.handleInput("G");
  check("k detaches, G re-attaches", view.render(WIDTH)[0].includes("↓tail"));

  check("unhandled keys fall through to pi", view.handleInput("q") === false);
  check("input triggers a re-render", renders > 0);
}

{
  // Esc keeps its meaning in both phases; aborted/error bodies stay capped.
  const streaming = makeView({ long: 2 });
  streaming.view.handleInput("\x1b"); // legacy escape byte
  check("esc aborts while streaming", streaming.events.abort === 1 && streaming.events.close === 0);

  const done = makeView({ long: 2 });
  done.view.finish("done", "cache read 12, 3 out · $0.0001");
  done.view.handleInput("\x1b");
  check("esc closes once finished", done.events.close === 1 && done.events.abort === 0);
  const doneLines = done.view.render(WIDTH);
  check("done header carries usage", doneLines[0].includes("cache read 12"), `header="${doneLines[0]}"`);

  const failed = makeView({ long: 2 });
  failed.view.finish("error", "provider exploded");
  const errLines = failed.view.render(WIDTH);
  check("error body shows the message", errLines.includes("provider exploded"));
  check("error render stays capped (padded body = stable frame height)", errLines.length === ROWS + CHROME, `got ${errLines.length}`);
}

{
  // Resize: the window re-derives from terminal rows on every render.
  const { view } = makeView();
  tui.terminal.rows = 12;
  const small = view.render(WIDTH);
  tui.terminal.rows = 30;
  const tall = view.render(WIDTH);
  check(
    "window follows terminal resize",
    small.length === bodyRowBudget(12) + CHROME && tall.length === bodyRowBudget(30) + CHROME,
    `small=${small.length} tall=${tall.length}`,
  );
}

console.log(failures === 0 ? "\nALL BTW VIEW TESTS PASSED" : `\n${failures} BTW VIEW TEST(S) FAILED`);
process.exit(failures === 0 ? 0 : 1);
