import { readFileSync, writeFileSync } from 'node:fs';
const { parseFig } = await import('openfig-core');
const { mergeNodeChanges } = await import('./lib/figma-instance-resolver.ts');
const { renderNodeSVG } = await import('./lib/figma-svg-renderer.ts');
const doc = parseFig(new Uint8Array(readFileSync('.pi/figma-exports/[Sonic] Common.fig')));
const fig = mergeNodeChanges(doc.message?.nodeChanges ?? []);
const res = renderNodeSVG(doc, fig, '470:28167', { maxDepth: 22, maxNodes: 20000 });
writeFileSync('.pi/figma-exports/fig-_Sonic_Common/render/470-28167.svg', res.svg);
console.log('OK');
