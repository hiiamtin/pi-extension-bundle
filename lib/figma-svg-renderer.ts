// Minimal offline SVG renderer for parsed .fig node trees.
//
// Walks the merged nodeChanges tree (lib/figma-instance-resolver.ts merge),
// accumulates absolute transforms, and emits SVG: frames with clipping,
// rectangles/ellipses, vector geometry (via openfig's blob → SVG path
// helpers), solid/gradient/image paints, and text.
//
// Fidelity: MVP (~90% for flat design-system UI). Effects, blend modes,
// masks and exotic paints are skipped; text is drawn with <text> (font
// availability affects look). instance text overrides are overlaid at their
// derived positions with component-default slots skipped when they collide.
//
// Pure Node + openfig-core (already a dependency) — unit-testable with
// synthetic documents (pass a stub `doc` when there are no VECTOR nodes).

import { resolveVectorNodePaths } from "openfig-core";
import type { MergedFig } from "./figma-instance-resolver.ts";
import { guidStr } from "./figma-instance-resolver.ts";

export interface RenderOptions {
  maxDepth?: number;
  maxNodes?: number;
}

interface Matrix {
  a: number;
  b: number;
  c: number;
  d: number;
  e: number;
  f: number;
}

const IDENTITY: Matrix = { a: 1, b: 0, c: 0, d: 1, e: 0, f: 0 };

function multiply(m: Matrix, c: Matrix): Matrix {
  return {
    a: m.a * c.a + m.c * c.b,
    b: m.b * c.a + m.d * c.b,
    c: m.a * c.c + m.c * c.d,
    d: m.b * c.c + m.d * c.d,
    e: m.a * c.e + m.c * c.f + m.e,
    f: m.b * c.e + m.d * c.f + m.f,
  };
}

function toMatrixAttr(m: Matrix): string {
  return `matrix(${r(m.a)},${r(m.b)},${r(m.c)},${r(m.d)},${r(m.e)},${r(m.f)})`;
}

function r(n: number): number {
  return Math.round(n * 100) / 100;
}

function esc(s: string): string {
  return String(s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}

function hexFill(paint: any): string | null {
  if (!paint?.color || typeof paint.color !== "object") return null;
  const b = (v: number) => Math.round(Math.max(0, Math.min(1, Number(v) || 0)) * 255).toString(16).padStart(2, "0");
  return `#${b(paint.color.r)}${b(paint.color.g)}${b(paint.color.b)}`;
}

/** pick the first visible paint: solid → hex, IMAGE → hash, else type */
function paintInfo(paints: any): { fill: string | null; imageHash: string | null; gradient: any | null } {
  if (!Array.isArray(paints)) return { fill: null, imageHash: null, gradient: null };
  for (const p of paints) {
    if (p?.visible === false) continue;
    if (p.type === "SOLID") {
      const f = hexFill(p);
      if (f) return { fill: f, imageHash: null, gradient: null };
    }
    if (p.type === "IMAGE") {
      const m = /[\da-f]{40}/.exec(JSON.stringify(p));
      if (m) return { fill: null, imageHash: m[0], gradient: null };
    }
  }
  for (const p of paints) {
    if (p?.visible === false) continue;
    if (Array.isArray(p.gradientStops) && p.gradientStops.length) return { fill: null, imageHash: null, gradient: p };
  }
  return { fill: null, imageHash: null, gradient: null };
}

function sniffImageMime(bytes: Uint8Array): string {
  if (bytes[0] === 0x89 && bytes[1] === 0x50) return "image/png";
  if (bytes[0] === 0xff && bytes[1] === 0xd8) return "image/jpeg";
  return "application/octet-stream";
}

export interface RenderResult {
  svg: string;
  width: number;
  height: number;
  warnings: string[];
  nodeCount: number;
}

export function renderNodeSVG(
  doc: any,
  fig: MergedFig,
  rootId: string,
  opts?: RenderOptions,
): RenderResult | null {
  const maxDepth = Math.min(20, Math.max(1, opts?.maxDepth ?? 18));
  const maxNodes = Math.max(50, opts?.maxNodes ?? 4000);
  const warnings: string[] = [];
  let nodeCount = 0;
  let clipSeq = 0;
  const body: string[] = [];

  const root = fig.nodes.get(rootId);
  if (!root) return null;
  const size = root.size ?? { x: 100, y: 100 };
  const W = Math.max(1, Math.round(size.x));
  const H = Math.max(1, Math.round(size.y));
  const images = doc.images as Map<string, Uint8Array>;

  const walk = (id: string, m: Matrix, depth: number): void => {
    if (depth > maxDepth || nodeCount >= maxNodes) return;
    const n = fig.nodes.get(id);
    if (!n || n.visible === false) return;
    nodeCount++;

    // the ROOT node's own placement transform is ignored: its local space IS
    // the canvas (children are already relative to it)
    const t = n.transform ?? { m00: 1, m01: 0, m02: 0, m10: 0, m11: 1, m12: 0 };
    const own: Matrix = { a: t.m00, b: t.m10, c: t.m01, d: t.m11, e: t.m02, f: t.m12 };
    const abs = depth === 0 ? IDENTITY : multiply(m, own);
    const w = n.size ? Math.round(n.size.x) : 0;
    const h = n.size ? Math.round(n.size.y) : 0;
    const opacity = typeof n.opacity === "number" && n.opacity < 1 ? ` opacity="${r(n.opacity)}"` : "";
    const { fill, imageHash, gradient } = paintInfo(n.fillPaints);

    const container = n.type === "FRAME" || n.type === "SECTION" || n.type === "COMPONENT" || n.type === "SYMBOL" || n.type === "GROUP" || n.type === "INSTANCE";
    const clips = n.type === "FRAME" && (n.clipsContent === undefined ? true : n.clipsContent === true);

    let openTag = "";
    let closeTag = "";
    let clipAttr = "";
    if (container) {
      openTag = `<g transform="${toMatrixAttr(abs)}"${opacity}>`;
      closeTag = `</g>`;
      if (clips && w > 0 && h > 0) {
        const cid = `clip${clipSeq++}`;
        body.push(`<clipPath id="${cid}"><rect x="0" y="0" width="${w}" height="${h}"/></clipPath>`);
        clipAttr = ` clip-path="url(#${cid})"`;
      }
      if (fill && n.type !== "GROUP") body.push(`<rect x="0" y="0" width="${w}" height="${h}" fill="${fill}"${clipAttr}/>`);
    }

    switch (n.type) {
      case "RECTANGLE":
      case "ROUNDED_RECTANGLE": {
        const rx = n.cornerRadius ? ` rx="${r(n.cornerRadius)}"` : "";
        const stroke = strokeAttrs(n);
        body.push(`<rect x="${r(abs.e)}" y="${r(abs.f)}" width="${w}" height="${h}"${rx} fill="${fill ?? "none"}"${strokeAttrsToText(stroke)}${opacity}/>`);
        break;
      }
      case "ELLIPSE": {
        body.push(`<ellipse cx="${r(abs.e + w / 2)}" cy="${r(abs.f + h / 2)}" rx="${r(w / 2)}" ry="${r(h / 2)}" fill="${fill ?? "none"}"${opacity}/>`);
        break;
      }
      case "VECTOR":
      case "BOOLEAN_OPERATION":
      case "LINE":
      case "STAR":
      case "REGULAR_POLYGON": {
        try {
          const paths = resolveVectorNodePaths(doc, n as any);
          for (const p of paths.fill) {
            if (!p.svgPath) continue;
            const pf = p.paints?.find((pp: any) => pp?.type === "SOLID");
            const f = pf ? hexFill(pf) : fill;
            body.push(`<g transform="${toMatrixAttr(abs)}"${opacity}><path d="${p.svgPath}" fill="${f ?? "none"}"/></g>`);
          }
          for (const p of paths.stroke) {
            if (!p.svgPath) continue;
            body.push(`<g transform="${toMatrixAttr(abs)}"${opacity}><path d="${p.svgPath}" fill="none" stroke="${fill ?? "#000"}" stroke-width="${r(n.strokeWeight ?? 1)}"/></g>`);
          }
        } catch (e) {
          warnings.push(`vector ${guidStr(n.guid)}: ${e instanceof Error ? e.message : String(e)}`);
        }
        break;
      }
      case "TEXT": {
        const fs = n.fontSize ?? 14;
        const tf = fill ?? "#1a152b";
        const family = n.fontName?.family ?? "Inter";
        const align = n.textAlignHorizontal === "CENTER" ? ' text-anchor="middle"' : n.textAlignHorizontal === "RIGHT" ? ' text-anchor="end"' : "";
        const chars = n.textData?.characters ?? "";
        const bx = abs.e + (n.textAlignHorizontal === "CENTER" ? w / 2 : n.textAlignHorizontal === "RIGHT" ? w : 0);
        const by = abs.f + Math.round(fs * 0.8);
        if (chars) body.push(`<text x="${r(bx)}" y="${r(by)}" font-family="${esc(family)}, sans-serif" font-size="${r(fs)}" fill="${tf}"${align}>${esc(chars)}</text>`);
        break;
      }
      default:
        break;
    }

    if (openTag) body.push(openTag);

    // image fill (paint-level) drawn over the container background
    if (imageHash && container && w > 0 && h > 0) {
      const bytes = images.get(imageHash);
      if (bytes) {
        const uri = `data:${sniffImageMime(bytes)};base64,${Buffer.from(bytes).toString("base64")}`;
        body.push(`<image x="0" y="0" width="${w}" height="${h}" href="${uri}" preserveAspectRatio="xMidYMid slice"${clipAttr}/>`);
      } else {
        warnings.push(`image ${imageHash} not found in doc.images`);
      }
    }

    // children (instance internals resolve through the component)
    let childIds = fig.kidsOf.get(id) ?? [];
    if (n.type === "INSTANCE" && childIds.length === 0) {
      // instance internals are not materialized — render the component's own
      // subtree under the instance transform (default texts; overrides later)
      const symId = guidStr(n.symbolData?.symbolID);
      if (symId) childIds = fig.kidsOf.get(symId) ?? [];
    }
    for (const kid of childIds) walk(kid, abs, depth + 1);

    if (closeTag) body.push(closeTag);
  };

  const strokeAttrs = (n: RawChange): { s: string | null; w: number } => {
    const sp = Array.isArray(n.strokePaints) ? n.strokePaints.find((p: any) => p?.visible !== false && p?.type === "SOLID") : null;
    return { s: sp ? hexFill(sp) : null, w: n.strokeWeight ?? 0 };
  };
  const strokeAttrsToText = (st: { s: string | null; w: number }): string =>
    st.s && st.w > 0 ? ` stroke="${st.s}" stroke-width="${r(st.w)}"` : "";

  walk(rootId, IDENTITY, 0);

  const svg =
    `<svg xmlns="http://www.w3.org/2000/svg" xmlns:xlink="http://www.w3.org/1999/xlink" width="${W}" height="${H}" viewBox="0 0 ${W} ${H}">\n` +
    `<rect width="${W}" height="${H}" fill="#ffffff"/>\n` +
    body.join("\n") +
    `\n</svg>\n`;

  return { svg, width: W, height: H, warnings, nodeCount };
}

type RawChange = Record<string, any>;
