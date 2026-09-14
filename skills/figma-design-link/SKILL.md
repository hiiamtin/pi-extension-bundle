---
name: figma-design-link
description: Extract design data from figma.com links without Dev Mode or screenshots — match the link to a downloaded .fig snapshot, resolve the URL's node-id, and pull layout, colors, and REAL component texts (overrides + component properties) offline. Use when the user shares a figma.com design link and wants the design inspected, implemented, or compared.
---

# Figma design links → offline .fig extraction

Turn a figma.com design link into precise design data using the local
`figma_parse_local_fig` tool. The tool does the mechanics; this skill is the
decision procedure.

## Workflow

1. Call `figma_parse_local_fig` with `url: "<the link the user gave>"`.
   The tool extracts the file key + `node-id` from the URL and matches the
   file to a local `.fig` snapshot (searches `~/Downloads`, the project dir,
   and `.pi/figma-exports/`).
2. Follow the decision tree on the result:
   - **"no .fig files found"** → ask the user to download the file:
     Figma → main menu → **File → Download → .fig** — then re-run the SAME
     call. Do not guess or use screenshots at this stage.
   - **"no local .fig matches"** → the tool lists local candidates with their
     export dates. Ask the user which one to use (re-call with `path:`), or
     have them download the linked file.
   - **"multiple match"** → list them, ask the user to pick.
   - **match found** → the result header shows `exported: <date>`. `.fig` is a
     point-in-time snapshot: if the user's design changed after that date
     (they usually know), ask for a fresh download before trusting texts.
3. The tool locates the node from the URL's `node-id` automatically (e.g.
   `node-id=470-25675` → node `470:25675`). If the node is missing from the
   snapshot, the file is older than the node — fresh download needed.
4. Iterate with `node:"<id>"` or `frame:"<name>"` for other parts of the file.

## What the data means

- INSTANCE nodes are resolved to their component (the `component` name encodes
  the variant selection, e.g. `State=Error`).
- `texts:` lines are the REAL rendered strings (symbolOverrides) and
  `prop texts:` are component-property strings (e.g. button labels). These are
  exact — quote them in implementation, don't paraphrase.
- `fills:` are solid colors in hex. `size:` is px.
- Texts of EXTERNAL library components resolve only if the snapshot is of the
  file where they were used AND the component data shipped with it. If some
  instance shows no `texts:`, ask for a fresh download or fall back to the
  render (below).

## Offline SVG render (built in)

When `svg:true` (the default), the tool ALSO renders the resolved node to
`<export-root>/fig-<file>/render/<node-id>.svg` — flattened absolute-
coordinate paths in Figma's own serialization style: component instances
resolved (overrides, swaps, constraints, slot texts), text drawn as real
glyph outlines (no font needed), buttons/radios/clear-icons drawn
procedurally to match Figma.

- `<text>` runs (rare fallbacks + truncation dots) need the document's real
  fonts: put woff2/woff/ttf files in `<project>/fonts/` and they are embedded
  automatically as base64 `@font-face` (family matched by filename slug,
  e.g. `SCBXLooped-Bold.woff2` → family "SCBX Looped" weight 700). Or pass
  `fontsDir:` explicitly.
- Preview: headless Chrome —
  `chrome --headless --window-size=W,H --screenshot=out.png file://...svg`
  (add a `?r=$RANDOM` query to bust Chrome's cache on re-renders).

## Pixel-perfect loop (when "close" is not enough)

To verify an implementation (or the render itself) against Figma bit-for-bit:

1. Get the reference: select the frame in Figma → Copy as PNG (or the bridge
   plugin) → save next to the render as `*-reference.png`.
2. Screenshot our SVG at the same size, then per-pixel diff (PIL, threshold
   ~30/px on the channel sum). Cluster residuals into regions and fix the
   biggest class first — iterate.
3. Reading the residuals: structural diffs (wrong position/width/color) are
   real bugs — fix the renderer; ~1.5–2% scattered on glyph edges is the
   cross-renderer anti-aliasing floor (Figma rasterizer vs Chrome/Skia) and
   does not get better by editing the SVG.

## When to fall back to a render

The .fig path gives structure + text; it does NOT render. For pixel-look
questions (fonts, shadows, exact spacing feel), get a render instead:
user right-clicks the node → Copy as PNG (then `/figma clip`), or
(when the file is editable) the pi-figma-bridge plugin (`/figma status`).
Best practice for implementation tasks: resolved data for spec + one render
for look.

## Freshness & trust

- The tool never invents data: "not present in this snapshot" means a
  re-download is required, not an approximation.
- Never mix texts from different snapshots; always report the `exported:`
  date alongside extracted content.
