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

import { geometryBlobToSVGPath, getBlobBytes, resolveVectorNodePaths } from "openfig-core";
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
  return `#${b(paint.color.r)}${b(paint.color.g)}${b(paint.color.b)}`;
}

// total paint opacity = paint.opacity * color.a; paints at ~0 are invisible
// (e.g. state-layer SOLID #fff opacity 0 — painting it opaque would blank
// everything beneath it)
function paintOpacity(paint: any): number {
  const po = typeof paint?.opacity === "number" ? paint.opacity : 1;
  const ca = typeof paint?.color?.a === "number" ? paint.color.a : 1;
  return po * ca;
}

// Figma vector-geometry blob decoder. Same wire format openfig-core decodes
// (0=close, 1=move, 2=line, 4=cubic, LE float32 args) PLUS command 3 =
// QUADRATIC_TO (16 bytes: qx,qy,x,y) which upstream silently bails on —
// TrueType-derived glyphs (e.g. the Thai/Latin UI font) use quads heavily.
// Quads are converted to cubics inline. Returns an SVG path string.
function decodeGeometryPathQ(blob: Uint8Array): string {
  if (!blob.length) return "";
  const view = new DataView(blob.buffer, blob.byteOffset, blob.byteLength);
  let o = 0;
  let out = "";
  let cx = 0, cy = 0; // current point
  let sx = 0, sy = 0; // subpath start
  let open = false;
  const f = (off: number) => Math.round(view.getFloat32(off, true) * 100) / 100;
  while (o < blob.length) {
    const cmd = blob[o++];
    if (cmd === 0) {
      if (open) {
        out += "Z";
        cx = sx; cy = sy; open = false;
      }
    } else if (cmd === 1 && o + 8 <= blob.length) {
      cx = f(o); cy = f(o + 4); o += 8;
      sx = cx; sy = cy; open = true;
      out += `M${cx} ${cy}`;
    } else if (cmd === 2 && o + 8 <= blob.length) {
      cx = f(o); cy = f(o + 4); o += 8;
      out += `L${cx} ${cy}`;
    } else if (cmd === 3 && o + 16 <= blob.length) {
      const qx = f(o), qy = f(o + 4);
      const ex = f(o + 8), ey = f(o + 12);
      o += 16;
      if (!open) { out += `M${cx} ${cy}`; open = true; }
      const c1x = Math.round((cx + (2 / 3) * (qx - cx)) * 100) / 100;
      const c1y = Math.round((cy + (2 / 3) * (qy - cy)) * 100) / 100;
      const c2x = Math.round((ex + (2 / 3) * (qx - ex)) * 100) / 100;
      const c2y = Math.round((ey + (2 / 3) * (qy - ey)) * 100) / 100;
      out += `C${c1x} ${c1y} ${c2x} ${c2y} ${ex} ${ey}`;
      cx = ex; cy = ey;
    } else if (cmd === 4 && o + 24 <= blob.length) {
      const x1 = f(o), y1 = f(o + 4), x2 = f(o + 8), y2 = f(o + 12);
      const ex = f(o + 16), ey = f(o + 20);
      o += 24;
      out += `C${x1} ${y1} ${x2} ${y2} ${ex} ${ey}`;
      cx = ex; cy = ey; open = true;
    } else {
      break; // unknown command — keep what we have
    }
  }
  return out;
}

// decode a glyph blob with quad support; returns "" when undecodable
function glyphPathD(doc: any, blobIndex: any): string {
  const bytes = getBlobBytes(doc, blobIndex);
  if (!bytes) return "";
  return decodeGeometryPathQ(bytes);
}

function paintInfo(paints: any): { fill: string | undefined; fillOpacity: number; imageHash: string | null; stops: any[] | null } {
  if (!Array.isArray(paints)) return { fill: undefined, fillOpacity: 1, imageHash: null, stops: null };
  for (const p of paints) {
    if (p?.visible === false) continue;
    const op = paintOpacity(p);
    if (op <= 0.001) continue;
    if (p.type === "SOLID") {
      const f = hexFill(p);
      if (f) return { fill: f, fillOpacity: op, imageHash: null, stops: null };
    }
    if (p.type === "IMAGE") {
      const m = /[\da-f]{40}/.exec(JSON.stringify(p));
      if (m) return { fill: undefined, fillOpacity: 1, imageHash: m[0], stops: null };
    }
  }
  for (const p of paints) {
    if (p?.visible === false) continue;
    if (Array.isArray(p.gradientStops) && p.gradientStops.length) {
      return { fill: undefined, fillOpacity: 1, imageHash: null, stops: p.gradientStops };
    }
  }
  return { fill: undefined, fillOpacity: 1, imageHash: null, stops: null };
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
  let gradSeq = 0;
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

  // walk the component subtree of an instance and pair every TEXT slot with
  // its symbolOverride text (derived entries dedupe by fontSize+length; pair
  // within each fontSize group by document order — verified against a live
  // file: title/label/placeholder/description all mapped correctly).
  // Pair an instance's symbolOverrides-derived text entries with TEXT slots.
  // Handles: direct slots (fontSize + document-order pairing), stale "*" runs
  // repositioned after the preceding text, variant-hidden slots (below the
  // instance's bottom edge), and overrides that target TEXT inside nested
  // sub-instances (matched by rendered width vs the sub-instance's width).
  function buildSlotMap(instance: RawChange, symId: string): Map<string, { glyphs: any[]; fill: string | undefined; hidden?: boolean }> {
    const map = new Map<string, { glyphs: any[]; fill: string | undefined; hidden?: boolean }>();
    const instW = instance.size?.x ?? Infinity;
    const instH = instance.size?.y ?? Infinity;

    type Slot = { id: string; fs: number; len: number; fill: string | undefined; chars: string; parentId: string; nodeX: number; bottom: number; order: number };
    const slots: Slot[] = [];
    let order = 0;
    (function collect(cid: string, depth: number, parentId: string, ty: number): void {
      if (depth > 14) return;
      for (const kid of fig.kidsOf.get(cid) ?? []) {
        const k = fig.nodes.get(kid);
        if (!k || k.visible === false) continue;
        const kTy = ty + (k.transform?.m12 ?? 0);
        if (k.type === "TEXT") {
          slots.push({
            id: kid,
            fs: k.fontSize ?? 14,
            len: (k.textData?.characters ?? "").length,
            fill: paintInfo(k.fillPaints).fill,
            chars: k.textData?.characters ?? "",
            parentId,
            nodeX: k.transform?.m02 ?? 0,
            bottom: kTy + (k.size?.y ?? 0),
            order: order++,
          });
        }
        collect(kid, depth + 1, kid, kTy);
      }
    })(symId, 0, symId, 0);

    const derived: Array<{ fs: number; len: number; glyphs: any[] }> = [];
    const seenKey = new Set<string>();
    for (const d of instance.derivedSymbolData ?? []) {
      const glyphs = d.derivedTextData?.glyphs ?? [];
      if (!glyphs.length) continue;
      const fs = glyphs[0]?.fontSize ?? 14;
      const len = d.derivedTextData?.baselines?.[0]?.endCharacter ?? -1;
      const key = `${fs}|${len}`;
      if (seenKey.has(key)) continue;
      seenKey.add(key);
      derived.push({ fs, len, glyphs });
    }

    const byFsSlots = new Map<number, Slot[]>();
    for (const s of slots) {
      if (!byFsSlots.has(s.fs)) byFsSlots.set(s.fs, []);
      byFsSlots.get(s.fs)!.push(s);
    }
    const byFsDerived = new Map<number, typeof derived>();
    for (const d of derived) {
      if (!byFsDerived.has(d.fs)) byFsDerived.set(d.fs, []);
      byFsDerived.get(d.fs)!.push(d);
    }
    const boundBySlot = new Map<string, { glyphs: any[]; fill: string | undefined }>();
    for (const [fs, ds] of byFsDerived) {
      const ss = (byFsSlots.get(fs) ?? []).filter((sl) => sl.bottom <= instH + 0.5); // variant-hidden slots sit below the instance bottom
      const n = Math.min(ds.length, ss.length);
      for (let i = 0; i < n; i++) boundBySlot.set(ss[i].id, { glyphs: ds[i].glyphs, fill: ss[i].fill });
    }
    // hide variant-hidden TEXT slots so their component default text never shows
    for (const sl of slots) {
      if (sl.bottom > instH + 0.5 && !boundBySlot.has(sl.id)) {
        map.set(sl.id, { glyphs: [], fill: sl.fill, hidden: true });
      }
    }
    // a stale "*" run lands mid-word (its position predates the override);
    // follow the preceding bound text run's rendered width instead
    for (const sl of slots) {
      if (sl.chars !== "*" || !boundBySlot.has(sl.id)) continue;
      const prev = slots.filter((p) => p.parentId === sl.parentId && p.order < sl.order && p.chars !== "*").pop();
      const prevBound = prev ? boundBySlot.get(prev.id) : undefined;
      if (prev && prevBound && prevBound.glyphs.length) {
        let prevEnd = 0;
        for (const g of prevBound.glyphs) prevEnd = Math.max(prevEnd, (g.position?.x ?? 0) + (g.fontSize ?? prev.fs) * 0.55);
        const shifted = boundBySlot.get(sl.id)!.glyphs.map((g) => ({ ...g, position: { ...g.position, x: prevEnd + prev.fs * 0.25 - sl.nodeX } }));
        boundBySlot.set(sl.id, { ...boundBySlot.get(sl.id)!, glyphs: shifted });
      }
    }
    for (const [id, v] of boundBySlot) map.set(id, v);

    return map;
  }

  const walk = (id: string, depth: number, noText: boolean, overrideMap?: Map<string, { glyphs: any[]; fill: string | undefined }>): string => {
    if (depth > maxDepth || nodeCount >= maxNodes) return "";
    const n = fig.nodes.get(id);
    if (!n || n.visible === false) return "";
    nodeCount++;

    // the ROOT node's own placement transform is ignored: its local space IS
    // the canvas (children are already relative to it)
    const t = n.transform ?? { m00: 1, m01: 0, m02: 0, m10: 0, m11: 1, m12: 0 };
    const tf = depth === 0 ? "" : ` transform="matrix(${r(t.m00)},${r(t.m10)},${r(t.m01)},${r(t.m11)},${r(t.m02)},${r(t.m12)})"`;
    const opacity = typeof n.opacity === "number" && n.opacity < 1 ? ` opacity="${r(n.opacity)}"` : "";
    const { fill, fillOpacity, imageHash, stops } = paintInfo(n.fillPaints);
    let gradient = "";
    if (stops) {
      const gid = `grad${gradSeq++}`;
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

    switch (n.type) {
      case "TEXT": {
        const bound = overrideMap?.get(id);
        if (bound?.hidden) return "";
        const fillHere = bound?.fill ?? fill ?? "#1a152b";
        void fillHere;
        const glyphs = bound?.glyphs ?? (noText ? null : n.derivedTextData?.glyphs);
        if (glyphs && glyphs.length) {
          let runs = "";
          for (const g of glyphs) {
            const d = glyphPathD(doc, g.commandsBlob);
            if (!d) continue;
            runs += `<g transform="translate(${r(g.position?.x ?? 0)},${r(g.position?.y ?? 0)}) scale(${r(g.fontSize ?? 14)},${-r(g.fontSize ?? 14)})"><path d="${d}" fill="${fillHere}"/></g>`;
          }
          if (runs) return `<g${tf}>${runs}</g>`;
        }
        if (noText) return "";
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
      case "FRAME":
      case "SECTION":
      case "COMPONENT":
      case "SYMBOL":
      case "GROUP":
      case "INSTANCE": {
        let childrenSvg = "";
        let glyphSvg = "";
        let childOverrideMap: Map<string, { glyphs: any[]; fill: string | undefined }> | undefined;
        if (n.type === "INSTANCE") {
          // instance internals are not materialized — render the component's
          // own subtree under the instance transform, with override texts
          // bound to their text slots (fontSize + document order pairing)
          const symId = guidStr(n.symbolData?.symbolID);
          if (symId) childOverrideMap = buildSlotMap(n, symId);
        }
        // ancestor bindings win over this instance's own (their derived data
        // reflects the final composed layout; sub-instance caches can be stale)
        if (childOverrideMap && overrideMap && overrideMap.size) {
          const merged = new Map(childOverrideMap);
          for (const [k2, v2] of overrideMap) merged.set(k2, v2);
          childOverrideMap = merged;
        }
        if (depth < maxDepth && nodeCount < maxNodes) {
          let childIds = fig.kidsOf.get(id) ?? [];
          if (n.type === "INSTANCE" && childIds.length === 0) {
            const symId = guidStr(n.symbolData?.symbolID);
            if (symId) childIds = fig.kidsOf.get(symId) ?? [];
          }
          for (const kid of childIds) {
            // bound slots render their override glyphs; unbound slots keep
            // the component default text — no blanket suppression
            childrenSvg += walk(kid, depth + 1, false, childOverrideMap ?? overrideMap);
          }
        }

        let inner = childrenSvg;
        const clips = (n.type === "FRAME" || n.type === "INSTANCE") && n.clipsContent === true; // Figma UI default is NO clip
        if (clips && inner && w > 0 && h > 0) {
          const cid = `clip${clipSeq++}`;
          defs.push(`<clipPath id="${cid}"><rect x="0" y="0" width="${w}" height="${h}"/></clipPath>`);
          inner = `<g clip-path="url(#${cid})">${inner}</g>`;
        }
        let bg = "";
        const paint = gradient || (fill && n.type !== "GROUP" ? fill : undefined);
        if (paint && w > 0 && h > 0) bg = `<rect x="0" y="0" width="${w}" height="${h}" fill="${paint}"${fillOpacity < 0.999 ? ` fill-opacity="${r(fillOpacity)}"` : ""}/>`;
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
        void glyphSvg;
        return `<g${tf}${opacity}>${bg}${img}${inner}</g>`;
      }
      case "RECTANGLE":
      case "ROUNDED_RECTANGLE": {
        const rx = n.cornerRadius ? ` rx="${r(n.cornerRadius)}"` : "";
        const paint = gradient || fill || "none";
        const fo = fill && fillOpacity < 0.999 ? ` fill-opacity="${r(fillOpacity)}"` : "";
        return `<rect x="0" y="0" width="${w}" height="${h}"${rx} fill="${paint}"${fo}${strokeText(n)}${opacity}/>`;
      }
      case "ELLIPSE": {
        const paint = gradient || fill || "none";
        const fo = fill && fillOpacity < 0.999 ? ` fill-opacity="${r(fillOpacity)}"` : "";
        return `<ellipse cx="${r(w / 2)}" cy="${r(h / 2)}" rx="${r(w / 2)}" ry="${r(h / 2)}" fill="${paint}"${fo}${opacity}/>`;
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
      default:
        return "";
    }
  };

  const inner = walk(rootId, 0, false);

  const svg =
    `<svg xmlns="http://www.w3.org/2000/svg" xmlns:xlink="http://www.w3.org/1999/xlink" width="${W}" height="${H}" viewBox="0 0 ${W} ${H}">\n` +
    (defs.length ? `<defs>${defs.join("")}</defs>\n` : "") +
    `<rect width="${W}" height="${H}" fill="#ffffff"/>\n` +
    inner +
    `\n</svg>\n`;

  return { svg, width: W, height: H, warnings, nodeCount };
}

type RawChange = Record<string, any>;
