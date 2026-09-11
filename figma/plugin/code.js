// pi-figma-bridge — headless dev plugin (no UI).
//
// Exports the current selection (first node per run, or every selected node)
// as PNG/SVG/JPG using the client-side renderer, then POSTs the raw bytes to
// the pi extension's local bridge at 127.0.0.1:37373/export.
//
// Works on every Figma plan (free Starter included): exportAsync is
// client-side rendering, exactly what right-click → "Copy as PNG" uses — no
// Dev Mode seat, no REST API rate limits.
//
// If you change the port or token in extensions/figma.ts, update BRIDGE_URL
// and BRIDGE_TOKEN here to match.

const BRIDGE_URL = "http://127.0.0.1:37373/export";
const BRIDGE_TOKEN = "pi-figma-export";

function notify(msg, opts) {
  figma.notify(msg, opts);
}

function encodeHeader(value) {
  return encodeURIComponent(String(value ?? "")).slice(0, 500);
}

async function postExport(format, bytes, scale, node) {
  const res = await fetch(BRIDGE_URL, {
    method: "POST",
    headers: {
      "Content-Type": "application/octet-stream",
      "X-Figma-Bridge": BRIDGE_TOKEN,
      "X-Format": format,
      "X-Scale": String(scale),
      "X-Node-Name": encodeHeader(node.name),
      "X-Node-Id": encodeHeader(node.id),
    },
    body: bytes,
  });
  if (!res.ok) {
    const detail = (await res.text()).slice(0, 200) || res.statusText;
    throw new Error(`bridge replied ${res.status}: ${detail}`);
  }
  return res.json();
}

async function run(format, scale) {
  const selection = figma.currentPage.selection;
  if (selection.length === 0) {
    notify("Select a node to export first.", { error: true });
    figma.closePlugin();
    return;
  }

  let ok = 0;
  const failed = [];
  for (const node of selection) {
    try {
      const bytes = await node.exportAsync({
        format,
        constraint: { type: "SCALE", value: scale },
        useAbsoluteBounds: true,
      });
      await postExport(format, bytes, scale, node);
      ok++;
    } catch (e) {
      failed.push(`${node.name}: ${e.message || String(e)}`);
    }
  }

  if (ok > 0) {
    notify(
      `pi-figma-bridge: exported ${ok} node(s)${failed.length ? `, ${failed.length} failed` : ""}`,
      { timeout: 3000 }
    );
  } else {
    notify(`pi-figma-bridge export failed: ${failed.join("; ") || "unknown error"}`, { error: true });
  }
  figma.closePlugin();
}

figma.on("run", (event) => {
  const [format, scaleText] = (event.command || "png@2").split("@");
  run(format, Number(scaleText));
});