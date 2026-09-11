# pi-figma-bridge — Figma plugin

A headless (no-UI) dev plugin that captures your current Figma selection and
pushes it to the pi extension's local bridge as PNG/SVG/JPG.

Why this instead of the official Figma MCP? The MCP requires Dev Mode (paid
seat). This plugin uses `node.exportAsync()` — the same client-side renderer
behind right-click → "Copy as PNG", which is free on every plan. The pi side
saves every export to disk and hands the image to the model inline.

## Install (one-time, ~10 seconds)

1. Make sure Figma **desktop app** is running and logged in.
2. `Plugins → Development → Import plugin from manifest…`
3. Select `figma/plugin/manifest.json` in this repo.

Figma imports this as a *development* plugin — it is only visible on your
machine, never published. `devAllowedDomains` whitelists `127.0.0.1:37373`,
so the plugin may reach the local bridge without any license or review.

## Use, every capture

1. In Figma, select one or more nodes (frame, component, layer…).
2. `Plugins → Development → pi-figma-bridge → Export PNG @2x` (or SVG / @1x).
   On macOS, ⌘⌥P re-runs the last plugin — select the next node, hit ⌘⌥P.
3. The pi extension saves the bytes under `~/.pi/agent/figma-exports/` and the
   model receives the image (or ask it to via `figma_take_latest_export`, or
   inspect state with `/figma status`).

The bridge server auto-starts on the first pi tool call; it must be running in
the same machine/process for the push to land. Verify with `/figma status`.

## Configuration

| Setting | Extension env | Plugin constant |
| --- | --- | --- |
| Port | `PI_FIGMA_BRIDGE_PORT` (default `37373`) | `BRIDGE_URL` in `code.js` |
| Token | `PI_FIGMA_BRIDGE_TOKEN` (default `pi-figma-export`) | `BRIDGE_TOKEN` in `code.js` |
| Output dir | `PI_FIGMA_EXPORT_DIR` (default `~/.pi/agent/figma-exports`) | — |

If you change the port/token on one side, change the other side too — they must
match.

## Notes & limits

- Exports render **on your machine**, from the live document — fonts, images,
  and effects are exact. Scale ×2 is available for crisp pixels.
- SVG export keeps text as `<text>` elements; if a font is missing you may see
  a Figma font warning.
- Security: the bridge binds `127.0.0.1` only and rejects POSTs without the
  `X-Figma-Bridge` token header, so web pages cannot write files to your disk.
- Multi-node selection exports every selected node in one run (each becomes
  its own file). The model's capture tool returns the newest one.
- **View-only files:** dev plugins need edit access, so the plugin refuses to
  run there — but right-click → Copy as PNG/SVG still works. Copy the node,
  then use `/figma clip` (or the `figma_save_clipboard` tool) to persist it.