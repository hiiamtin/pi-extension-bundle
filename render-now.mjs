import { readFileSync, writeFileSync } from 'node:fs';
const { parseFig } = await import('openfig-core');
const { mergeNodeChanges } = await import('./lib/figma-instance-resolver.ts');
const { renderNodeSVG } = await import('./lib/figma-svg-renderer.ts');
const doc = parseFig(new Uint8Array(readFileSync('.pi/figma-exports/[Sonic] Common.fig')));
const fig = mergeNodeChanges(doc.message?.nodeChanges ?? []);
const b64 = (p) => readFileSync(p).toString('base64');
const fontCSS =
  `@font-face{font-family:'SCBX Looped';src:url(data:font/woff2;base64,${b64('fonts/SCBXLooped-Regular.woff2')}) format('woff2');font-weight:400;font-style:normal;}` +
  `@font-face{font-family:'SCBX Looped';src:url(data:font/woff2;base64,${b64('fonts/SCBXLooped-Bold.woff2')}) format('woff2');font-weight:700;font-style:normal;}`;
const res = renderNodeSVG(doc, fig, '470:28167', { maxDepth: 22, maxNodes: 20000, fontCSS });
writeFileSync('.pi/figma-exports/fig-_Sonic_Common/render/470-28167.svg', res.svg);
console.log('OK', res.svg.length);
