#!/usr/bin/env node
// Pixel-level diff between the reference export and our render.
// Renders both SVGs with headless Chrome and counts differing pixels.
import { execSync } from "node:child_process";
import { readFileSync, writeFileSync, existsSync } from "node:fs";
import path from "node:path";

const base = ".pi/figma-exports/fig-_Sonic_Common/render";
const refSvg = process.argv[2] ?? `${base}/reference.svg`;
const ourSvg = process.argv[3] ?? `${base}/470-28167.svg`;
const chrome = "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";

const shot = (svg, out) => {
  if (!existsSync(svg)) { console.error(`missing: ${svg}`); process.exit(1); }
  execSync(`"${chrome}" --headless --disable-gpu --screenshot="${out}" --window-size=1440,1024 --hide-scrollbars "file://${path.resolve(svg)}"`, { stdio: "ignore" });
};

shot(refSvg, "/tmp/svgdiff-ref.png");
shot(ourSvg, "/tmp/svgdiff-our.png");

// pixel diff via a tiny HTML canvas harness (avoids native deps)
const html = `<!doctype html><canvas id=c width=1440 height=1024></canvas><script>
const c = document.getElementById('c');
const x = c.getContext('2d');
Promise.all([
  new Promise(r => { const i = new Image(); i.onload = () => r(i); i.src = '/tmp/svgdiff-ref.png'; }),
  new Promise(r => { const i = new Image(); i.onload = () => r(i); i.src = '/tmp/svgdiff-our.png'; }),
]).then(([a, b]) => {
  x.drawImage(a, 0, 0); const A = x.getImageData(0, 0, 1440, 1024).data;
  x.clearRect(0, 0, 1440, 1024);
  x.drawImage(b, 0, 0); const B = x.getImageData(0, 0, 1440, 1024).data;
  let diff = 0; const boxes = [];
  for (let y = 0; y < 1024; y++) for (let x = 0; x < 1440; x++) {
    const i = (y * 1440 + x) * 4;
    const d = Math.abs(A[i]-B[i]) + Math.abs(A[i+1]-B[i+1]) + Math.abs(A[i+2]-B[i+2]);
    if (d > 30) { diff++; if (boxes.length < 400000) boxes.push(x, y, d); }
  }
  document.title = JSON.stringify({ diff, boxes });
});
</script>`;

writeFileSync("/tmp/svgdiff.html", html);
// render the harness with chrome and read document.title via --dump-dom? simpler: use --headless=new --virtual-time-budget and print title
const out = execSync(
  `"${chrome}" --headless --disable-gpu --dump-dom --virtual-time-budget=4000 "file:///tmp/svgdiff.html" 2>/dev/null | grep -o '<title>[^<]*</title>'`,
  { shell: "/bin/bash" }
).toString();
const m = out.match(/<title>(.*)<\/title>/);
const data = m ? JSON.parse(m[1]) : { diff: -1, boxes: [] };
console.log(`differing pixels (ΔRGB>30): ${data.diff} / ${1440 * 1024} = ${((data.diff / (1440 * 1024)) * 100).toFixed(3)}%`);
// cluster boxes into regions
const pts = [];
for (let i = 0; i < data.boxes.length; i += 3) pts.push([data.boxes[i], data.boxes[i + 1]]);
const regions = [];
for (const [x, y] of pts) {
  const r = regions.find(([rx, ry, rw, rh]) => x >= rx - 12 && x <= rx + rw + 12 && y >= ry - 12 && y <= ry + rh + 12);
  if (r) {
    r[2] = Math.max(r[2], x - r[0] + 1); r[3] = Math.max(r[3], y - r[1] + 1);
    r[0] = Math.min(r[0], x); r[1] = Math.min(r[1], y);
  } else regions.push([x, y, 1, 1]);
}
regions.sort((a, b) => b[2] * b[3] - a[2] * a[3]);
console.log("diff regions (x,y,w,h):");
for (const r of regions.slice(0, 15)) console.log(`  (${r[0]},${r[1]}) ${r[2]}x${r[3]}`);
console.log(`total regions: ${regions.length}`);
