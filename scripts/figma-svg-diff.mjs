#!/usr/bin/env node
// SVG structural diff: compares primitive sets (path/rect with fill/stroke)
// between the reference export and our render, numerically normalized.
import { readFileSync } from "node:fs";

const refPath = process.argv[2] ?? ".pi/figma-exports/fig-_Sonic_Common/render/reference.svg";
const ourPath = process.argv[3] ?? ".pi/figma-exports/fig-_Sonic_Common/render/470-28167.svg";

const parseNums = (d) =>
  (d.match(/-?\d*\.?\d+(?:e[-+]?\d+)?/g) ?? []).map((v) => Math.round(parseFloat(v) * 100) / 100);

function primitives(svg) {
  const out = [];
  // paths
  for (const m of svg.matchAll(/<path d="([^"]+)" fill="([^"]*)"(?: stroke="([^"]*)"(?: stroke-width="([^"]*)")?)?[^/]*\/>/g)) {
    out.push({
      tag: "path",
      d: m[1],
      fill: m[2] === "" ? "none" : m[2].toLowerCase(),
      stroke: m[3] ? m[3].toLowerCase() : "",
      sw: m[4] ?? "",
      nums: parseNums(m[1]).join(","),
    });
  }
  // rects
  for (const m of svg.matchAll(/<rect ([^/>]*)\/>/g)) {
    const at = Object.fromEntries(
      [...m[1].matchAll(/([\w-]+)="([^"]*)"/g)].map((a) => [a[1], a[2]])
    );
    const x = Math.round(parseFloat(at.x ?? 0) * 100) / 100;
    const y = Math.round(parseFloat(at.y ?? 0) * 100) / 100;
    const w = Math.round(parseFloat(at.width ?? 0) * 100) / 100;
    const h = Math.round(parseFloat(at.height ?? 0) * 100) / 100;
    out.push({
      tag: "rect",
      d: `M${x} ${y}H${x + w}V${y + h}H${x}V${y}Z`,
      fill: (at.fill ?? "none").toLowerCase(),
      stroke: at.stroke ? at.stroke.toLowerCase() : "",
      sw: at["stroke-width"] ?? "",
      nums: `${x},${y},${x + w},${y + h}`,
    });
  }
  return out;
}

const ref = primitives(readFileSync(refPath, "utf8"));
const our = primitives(readFileSync(ourPath, "utf8"));

const key = (p) => `${p.nums}|f=${p.fill}|s=${p.stroke}|w=${p.sw}`;

const refMap = new Map();
for (const p of ref) refMap.set(key(p), (refMap.get(key(p)) ?? 0) + 1);
const ourMap = new Map();
for (const p of our) ourMap.set(key(p), (ourMap.get(key(p)) ?? 0) + 1);

let matched = 0;
const refOnly = [];
const ourOnly = [];
for (const [k, n] of refMap) {
  const o = ourMap.get(k) ?? 0;
  const take = Math.min(n, o);
  matched += take;
  if (n > o) refOnly.push([k, n - o]);
}
for (const [k, n] of ourMap) {
  const o = refMap.get(k) ?? 0;
  if (n > o) ourOnly.push([k, n - o]);
}

console.log(`reference primitives: ${ref.length}`);
console.log(`ours primitives:      ${our.length}`);
console.log(`matched:              ${matched}`);
console.log(`ref-only (Figma มี เราไม่มี): ${refOnly.reduce((a, b) => a + b[1], 0)}`);
console.log(`ours-only (เรามีเกิน):        ${ourOnly.reduce((a, b) => a + b[1], 0)}`);

const show = (list, label) => {
  console.log(`\n== ${label} (top 25) ==`);
  for (const [k, n] of list.slice(0, 25)) console.log(`  x${n}  ${k.slice(0, 150)}`);
};
show(refOnly, "Figma มีแต่เราไม่มี");
show(ourOnly, "เรามีแต่ Figma ไม่มี");

// fill color histogram diff
const colorCount = (list) => {
  const m = {};
  for (const p of list) {
    const c = p.fill !== "none" ? p.fill : `stroke:${p.stroke}`;
    m[c] = (m[c] ?? 0) + 1;
  }
  return m;
};
const rc = colorCount(ref);
const oc = colorCount(our);
console.log("\n== fill histogram (ref | ours) ==");
for (const c of new Set([...Object.keys(rc), ...Object.keys(oc)])) {
  console.log(`  ${c.padEnd(12)} ref=${rc[c] ?? 0} ours=${oc[c] ?? 0}`);
}
