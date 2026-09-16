import { parseFig } from 'openfig-core';
import { readFileSync, mkdirSync, writeFileSync, existsSync, readdirSync } from 'node:fs';
import path from 'node:path';
const { mergeNodeChanges, resolveSubtree, guidStr } = await import('../lib/figma-instance-resolver.ts');
const { renderNodeSVG } = await import('../lib/figma-svg-renderer.ts');
const FIG = '/Users/rattanarit.prasomsab/Sonic/.pi/figma-exports/[SONIC] Customer (Service).fig';
const OUT = '.pi/figma-exports/fig-_SONIC_Customer_Service/render';
mkdirSync(OUT, { recursive: true });
const d = parseFig(new Uint8Array(readFileSync(FIG)));
const fig = mergeNodeChanges(d.message.nodeChanges ?? []);
console.log('nodes:', fig.nodes.size);
const fontsDir = path.resolve('fonts');
const ids = ['24112:19639','28097:11351','16201:5144','16201:7166','17538:12052','24112:19322'];
for (const id of ids) {
  const n = fig.nodes.get(id);
  if (!n) { console.log(id, '-> NOT FOUND'); continue; }
  const sub = resolveSubtree(fig, id, { maxDepth: 10, maxChildren: 40 });
  const name = (n.name ?? id).replace(/[^\w.-]+/g, '-').slice(0, 60);
  let render = renderNodeSVG(d, fig, id, { maxDepth: 14, maxNodes: 60000 });
  if (render && existsSync(fontsDir) && render.fontFamilies.length) {
    const WEIGHTS = { thin:'100',extralight:'200',light:'300',regular:'400',medium:'500',semibold:'600',bold:'700',extrabold:'800',black:'900' };
    const slug = (x) => x.toLowerCase().replace(/[^a-z0-9]/g, '');
    const wanted = new Map(render.fontFamilies.map((f) => [slug(f), f]));
    const faces = [];
    for (const file of (readdirSync(fontsDir)).filter((f) => /\.(woff2?|ttf|otf)$/i.test(f))) {
      const stem = file.replace(/\.[^.]+$/, '');
      const m = /^(.*)-([A-Za-z]+)$/.exec(stem);
      const base = m && slug(m[2]) in WEIGHTS ? m[1] : stem;
      const weight = m && slug(m[2]) in WEIGHTS ? WEIGHTS[slug(m[2])] : '400';
      const family = wanted.get(slug(base));
      if (!family) continue;
      const fmt = /\.woff2$/i.test(file) ? 'woff2' : /\.woff$/i.test(file) ? 'woff' : /\.otf$/i.test(file) ? 'opentype' : 'truetype';
      const data = readFileSync(path.join(fontsDir, file)).toString('base64');
      faces.push(`@font-face{font-family:'${family.replace(/'/g, '')}';src:url(data:font/${fmt};base64,${data}) format('${fmt}');font-weight:${weight};font-style:normal;}`);
    }
    if (faces.length) render = renderNodeSVG(d, fig, id, { maxDepth: 14, maxNodes: 60000, fontCSS: faces.join('') });
  }
  const svgPath = path.join(OUT, `${id.replace(':', '-')}.svg`);
  if (render) writeFileSync(svgPath, render.svg);
  console.log(id, JSON.stringify(n.name), `${n.size?.x}x${n.size?.y}`, '->', render ? `${render.width}x${render.height} ${render.nodeCount} nodes, ${(render.svg.length/1024).toFixed(0)}KiB` : 'RENDER FAILED');
}
