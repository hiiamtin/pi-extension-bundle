#!/usr/bin/env node
// Unit-level e2e for the figma link/resolver libs (lib/figma-link.ts +
// lib/figma-instance-resolver.ts) — pure data, no pi, no network, no real
// .fig files. Complements scripts/figma-parse-e2e.mjs (tool level).
//
//   node scripts/figma-resolver-e2e.mjs
//
// Covers:
//   1. parseFigmaUrl: real design URL (fileKey/slug/node-id), bare key, junk
//   2. matchFigFiles: "[Sonic] Common.fig" matches "-Sonic--Common" slug;
//      no-slug URLs match nothing
//   3. mergeNodeChanges: symbolOverrides/derivedSymbolData CONCAT across
//      changes (the bug that dropped real texts), scalar overwrite, REMOVED
//   4. resolveSubtree: instance → component variant + overrideTexts sorted by
//      derived position + propTexts from componentPropAssignments
//
// Exit code 0 = ALL ... PASSED.

import os from "node:os";
import path from "node:path";

const { parseFigmaUrl, normalizeName, matchFigFiles } = await import(
  path.join(path.dirname(path.dirname(new URL(import.meta.url).pathname)), "lib", "figma-link.ts")
);
const { mergeNodeChanges, resolveSubtree } = await import(
  path.join(path.dirname(path.dirname(new URL(import.meta.url).pathname)), "lib", "figma-instance-resolver.ts")
);

let passed = 0;
let failed = 0;
function assert(cond, name, detail) {
  if (cond) {
    passed++;
    console.log(`PASSED ${name}`);
  } else {
    failed++;
    console.log(`FAILED ${name}${detail ? ` — ${detail}` : ""}`);
  }
}

// ---------- 1. parseFigmaUrl ----------
const real = parseFigmaUrl("https://www.figma.com/design/yjYH4KUp8nhHyU6bQO6798/-Sonic--Common?node-id=470-25675&t=wzoRHiXA5zvcwTP6-4");
assert(!!real && real.fileKey === "yjYH4KUp8nhHyU6bQO6798", "URL: fileKey extracted", JSON.stringify(real));
assert(real.slug === "-Sonic--Common", "URL: slug extracted", JSON.stringify(real?.slug));
assert(real.nodeId === "470:25675", "URL: node-id dash → guid form", JSON.stringify(real?.nodeId));
const bare = parseFigmaUrl("yjYH4KUp8nhHyU6bQO6798");
assert(!!bare && bare.fileKey === "yjYH4KUp8nhHyU6bQO6798" && bare.nodeId === null, "bare file key accepted, no node");
assert(parseFigmaUrl("hello world") === null, "junk rejected");

// ---------- 2. matchFigFiles ----------
const candidates = [
  { path: "/Users/x/Downloads/[Sonic] Common.fig", fileName: "[Sonic] Common", altName: "[Sonic] Common" },
  { path: "/Users/x/Downloads/other.fig", fileName: "other" },
];
const url = parseFigmaUrl("https://www.figma.com/design/yjYH4KUp8nhHyU6bQO6798/-Sonic--Common");
const matched = matchFigFiles(candidates, url);
assert(matched.length === 1 && matched[0].fileName === "[Sonic] Common", "slug '-Sonic--Common' matches '[Sonic] Common'", JSON.stringify(matched));
assert(matchFigFiles(candidates, { fileKey: "k", slug: null, nodeId: null }).length === 0, "no slug → no match");
assert(normalizeName("[-Sonic--] Common!") === "soniccommon", "normalizeName strips punctuation");

// ---------- 3. mergeNodeChanges ----------
const merged = mergeNodeChanges([
  { guid: { sessionID: 1, localID: 10 }, phase: "CREATED", type: "INSTANCE", name: "btn",
    symbolData: { symbolOverrides: [{ guidPath: { guids: [{ sessionID: 9, localID: 1 }] }, textData: { characters: "Old" } }] } },
  {
    guid: { sessionID: 1, localID: 10 },
    symbolData: { symbolOverrides: [{ guidPath: { guids: [{ sessionID: 9, localID: 1 }] }, textData: { characters: "Save filter" } }] },
    derivedSymbolData: [{ guidPath: { guids: [{ sessionID: 9, localID: 1 }] }, derivedTextData: { baselines: [{ position: { x: 0, y: 21.6 }, endCharacter: 11 }] } }],
  },
  { guid: { sessionID: 1, localID: 10 }, symbolData: { symbolOverrides: [{ guidPath: { guids: [{ sessionID: 9, localID: 2 }] }, size: { x: 552, y: 88 } }] } },
  { guid: { sessionID: 1, localID: 99 }, phase: "REMOVED", type: "TEXT" },
]);
const inst = merged.nodes.get("1:10");
assert(inst.symbolData.symbolOverrides.length === 3, "symbolOverrides concatenated across changes (replace-merge loses texts)", String(inst.symbolData?.symbolOverrides?.length));
assert(inst.symbolData.symbolOverrides.some((o) => o.textData?.characters === "Save filter"), "earlier text override survives the merge");
assert(merged.nodes.has("1:10") && !merged.nodes.has("1:99"), "REMOVED change skipped, created kept");

// ---------- 4. resolveSubtree (synthetic doc mirroring the real modal) ----------
const doc = mergeNodeChanges([
  // component definition (SYMBOL) with default text
  { guid: { sessionID: 7360, localID: 63635 }, type: "SYMBOL", name: "Right Button?=yes", parentIndex: { guid: { sessionID: 7360, localID: 1 } } },
  { guid: { sessionID: 7360, localID: 63637 }, type: "TEXT", name: "Title", parentIndex: { guid: { sessionID: 7360, localID: 63635 } }, textData: { characters: "Full screen modal" } },
  { guid: { sessionID: 7360, localID: 63638 }, type: "INSTANCE", name: "Icon Button", parentIndex: { guid: { sessionID: 7360, localID: 63635 } }, symbolData: { symbolID: { sessionID: 7360, localID: 63900 } } },
  { guid: { sessionID: 7360, localID: 63900 }, type: "SYMBOL", name: "Size=M, Type=Tertiary, Background?=No", parentIndex: { guid: { sessionID: 7360, localID: 1 } } },
  // page + modal frame + instance with overrides and a component prop
  { guid: { sessionID: 470, localID: 25675 }, type: "FRAME", name: "Main Container", parentIndex: { guid: { sessionID: 470, localID: 2 } }, size: { x: 600, y: 280 }, fillPaints: [{ type: "SOLID", color: { r: 1, g: 1, b: 1, a: 1 } }] },
  {
    guid: { sessionID: 470, localID: 25676 },
    type: "INSTANCE",
    name: "overlay.modal.header",
    parentIndex: { guid: { sessionID: 470, localID: 25675 } },
    size: { x: 600, y: 72 },
    symbolData: {
      symbolID: { sessionID: 7360, localID: 63635 },
      symbolOverrides: [
        { guidPath: { guids: [{ sessionID: 370, localID: 6762 }] }, textData: { characters: "Save filter" } },
        { guidPath: { guids: [{ sessionID: 370, localID: 5803 }] }, componentPropAssignments: [{ value: { textValue: { characters: "Save" } } }] },
      ],
      derivedSymbolData: [{ guidPath: { guids: [{ sessionID: 370, localID: 6762 }] }, derivedTextData: { baselines: [{ position: { x: 0, y: 21.6 }, endCharacter: 11 }] } }],
    },
  },
]);
const tree = resolveSubtree(doc, "470:25675");
assert(tree?.type === "FRAME" && tree.name === "Main Container" && tree.size === "600x280", "root frame resolved");
assert(tree.fills?.[0] === "#ffffff", "solid fill → hex", JSON.stringify(tree.fills));
const header = (tree.children ?? []).find((c) => c.name === "overlay.modal.header");
assert(header?.component === "Right Button?=yes", "instance resolved to component variant", JSON.stringify(header));
assert(header?.overrideTexts?.[0] === "Save filter", "override text extracted", JSON.stringify(header?.overrideTexts));
const inner = (header?.children ?? []).find((c) => c.text === "Full screen modal");
assert(!!inner, "component default text visible in subtree");
const btn = (header?.children ?? []).find((c) => c.type === "INSTANCE" && c.name === "Icon Button");
assert(!!btn && btn.component === "Size=M, Type=Tertiary, Background?=No", "nested instance inside component resolved (recursion)", JSON.stringify(btn));
assert(header.propTexts?.[0] === "Save", "componentPropAssignments text captured", JSON.stringify(header?.propTexts));

// ---------- summary ----------
console.log(`\nfigma-resolver: ${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
console.log("ALL RESOLVER TESTS PASSED");
