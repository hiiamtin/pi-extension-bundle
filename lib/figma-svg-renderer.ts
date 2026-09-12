// Minimal offline SVG renderer for parsed .fig node trees.
//
// Scene-graph model: each node emits its OWN local transform and LOCAL
// coordinates; nesting inside the parent's <g> accumulates the transforms
// exactly once. (An earlier version emitted absolute coordinates INSIDE the
// transformed groups — double-transforming everything into a blank page.)
//
// Supports: frame clipping, rect/ellipse + radius, vector geometry via
// openfig's resolveVectorNodePaths (commandsBlobs → SVG paths), solid fills,
// image fills as data URIs, opacity, strokes, and <text> (local font
// availability affects the look). Instance internals render through their
// component subtree when not materialized in the export.
//
// Pure Node + openfig-core — unit-testable with synthetic documents.

import { resolveVectorNodePaths } from "openfig-core";
import type { MergedFig } from "./figma-instance-resolver.ts";
import { guidStr } from "./figma-instance-resolver.ts";

export interface RenderOptions {
  maxDepth?: number;
  maxNodes?: number;
}

export interface RenderResult {
  svg: string;
  width: number;
  height: number;
  warnings: string[];
  nodeCount: number;
}

function r(n: number): number {
  return Math.round(n * 100) / 100;
}

function esc(s: string): string {
  return String(s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}

function hexFill(paint: any): string | null {
  if (!paint?.color || typeof paint.color !== "object") return undefined;
  const b = (v: number) => Math.round(Math.max(0, Math.min(1, Number(v) || 0)) * 255).toString(16).padStart(2, "0");
  const base = `#${b(paint.color.r)}${b(paint.color.g)}${b(paint.color.b)}`;
  return typeof paint.color.a === "number" && paint.color.a < 1 ? `${base}${b(paint.color.a)}` : base;
}

function paintInfo(paints: any): { fill: string | undefined; imageHash: string | null; stops: any[] | null } {
  if (!Array.isArray(paints)) return { fill: undefined, imageHash: null, stops: null };
  for (const p of paints) {
    if (p?.visible === false) continue;
    if (p.type === "SOLID") {
      const f = hexFill(p);
      if (f) return { fill: f, imageHash: null, stops: null };
    }
    if (p.type === "IMAGE") {
      const m = /[\da-f]{40}/.exec(JSON.stringify(p));
      if (m) return { fill: undefined, imageHash: m[0], stops: null };
    }
  }
  for (const p of paints) {
    if (p?.visible === false) continue;
    if (Array.isArray(p.gradientStops) && p.gradientStops.length) {
      return { fill: undefined, imageHash: null, stops: p.gradientStops };
    }
  }
  return { fill: undefined, imageHash: null, stops: null };
}

// tiny string hash so gradient defs can be deduped without a deps-heavy map
function hashCode(s: string): number {
  let h = 0;
  for (let i = 0; i < s.length; i++) h = ((h << 5) - h + s.charCodeAt(i)) | 0;
  return h;
}

function sniffImageMime(bytes: Uint8Array): string {
  if (bytes[0] === 0x89 && bytes[1] === 0x50) return "image/png";
  if (bytes[0] === 0xff && bytes[1] === 0xd8) return "image/jpeg";
  return "application/octet-stream";
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
  const defs: string[] = [];
  const images = doc.images as Map<string, Uint8Array>;

  const root = fig.nodes.get(rootId);
  if (!root) return null;
  const size = root.size ?? { x: 100, y: 100 };
  const W = Math.max(1, Math.round(size.x));
  const H = Math.max(1, Math.round(size.y));

  const strokeText = (n: RawChange): string => {
    const sp = Array.isArray(n.strokePaints)
      ? n.strokePaints.find((p: any) => p?.visible !== false && p?.type === "SOLID")
      : null;
    const s = sp ? hexFill(sp) : null;
    const w = n.strokeWeight ?? 0;
    return s && w > 0 ? ` stroke="${s}" stroke-width="${r(w)}"` : "";
  };

  const walk = (id: string, depth: number): string => {
    if (depth > maxDepth || nodeCount >= maxNodes) return "";
    const n = fig.nodes.get(id);
    if (!n || n.visible === false) return "";
    nodeCount++;

    // local transform (root's own placement is ignored: its local space IS
    // the canvas)
    const t = n.transform ?? { m00: 1, m01: 0, m02: 0, m10: 0, m11: 1, m12: 0 };
    const tf = depth === 0 ? "" : ` transform="matrix(${r(t.m00)},${r(t.m10)},${r(t.m01)},${r(t.m11)},${r(t.m02)},${r(t.m12)})"`;
    const opacity = typeof n.opacity === "number" && n.opacity < 1 ? ` opacity="${r(n.opacity)}"` : "";
    const { fill, imageHash, stops } = paintInfo(n.fillPaints);
    let gradient = "";
    if (stops) {
      const gid = `grad${clipSeq++}`;
      defs.push(
        `<linearGradient id="${gid}" x1="0" y1="0" x2="1" y2="0">` +
          stops
            .map((s: any) => `<stop offset="${r((Number(s.position) || 0) * 100)}%" stop-color="${hexFill(s) ?? "#000"}"/>`)
            .join("") +
          `</linearGradient>`,
      );
      gradient = `url(#${gid})`;
    }
    const w = n.size ? Math.round(n.size.x) : 0;
    const h = n.size ? Math.round(n.size.y) : 0;

    let childrenSvg = "";
    if (depth < maxDepth && nodeCount < maxNodes) {
      let childIds = fig.kidsOf.get(id) ?? [];
      if (n.type === "INSTANCE" && childIds.length === 0) {
        // instance internals are not materialized — render the component's
        // own subtree under the instance transform (default texts)
        const symId = guidStr(n.symbolData?.symbolID);
        if (symId) childIds = fig.kidsOf.get(symId) ?? [];
      }
      for (const kid of childIds) childrenSvg += walk(kid, depth + 1);
    }

    switch (n.type) {
      case "FRAME":
      case "SECTION":
      case "COMPONENT":
      case "SYMBOL":
      case "GROUP":
      case "INSTANCE": {
        let inner = childrenSvg;
        if (clipsContent(n) && inner && w > 0 && h > 0) {
          const cid = `clip${clipSeq++}`;
          defs.push(`<clipPath id="${cid}"><rect x="0" y="0" width="${w}" height="${h}"/></clipPath>`);
          inner = `<g clip-path="url(#${cid})">${inner}</g>`;
        }
        let bg = "";
        const paint = gradient || (fill && n.type !== "GROUP" ? fill : undefined);
        if (paint && w > 0 && h > 0) bg = `<rect x="0" y="0" width="${w}" height="${h}" fill="${paint}"/>`;
        let img = "";
        if (imageHash && w > 0 && h > 0) {
          const bytes = images.get(imageHash);
          if (bytes) {
            const uri = `data:${sniffImageMime(bytes)};base64,${Buffer.from(bytes).toString("base64")}`;
            img = `<image x="0" y="0" width="${w}" height="${h}" href="${uri}" preserveAspectRatio="xMidYMid slice"/>`;
          } else {
            warnings.push(`image ${imageHash} not found in doc.images`);
          }
        }
        return `<g${tf}${opacity}>${bg}${img}${inner}</g>`;
      }
      case "RECTANGLE":
      case "ROUNDED_RECTANGLE": {
        const rx = n.cornerRadius ? ` rx="${r(n.cornerRadius)}"` : "";
        const paint = gradient || fill || "none";
        return `<rect x="0" y="0" width="${w}" height="${h}"${rx} fill="${paint}"${strokeText(n)}${opacity}/>`;
      }
      case "ELLIPSE": {
        const paint = gradient || fill || "none";
        return `<ellipse cx="${r(w / 2)}" cy="${r(h / 2)}" rx="${r(w / 2)}" ry="${r(h / 2)}" fill="${paint}"${opacity}/>`;
      }
      case "VECTOR":
      case "BOOLEAN_OPERATION":
      case "LINE":
      case "STAR":
      case "REGULAR_POLYGON": {
        try {
          const paths = resolveVectorNodePaths(doc, n as any);
          const g: string[] = [];
          for (const p of paths.fill) {
            if (!p.svgPath) continue;
            const pf = p.paints?.find((pp: any) => pp?.type === "SOLID");
            g.push(`<path d="${p.svgPath}" fill="${(pf && hexFill(pf)) || fill || "none"}"${opacity}/>`);
          }
          for (const p of paths.stroke) {
            if (!p.svgPath) continue;
            g.push(`<path d="${p.svgPath}" fill="none" stroke="${fill ?? "#000"}" stroke-width="${r(n.strokeWeight ?? 1)}"${opacity}/>`);
          }
          if (g.length) return g.join("");
        } catch (e) {
          warnings.push(`vector ${guidStr(n.guid)}: ${e instanceof Error ? e.message : String(e)}`);
        }
        return "";
      }
      case "TEXT": {
        const fs = n.fontSize ?? 14;
        const chars = n.textData?.characters ?? "";
        if (!chars) return "";
        const family = n.fontName?.family ?? "Inter";
        const align = n.textAlignHorizontal === "CENTER" ? ' text-anchor="middle"' : n.textAlignHorizontal === "RIGHT" ? ' text-anchor="end"' : "";
        const x = n.textAlignHorizontal === "CENTER" ? w / 2 : n.textAlignHorizontal === "RIGHT" ? w : 0;
        const y = r(fs * 0.8);
        const tf2 = fill ?? "#1a152b";
        return `<text x="${r(x)}" y="${y}" font-family="${esc(family)}, sans-serif" font-size="${r(fs)}" fill="${tf2}"${align}>${esc(chars)}</text>`;
      }
      default:
        return childrenSvg; // unknown type — still render resolved children
    }
  };

  function clipsContent(n: RawChange): boolean {
    return n.type === "FRAME" && (n.clipsContent === undefined ? true : n.clipsContent === true);
  }

  const inner = walk(rootId, 0);

  const svg =
    `<svg xmlns="http://www.w3.org/2000/svg" xmlns:xlink="http://www.w3.org/1999/xlink" width="${W}" height="${H}" viewBox="0 0 ${W} ${H}">\n` +
    (defs.length ? `<defs>${defs.join("")}</defs>\n` : "") +
    `<rect width="${W}" height="${H}" fill="#ffffff"/>\n` +
    inner +
    `\n</svg>\n`;

  return { svg, width: W, height: H, warnings, nodeCount };
}

type RawChange = Record<string, any>;
