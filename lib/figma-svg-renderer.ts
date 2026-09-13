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

type AssignVal = { bool?: boolean; text?: string };
type AssignMap = Map<string, AssignVal>;
type DirNode = { swapSym?: string; assigns: AssignMap; textByKey: Map<string, any[]>; children: Map<string, DirNode> };
type SlotBinding = {
  glyphs?: any[];
  fill?: string | undefined;
  hidden?: boolean;
  propText?: string;
  upgraded?: boolean;
  boundW?: number;
};

const newDirNode = (): DirNode => ({ assigns: new Map(), textByKey: new Map(), children: new Map() });

/** flatten componentPropAssignments into defId -> {bool?, text?} */
function assignMap(list: any[] | undefined): AssignMap {
  const m: AssignMap = new Map();
  for (const a of list ?? []) {
    const defId = a?.defID ? guidStr(a.defID) : null;
    if (!defId) continue;
    const bool = a?.varValue?.value?.boolValue ?? a?.value?.boolValue;
    const text = a?.value?.textValue?.characters ?? a?.varValue?.value?.textDataValue?.characters;
    m.set(defId, { bool: typeof bool === "boolean" ? bool : undefined, text: typeof text === "string" ? text : undefined });
  }
  return m;
}

function nodeVisibleRefs(n: RawChange): string[] {
  return (n.componentPropRefs ?? [])
    .filter((r: any) => r?.componentPropNodeField === "VISIBLE")
    .map((r: any) => guidStr(r.defID))
    .filter(Boolean) as string[];
}

function nodeTextRef(n: RawChange): string | null {
  const r = (n.componentPropRefs ?? []).find((r: any) => r?.componentPropNodeField === "TEXT_DATA");
  return r ? guidStr(r.defID) : null;
}

const guidPathOf = (d: any): string[] => ((d?.guidPath?.guids ?? []).map(guidStr).filter(Boolean)) as string[];
const okeyOf = (n: RawChange): string | null => {
  const o = n.overrideKey;
  return o ? `${o.sessionID}:${o.localID}` : null;
};

/**
 * Directive tree for one instance: symbolOverrides / derivedSymbolData paths
 * are addressed by overrideKey chains ([childKey, grandKey, ..., textGuid]),
 * so every node in the tree addresses exactly one descendant — no heuristics.
 */
function buildDirectiveTree(instance: RawChange): DirNode {
  const root = newDirNode();
  const ensure = (keys: string[]): DirNode => {
    let cur = root;
    for (const k of keys) {
      let c = cur.children.get(k);
      if (!c) {
        c = newDirNode();
        cur.children.set(k, c);
      }
      cur = c;
    }
    return cur;
  };
  for (const o of instance.symbolData?.symbolOverrides ?? []) {
    const path = guidPathOf(o);
    if (!path.length) continue;
    const node = ensure(path);
    for (const [k, v] of assignMap(o.componentPropAssignments)) node.assigns.set(k, v);
    const sw = guidStr(o.overriddenSymbolID);
    if (sw) node.swapSym = sw;
  }
  for (const d of instance.derivedSymbolData ?? []) {
    const glyphs = d.derivedTextData?.glyphs ?? [];
    if (!glyphs.length) continue;
    const path = guidPathOf(d);
    if (!path.length) continue;
    const node = ensure(path);
    const last = path[path.length - 1];
    const prev = node.textByKey.get(last);
    if (!prev || glyphs.length > prev.length) node.textByKey.set(last, glyphs);
  }
  return root;
}

/** merge ancestor directive over own tree: ancestor wins per key, deeper
 * children merge recursively; text runs keep the LONGER (more composed) */
function mergeDir(anc: DirNode | undefined, own: DirNode): DirNode {
  if (!anc) return own;
  const out: DirNode = { swapSym: anc.swapSym ?? own.swapSym, assigns: new Map([...own.assigns, ...anc.assigns]), textByKey: new Map(own.textByKey), children: new Map() };
  const keys = new Set([...own.children.keys(), ...anc.children.keys()]);
  for (const k of keys) {
    const o = own.children.get(k);
    const a = anc.children.get(k);
    if (o && a) {
      const textByKey = new Map(o.textByKey);
      for (const [gk, gv] of a.textByKey) {
        const prev = textByKey.get(gk);
        if (!prev || gv.length > prev.length) textByKey.set(gk, gv);
      }
      out.children.set(k, { swapSym: a.swapSym ?? o.swapSym, assigns: new Map([...o.assigns, ...a.assigns]), textByKey, children: mergeDirChildren(a.children, o.children) });
    } else {
      out.children.set(k, (a ?? o)!);
    }
  }
  return out;
}

function mergeDirChildren(anc: Map<string, DirNode>, own: Map<string, DirNode>): Map<string, DirNode> {
  const out: Map<string, DirNode> = new Map();
  const keys = new Set([...own.keys(), ...anc.keys()]);
  for (const k of keys) {
    const o = own.get(k);
    const a = anc.get(k);
    if (o && a) {
      const textByKey = new Map(o.textByKey);
      for (const [gk, gv] of a.textByKey) {
        const prev = textByKey.get(gk);
        if (!prev || gv.length > prev.length) textByKey.set(gk, gv);
      }
      out.set(k, { swapSym: a.swapSym ?? o.swapSym, assigns: new Map([...o.assigns, ...a.assigns]), textByKey, children: mergeDirChildren(a.children, o.children) });
    } else {
      out.set(k, (a ?? o)!);
    }
  }
  return out;
}


// ─── Absolute (Figma-export-style) serialization ────────────────────────────
// Figma's Copy-as-SVG flattens the document to absolute-coordinate paths:
// text becomes glyph outline paths (one per line), frames become their exact
// fill geometry, clips become clipPaths. All numbers = frame-space. This
// mirrors that serialization using the geometry baked into the .fig.

type Mat = [number, number, number, number, number, number];
const M_ID: Mat = [1, 0, 0, 1, 0, 0];
const mulM = (m: Mat, n: Mat): Mat => [
  m[0] * n[0] + m[2] * n[1], m[1] * n[0] + m[3] * n[1],
  m[0] * n[2] + m[2] * n[3], m[1] * n[2] + m[3] * n[3],
  m[0] * n[4] + m[2] * n[5] + m[4], m[1] * n[4] + m[3] * n[5] + m[5],
];
const nodeMat = (n: any): Mat => {
  const t = n.transform;
  // Figma [[m00,m01,m02],[m10,m11,m12]] → SVG matrix(a,b,c,d,e,f) =
  // [m00, m10, m01, m11, m02, m12]
  return t ? [t.m00, t.m10, t.m01, t.m11, t.m02, t.m12] : M_ID;
};
const scaleM = (sx: number, sy: number): Mat => [sx, 0, 0, sy, 0, 0];
const transM = (x: number, y: number): Mat => [1, 0, 0, 1, x, y];

function xf(v: number): string {
  const r = Math.round(v * 1000) / 1000;
  return (Object.is(r, -0) ? 0 : r).toString();
}

/** apply a 2x3 matrix to an absolute-command SVG path, Figma-style output */
function xfPath(d: string, m: Mat): string {
  if (m[0] === 1 && m[1] === 0 && m[2] === 0 && m[3] === 1 && m[4] === 0 && m[5] === 0) return d;
  const dbg = process.env.FIGMA_DEBUG_SLOTS === "1";
  const toks = d.match(/[MmLlHhVvCcSsQqTtAaZz]|-?\d*\.?\d+(?:e[-+]?\d+)?/g) ?? [];
  let out = "";
  let cmd = "";
  const nums: number[] = [];
  let cx = 0, cy = 0;      // current point (source space)
  let px = NaN, py = NaN;  // last emitted point (dest space)
  const flush = (): void => {
    if (!cmd || nums.length === 0) { nums.length = 0; return; }
    const p = nums;
    const tp = (x: number, y: number): number[] => [m[0] * x + m[2] * y + m[4], m[1] * x + m[3] * y + m[5]];
    let seg = "";
    if (cmd === "M" || cmd === "L") {
      const [X, Y] = tp(p[0], p[1]);
      seg = !isNaN(px) && Math.abs(Y - py) < 5e-4 && (cmd === "L") ? `H${xf(X)}` : `${cmd}${xf(X)} ${xf(Y)}`;
      px = X; py = Y;
    } else if (cmd === "C") {
      const q = [...tp(p[0], p[1]), ...tp(p[2], p[3]), ...tp(p[4], p[5])].map(xf);
      seg = `C${q.join(" ")}`;
      px = Number(q[4]); py = Number(q[5]);
    } else if (cmd === "Q") {
      const q = [...tp(p[0], p[1]), ...tp(p[2], p[3])].map(xf);
      seg = `Q${q.join(" ")}`;
      px = Number(q[2]); py = Number(q[3]);
    } else if (cmd === "Z") {
      seg = "Z";
      px = NaN; py = NaN;
    }
    out += seg;
    nums.length = 0;
  };
  for (const tk of toks) {
    if (/[a-zA-Z]/.test(tk)) {
      flush();
      const up = tk.toUpperCase();
      if (up === "M") { /* close prev subpath implicitly */ }
      cmd = up === "M" ? "M" : up;
      if (up === "Z") { flush(); out += "Z"; cmd = ""; }
      if (up === "M") { /* new subpath start tracked on coords */ }
      continue;
    }
    const v = parseFloat(tk);
    if (Number.isNaN(v)) continue;
    nums.push(v);
    const need: Record<string, number> = { M: 2, L: 2, H: 1, V: 1, C: 6, S: 4, Q: 4, T: 2, A: 7 };
    if (cmd && nums.length >= (need[cmd] ?? 99)) {
      if (cmd === "H") { cx = nums[0]; const [X, Y] = [m[0]*cx+m[2]*cy+m[4], m[1]*cx+m[3]*cy+m[5]]; out += `H${xf(X)}`; px = X; py = Y; nums.length = 0; cmd = "L"; continue; }
      if (cmd === "V") { cy = nums[0]; const [X, Y] = [m[0]*cx+m[2]*cy+m[4], m[1]*cx+m[3]*cy+m[5]]; out += `V${xf(Y)}`; px = X; py = Y; nums.length = 0; cmd = "L"; continue; }
      if (cmd === "M" || cmd === "L") { cx = nums[0]; cy = nums[1]; }
      else if (cmd === "C") { cx = nums[4]; cy = nums[5]; }
      else if (cmd === "Q") { cx = nums[2]; cy = nums[3]; }
      flush();
    }
  }
  flush();
  if (dbg && out.includes("NaN")) console.error(`[xfNaN] in="${d.slice(0, 120)}" mat=[${m.map(r)}] out="${out.slice(0, 120)}"`);
  return out;
}

/** synthesize a rounded-rect path (Figma kappa 0.5177 corner curves) */
function roundedRectPath(x: number, y: number, w: number, h: number, r: number): string {
  const rr = Math.min(r, w / 2, h / 2);
  const k = rr * 0.5177;
  const x2 = x + w, y2 = y + h;
  return (
    `M${xf(x + rr)} ${xf(y)}H${xf(x2 - rr)}C${xf(x2 - rr + k)} ${xf(y)} ${xf(x2)} ${xf(y + rr - k)} ${xf(x2)} ${xf(y + rr)}` +
    `V${xf(y2 - rr)}C${xf(x2)} ${xf(y2 - rr + k)} ${xf(x2 - rr + k)} ${xf(y2)} ${xf(x2 - rr)} ${xf(y2)}` +
    `H${xf(x + rr)}C${xf(x + rr - k)} ${xf(y2)} ${xf(x)} ${xf(y2 - rr + k)} ${xf(x)} ${xf(y2 - rr)}` +
    `V${xf(y + rr)}C${xf(x)} ${xf(y + rr - k)} ${xf(x + rr - k)} ${xf(y)} ${xf(x + rr)} ${xf(y)}Z`
  );
}

/** synthesize an ellipse path (4 kappa cubics) */
function ellipsePath(cx: number, cy: number, rx: number, ry: number): string {
  const kx = rx * 0.5522847498, ky = ry * 0.5522847498;
  return (
    `M${xf(cx)} ${xf(cy - ry)}C${xf(cx + kx)} ${xf(cy - ry)} ${xf(cx + rx)} ${xf(cy - ky)} ${xf(cx + rx)} ${xf(cy)}` +
    `C${xf(cx + rx)} ${xf(cy + ky)} ${xf(cx + kx)} ${xf(cy + ry)} ${xf(cx)} ${xf(cy + ry)}` +
    `C${xf(cx - kx)} ${xf(cy + ry)} ${xf(cx - rx)} ${xf(cy + ky)} ${xf(cx - rx)} ${xf(cy)}` +
    `C${xf(cx - rx)} ${xf(cy - ky)} ${xf(cx - kx)} ${xf(cy - ry)} ${xf(cx)} ${xf(cy - ry)}Z`
  );
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

  type SlotBinding = {
    glyphs?: any[];
    fill?: string | undefined;
    hidden?: boolean;
    propText?: string;
    upgraded?: boolean;
    lastGuid?: string;
  };

  type Ctx = { dir: DirNode };

  function buildSlotMap(
    instance: RawChange,
    symId: string,
    opts?: { dir?: DirNode; inheritedAssigns?: AssignMap },
  ): Map<string, SlotBinding> {
    const map = new Map<string, SlotBinding>();
    const instW = instance.size?.x ?? Infinity;
    const instH = instance.size?.y ?? Infinity;
    const compW = fig.nodes.get(symId)?.size?.x ?? 0;
    const dir = opts?.dir ?? newDirNode();

    type Slot = { id: string; fs: number; fill: string | undefined; chars: string; parentId: string; nodeX: number; bottom: number; order: number; okey: string | null; textRef: string | null; visRefs: string[] };
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
            fill: paintInfo(k.fillPaints).fill,
            chars: k.textData?.characters ?? "",
            parentId,
            nodeX: k.transform?.m02 ?? 0,
            bottom: kTy + (k.size?.y ?? 0),
            order: order++,
            okey: okeyOf(k),
            textRef: nodeTextRef(k),
            visRefs: nodeVisibleRefs(k),
          });
        }
        collect(kid, depth + 1, kid, kTy);
      }
    })(symId, 0, symId, 0);

    const assigns: AssignMap = new Map([...(opts?.inheritedAssigns ?? []), ...dir.assigns]);
    const ownByGuid = new Map<string, any[]>();
    for (const d of instance.derivedSymbolData ?? []) {
      const glyphs = d.derivedTextData?.glyphs ?? [];
      if (!glyphs.length) continue;
      const path = guidPathOf(d);
      const last = path[path.length - 1];
      if (!last) continue;
      const prev = ownByGuid.get(last);
      if (!prev || glyphs.length > prev.length) ownByGuid.set(last, glyphs);
    }

    const boundBySlot = new Map<string, SlotBinding>();
    const locked = new Set<string>();
    // swapped-component runs pair by fontSize/order (their guids belong to the
    // swapped variant's library space)
    const swapRuns = [...dir.textByKey.values()].sort((a, b) => (a[0]?.fontSize ?? 14) - (b[0]?.fontSize ?? 14));
    if (swapRuns.length) {
      const free = slots.filter((sl) => sl.bottom <= instH + 0.5);
      for (const glyphs of swapRuns) {
        const fs = glyphs[0]?.fontSize ?? 14;
        const cand = free.find((sl) => !locked.has(sl.id) && sl.fs === fs);
        if (cand) {
          locked.add(cand.id);
          boundBySlot.set(cand.id, { glyphs, fill: cand.fill, upgraded: true });
        }
      }
    }
    // authoritative: slot overrideKey -> own derived run. For swapped
    // instances the baked derived data belongs to the current variant, so the
    // run is fresh even when the instance node itself is not.
    const swapped = symId !== guidStr(instance.symbolData?.symbolID);
    for (const sl of slots) {
      if (locked.has(sl.id) || sl.bottom > instH + 0.5) continue;
      const run = sl.okey ? ownByGuid.get(sl.okey) : undefined;
      if (run) {
        locked.add(sl.id);
        boundBySlot.set(sl.id, { glyphs: run, fill: sl.fill, upgraded: swapped });
      }
    }
    // variant-hidden: VISIBLE prop false, or slot past the instance bottom
    for (const sl of slots) {
      let propHidden = false;
      for (const ref of sl.visRefs) {
        const a = assigns.get(ref);
        if (a && a.bool === false) propHidden = true;
      }
      if (propHidden && boundBySlot.has(sl.id)) {
        boundBySlot.delete(sl.id);
        map.set(sl.id, { glyphs: [], fill: sl.fill, hidden: true });
      } else if (propHidden || sl.bottom > instH + 0.5) {
        if (!boundBySlot.has(sl.id)) map.set(sl.id, { glyphs: [], fill: sl.fill, hidden: true });
      }
    }
    // a stale "*" run lands mid-word; follow the preceding text run's width
    for (const sl of slots) {
      if (sl.chars !== "*" || !boundBySlot.has(sl.id)) continue;
      const prev = slots.filter((p) => p.parentId === sl.parentId && p.order < sl.order && p.chars !== "*").pop();
      const prevBound = prev ? boundBySlot.get(prev.id) : undefined;
      let prevEnd = 0;
      if (prev && prevBound && prevBound.glyphs.length) {
        for (const gg of prevBound.glyphs) prevEnd = Math.max(prevEnd, (gg.position?.x ?? 0) + (gg.fontSize ?? prev.fs) * 0.55);
      } else if (prev) {
        const pb = map.get(prev.id);
        prevEnd = prev.nodeX + (pb?.propText ?? prev.chars).length * prev.fs * 0.55;
      } else continue;
      const shifted = boundBySlot.get(sl.id)!.glyphs.map((gg) => ({ ...gg, position: { ...gg.position, x: prevEnd + prev.fs * 0.25 - sl.nodeX } }));
      boundBySlot.set(sl.id, { ...boundBySlot.get(sl.id)!, glyphs: shifted });
    }
    // prop-driven texts (TEXT_DATA assignments) carry the CURRENT content;
    // cached derived glyph runs can predate the edit (stale counts). When the
    // prop text length differs from the bound run, the prop text wins.
    for (const sl of slots) {
      const textRef = sl.textRef;
      if (!textRef) continue;
      const prop = assigns.get(textRef)?.text;
      if (!prop) continue;
      const bound = boundBySlot.get(sl.id);
      if (bound && (bound.upgraded || bound.glyphs.length === prop.length)) continue;
      // an instance that grew past its component re-centers its label
      const grownSwap = instW > compW + 2 ? instW : undefined;
      boundBySlot.set(sl.id, { fill: sl.fill, propText: prop, upgraded: !!bound, boundW: grownSwap });
    }
    for (const sl of slots) {
      if (map.has(sl.id)) continue;
      const textRef = sl.textRef;
      if (textRef && assigns.get(textRef)?.text && !boundBySlot.has(sl.id)) {
        map.set(sl.id, { fill: sl.fill, propText: assigns.get(textRef)!.text });
      }
    }
    for (const [id, v] of boundBySlot) map.set(id, v);
    return map;
  }

  // Stale-icon remediation: .fig snapshots bake icon-button contents from the
  // published library at snapshot time, so instances can show an outdated
  // glyph (circle-✕ instead of trash / plus / bare-✕). The real icon
  // components ship in the same file — index them by exact name.
  type IconKind = "Delete" | "Dismiss" | "Add";
  type IconHint = { kind?: IconKind; color?: string; listCtx?: boolean };
  let iconIndex: Partial<Record<IconKind, string>> | undefined;
  const iconIndexFor = (): Partial<Record<IconKind, string>> => {
    if (!iconIndex) {
      iconIndex = {};
      for (const [id, n] of fig.nodes) {
        if (n.type !== "SYMBOL" && n.type !== "COMPONENT") continue;
        if (n.name === "Delete" || n.name === "Dismiss" || n.name === "Add") {
          const key = n.name as IconKind;
          if (!iconIndex[key]) iconIndex[key] = id;
        }
      }
    }
    return iconIndex;
  };
  // render an icon component's vectors in a solid color, normalized to the
  // component's 24-unit box (optionally scaled to the host instance size)
  const emitIcon = (compId: string, color: string, tf: string, opacity: string, instW: number): string => {
    const comp = fig.nodes.get(compId);
    if (!comp) return "";
    const parts: string[] = [];
    const emit = (nid: string, depth: number): void => {
      const cn = fig.nodes.get(nid);
      if (!cn || cn.visible === false) return;
      if (cn.type === "VECTOR") {
        try {
          const paths = resolveVectorNodePaths(doc, cn as any);
          const t2 = cn.transform ?? { m02: 0, m12: 0 };
          const tf2 = ` transform="translate(${r(t2.m02 ?? 0)},${r(t2.m12 ?? 0)})"`;
          for (const p of paths.fill) {
            if (!p.svgPath) continue;
            parts.push(`<g${tf2}><path d="${p.svgPath}" fill="${color}"/></g>`);
          }
        } catch { /* undecodable vector — skip */ }
        return;
      }
      for (const k of fig.kidsOf.get(nid) ?? []) emit(k, depth + 1);
    };
    for (const k of fig.kidsOf.get(compId) ?? []) emit(k, 1);
    const compW = comp.size?.x ?? 24;
    const scale = instW > 0 && compW > 0 && instW !== 24 ? instW / compW : 1;
    const wrap = scale !== 1 ? `<g transform="scale(${r(scale)})">${parts.join("")}</g>` : parts.join("");
    return `<g${tf}${opacity}>${wrap}</g>`;
  };
  // contextual icon kind/color for stale Dismiss-Circle instances, derived
  // from the nearest icon-button variant component (matches Figma's library):
  // Danger→red trash, Tertiary→white bare ✕, Secondary-M→gray trash,
  // Secondary-S→gray plus, labeled Secondary button→plus in the label color
  const iconHintFor = (compId: string | undefined, nodeName: string | undefined, hint?: IconHint): IconHint | undefined => {
    const cname = (compId ? fig.nodes.get(compId)?.name : undefined) ?? nodeName;
    if (!cname) return undefined;
    if (/Type=Danger/.test(cname)) return { kind: "Delete", color: "#E83F4F", listCtx: hint?.listCtx };
    if (/Type=Tertiary/.test(cname)) return { kind: "Dismiss", color: "#FFFFFF", listCtx: hint?.listCtx };
    if (/Type=Secondary/.test(cname)) {
      // small secondary icon buttons are select-clear ✕ circles — correct baked
      if (/Size=S/.test(cname)) return hint?.listCtx ? { kind: "Add", color: "#6A7187", listCtx: true } : undefined;
      const sibText = (fig.kidsOf.get(compId ?? "") ?? [])
        .map((k) => fig.nodes.get(k))
        .find((k) => k?.type === "TEXT");
      if (sibText) return { kind: "Add", color: paintInfo(sibText.fillPaints).fill ?? "#6A7187", listCtx: hint?.listCtx };
      return { kind: hint?.listCtx ? "Add" : "Delete", color: "#6A7187", listCtx: hint?.listCtx };
    }
    if (/Add condition/i.test(cname)) return { kind: "Add", color: "#6A41C9" };
    return undefined;
  };

  /**
   * Minimal auto-layout for instances whose resolved component is a Figma
   * stack (stackMode set). The .fig bakes the component-subtree child
   * transforms from the library component, which go stale when an instance's
   * text grows (e.g. footer "Button" -> "Delete saved filters"). Re-lays-out
   * children from the component's own stack props:
   * - child width grows to fit its bound text run (text extent + padding)
   * - two-child stacks with a large baked gap are SPACE_BETWEEN
   *   (leading child pinned left, trailing child pinned right)
   * - counter axis centered
   * Only fires when something actually overflows or a 2-child stack is
   * space-between, so correctly-baked layouts stay untouched.
   */
  const applyStackLayout = (compId: string, instNode: any, ancDir?: DirNode) => {
    const comp = fig.nodes.get(compId);
    if (!comp?.stackMode) return;
    const horiz = comp.stackMode === "HORIZONTAL";
    const kids = fig.kidsOf.get(compId) ?? [];
    if (kids.length < 2) return;
    const spacing = typeof comp.stackSpacing === "number" ? comp.stackSpacing : 0;
    const padMain = horiz ? (comp.stackHorizontalPadding ?? 0) : (comp.stackVerticalPadding ?? 0);
    const W = instNode.size?.x ?? comp.size?.x ?? 0;
    const H = instNode.size?.y ?? comp.size?.y ?? 0;
    const main = horiz ? W : H;
    const extOf = (cn: any): number => {
      const merged = mergeDir(ancDir?.children.get(okeyOf(cn) ?? ""), buildDirectiveTree(cn));
      const symId2 = merged?.swapSym && fig.nodes.has(merged.swapSym) ? merged.swapSym : guidStr(cn.symbolData?.symbolID);
      if (!symId2) return 0;
      // measure with the instance's OWN derived runs only — ancestor-composed
      // runs may be positioned in a parent coordinate space
      const dirOwn = merged ? { ...merged, textByKey: new Map() } : undefined;
      const map2 = buildSlotMap(cn, symId2, { dir: dirOwn, inheritedAssigns: new Map([...(ancDir?.assigns ?? [])]) });
      let ext = 0;
      let propCap = Infinity;
      for (const b of map2.values()) {
        if (!b || b.hidden) continue;
        for (const gg of b.glyphs ?? []) ext = Math.max(ext, (gg.position?.x ?? 0) + (gg.fontSize ?? 16) * 0.62);
        if (b.propText) propCap = Math.min(propCap, b.propText.length * 7 + 32);
      }
      // glyph runs inherited from an ancestor scope can carry that scope's
      // positions; the prop text length is a safe upper bound on the true
      // button width
      if (ext > 0) return Math.min(ext, propCap);
      return isFinite(propCap) ? propCap : 0;
    };
    const estimateW = (fid: string): number => {
      const f = fig.nodes.get(fid);
      if (!f?.stackMode) return f?.size?.x ?? 0;
      const kids2 = fig.kidsOf.get(fid) ?? [];
      if (!kids2.length) return f.size?.x ?? 0;
      let sum = 0;
      let n2 = 0;
      for (const k2 of kids2) {
        const cn2 = fig.nodes.get(k2);
        if (!cn2 || cn2.visible === false) continue;
        n2++;
        let w2 = cn2.size?.x ?? 0;
        if (cn2.type === "INSTANCE") w2 = Math.max(w2, Math.round(extOf(cn2)) + 16);
        else if (cn2.stackMode) w2 = estimateW(k2);
        sum += w2;
      }
      return Math.round(sum + (f.stackSpacing ?? 0) * Math.max(0, n2 - 1) + 2 * (f.stackHorizontalPadding ?? 0));
    };
    const items: { cn: any; w: number; h: number; bakedW: number }[] = [];
    for (const kid of kids) {
      const cn = fig.nodes.get(kid);
      if (!cn || cn.visible === false) continue;
      const bakedW = cn.size?.x ?? 24;
      let w = bakedW;
      if (cn.type === "INSTANCE") {
        const ext = extOf(cn);
        if (ext > 0) w = Math.max(bakedW, Math.round(ext) + 16);
      } else if (cn.stackMode) {
        w = Math.max(bakedW, estimateW(kid));
      } else {
        // plain frame: simulate its children flowing with their baked gaps
        const kids2 = (fig.kidsOf.get(kid) ?? []).map((k2) => fig.nodes.get(k2)).filter(Boolean) as any[];
        if (kids2.length) {
          const sorted = [...kids2].sort((a, b) => (a.transform?.m02 ?? 0) - (b.transform?.m02 ?? 0));
          let cur = sorted[0].transform?.m02 ?? 0;
          let end = cur;
          for (const c2 of sorted) {
            const bw2 = c2.size?.x ?? 0;
            let ew2 = bw2;
            if (c2.type === "INSTANCE") ew2 = Math.max(bw2, Math.round(extOf(c2)) + 16);
            else if (c2.stackMode) ew2 = Math.max(bw2, estimateW(c2.guid ? guidStr(c2.guid) : ""));
            if (c2 !== sorted[0]) cur = end + ((c2.transform?.m02 ?? 0) - ((sorted[sorted.indexOf(c2) - 1]?.transform?.m02 ?? 0) + (sorted[sorted.indexOf(c2) - 1]?.size?.x ?? 0)) + (sorted[sorted.indexOf(c2) - 1] === c2 ? 0 : 0));
            cur = c2 === sorted[0] ? cur : end + Math.max(0, (c2.transform?.m02 ?? 0) - ((sorted[sorted.indexOf(c2) - 1]?.transform?.m02 ?? 0) + (sorted[sorted.indexOf(c2) - 1]?.size?.x ?? 0)));
            end = cur + ew2;
          }
          w = Math.max(bakedW, Math.round(end) + (cn.stackPaddingRight ?? 0));
        }
      }
      items.push({ cn, w, h: cn.size?.y ?? 24, bakedW });
    }
    if (items.length < 2) return;
    const total = items.reduce((a, it) => a + it.w, 0) + spacing * (items.length - 1);
    const t1 = items[1].cn.transform;
    const bakedGap = t1 ? (horiz ? t1.m02 : t1.m12) - (horiz ? items[0].cn.transform?.m02 ?? 0 : items[0].cn.transform?.m12 ?? 0) - items[0].bakedW : 0;
    const between = (total < main - 2 * padMain - 12 && bakedGap > spacing * 3 + 8)
      // "Leading content … Trailing content=N icon button" headers pin the
      // trailing button to the right edge regardless of baked positions
      || (horiz && items.length === 2 && /Trailing content=.*icon button/i.test(comp?.name ?? ""));
    const overflow = items.some((it) => it.w > it.bakedW + 2);
    if (!(overflow || (between && items.length === 2))) return;
    let p = padMain;
    items.forEach((it, i) => {
      const t = it.cn.transform;
      if (!t) return;
      const last = i === items.length - 1;
      const pos = between && (i === 0 || last)
        ? last
          ? main - padMain - it.w
          : padMain
        : p;
      const cross = horiz ? (H - it.h) / 2 : (W - it.w) / 2;
      it.cn.transform = horiz ? { ...t, m02: pos, m12: cross } : { ...t, m12: pos, m02: cross };
      if (it.w !== it.bakedW && it.cn.size) it.cn.size = { ...it.cn.size, x: it.w };
      p = pos + it.w + spacing;
    });
  };

  const walk = (
    id: string,
    depth: number,
    noText: boolean,
    overrideMap?: Map<string, SlotBinding>,
    dir?: DirNode,
    parentW?: number,
    hint?: IconHint,
    mat: Mat = M_ID,
  ): string => {
    if (depth > maxDepth || nodeCount >= maxNodes) return "";
    const n = fig.nodes.get(id);
    if (!n || n.visible === false) return "";
    nodeCount++;

    const opacity = typeof n.opacity === "number" && n.opacity < 1 ? ` opacity="${r(n.opacity)}"` : "";

    const { fill, fillOpacity, imageHash, stops } = paintInfo(n.fillPaints);
    const fillHere = fill && fillOpacity > 0.001 ? fill : undefined;
    let w = n.size ? Math.round(n.size.x) : 0;
    let h = n.size ? Math.round(n.size.y) : 0;
    const fo = fill && fillOpacity < 0.999 ? ` fill-opacity="${r(fillOpacity)}"` : "";

    /** exact fill geometry of this node transformed to absolute space */
    const geomAbs = (): string | null => {
      try {
        const paths = resolveVectorNodePaths(doc, n as any);
        const parts: string[] = [];
        for (const p of paths.fill) {
          if (!p.svgPath) continue;
          parts.push(xfPath(p.svgPath, mat));
        }
        if (parts.length) return parts.join("");
      } catch { /* fall through */ }
      if (n.type === "RECTANGLE" || n.type === "ROUNDED_RECTANGLE" || n.type === "FRAME" || n.type === "INSTANCE") {
        const rad = n.cornerRadius ?? 0;
        if (rad > 0) return roundedRectPath(mat[4], mat[5], w, h, rad);
        return null;
      }
      return null;
    };

    switch (n.type) {
      case "TEXT": {
        const bound = overrideMap?.get(id);
        if (bound?.hidden) return "";
        const fillC = bound?.fill ?? fill ?? "#1a152b";
        // a resolved binding owns the text: use ONLY its glyph runs (a
        // prop-text binding without runs falls through to the <text> branch);
        // unbound nodes fall back to their own cached derived runs
        const glyphs = bound
          ? (bound.glyphs?.length ? bound.glyphs : undefined)
          : (noText ? undefined : n.derivedTextData?.glyphs);
        if (glyphs && glyphs.length) {
          const lines = new Map<number, string[]>();
          const fs0 = n.fontSize ?? 14;
          for (const g of glyphs) {
            const gx = g.position?.x ?? 0;
            const gy = g.position?.y ?? 0;
            const fs = g.fontSize ?? fs0;
            const d = glyphPathD(doc, g.commandsBlob);
            if (!d) continue;
            const gm = mulM(mat, [fs, 0, 0, -fs, gx, gy]);
            const dd = xfPath(d, gm);
            const key = Math.round(gy * 10);
            if (!lines.has(key)) lines.set(key, []);
            lines.get(key)!.push(dd);
          }
          let merged = "";
          for (const parts of [...lines.values()].sort((a, b) => a[0].localeCompare(b[0]))) merged += parts.join("");
          if (merged) return `<path d="${merged}" fill="${fillC}"${opacity}/>`;
        }
        if (noText) return "";
        const propText = bound?.propText;
        const fs = n.fontSize ?? 14;
        const family = n.fontName?.family ?? "Inter";
        const align = n.textAlignHorizontal === "CENTER" ? ' text-anchor="middle"' : n.textAlignHorizontal === "RIGHT" ? ' text-anchor="end"' : "";
        const anchorX = bound?.boundW && n.textAlignHorizontal === "CENTER"
          ? Math.max(0, bound.boundW / 2 - (n.transform?.m02 ?? 0))
          : n.textAlignHorizontal === "CENTER" ? w / 2 : n.textAlignHorizontal === "RIGHT" ? w : 0;
        const chars = propText ?? n.textData?.characters ?? "";
        if (!chars) return "";
        const t = n.transform ?? { m00: 1, m01: 0, m02: 0, m10: 0, m11: 1, m12: 0 };
        const ax = mat[0] * (t.m02 ?? 0) + mat[2] * (t.m12 ?? 0) + mat[4];
        const ay = mat[1] * (t.m02 ?? 0) + mat[3] * (t.m12 ?? 0) + mat[5];
        return `<text x="${r(ax + anchorX)}" y="${r(ay + fs * 0.8)}" font-family="${esc(family)}, sans-serif" font-size="${r(fs)}" fill="${fillC}"${align}${opacity}>${esc(chars)}</text>`;
      }
      case "FRAME":
      case "SECTION":
      case "COMPONENT":
      case "SYMBOL":
      case "GROUP":
      case "INSTANCE": {
        let childrenSvg = "";
        let childOverrideMap: Map<string, SlotBinding> | undefined;
        let swapApplied: { newSym: string } | undefined;
        let childDir: DirNode | undefined;
        if (n.type === "INSTANCE") {
          const okey = okeyOf(n);
          const ancNode = dir?.children.get(okey ?? "");
          const ownTree = buildDirectiveTree(n);
          const node = mergeDir(ancNode, ownTree);
          let symId = guidStr(n.symbolData?.symbolID);
          if (node.swapSym && fig.nodes.has(node.swapSym)) {
            swapApplied = { newSym: node.swapSym };
            symId = node.swapSym;
          }
          if (symId) {
            childOverrideMap = buildSlotMap(n, symId, { dir: node, inheritedAssigns: new Map([...(dir?.assigns ?? [])]) });
            if (node) childDir = node;
            applyStackLayout(symId, n, node);
          }
          // stale icon remap: outdated circle-✕ instances render the real
          // glyph component (trash / plus / bare ✕) declared by the context
          const resolvedName0 = symId ? fig.nodes.get(symId)?.name ?? "" : "";
          if ((resolvedName0 === "Dismiss Circle" || resolvedName0 === "Dismiss") && hint?.kind) {
            const mapped = iconIndexFor()[hint.kind];
            if (mapped) {
              const color = hint.color ?? "#6A7187";
              const parts: string[] = [];
              const emitV = (nid: string): void => {
                const cn = fig.nodes.get(nid);
                if (!cn || cn.visible === false) return;
                if (cn.type === "VECTOR") {
                  try {
                    const paths = resolveVectorNodePaths(doc, cn as any);
                    const vm = mulM(mat, nodeMat(cn));
                    for (const p of paths.fill) {
                      if (!p.svgPath) continue;
                      parts.push(`<path d="${xfPath(p.svgPath, vm)}" fill="${color}"/>`);
                    }
                  } catch { /* skip */ }
                  return;
                }
                for (const k of fig.kidsOf.get(nid) ?? []) emitV(k);
              };
              for (const k of fig.kidsOf.get(mapped) ?? []) emitV(k);
              if (parts.length) return parts.join("");
            }
          }
          // segmented radios ("Amount=N"): reflow option containers into the
          // instance width and re-center their texts
          const radioComp = symId ? fig.nodes.get(symId) : undefined;
          const radioMatch = /Amount=(\d+)/.exec(radioComp?.name ?? "");
          if (radioMatch && w > 0 && (radioComp?.size?.x ?? 0) > w + 2) {
            const nOpt = Math.max(1, parseInt(radioMatch[1], 10));
            const newOptW = w / nOpt;
            let idx = 0;
            for (const k of fig.kidsOf.get(symId) ?? []) {
              const kn = fig.nodes.get(k);
              if (!kn || kn.visible === false) continue;
              if (kn.transform) kn.transform = { ...kn.transform, m02: idx * newOptW };
              if (kn.size) kn.size = { ...kn.size, x: newOptW };
              const recenter = (nid: string): void => {
                for (const k2 of fig.kidsOf.get(nid) ?? []) {
                  const k2n = fig.nodes.get(k2);
                  if (!k2n) continue;
                  if (k2n.type === "TEXT" && k2n.size) {
                    k2n.transform = { ...k2n.transform, m02: (newOptW - k2n.size.x) / 2 };
                  }
                  recenter(k2);
                }
              };
              recenter(k);
              idx++;
            }
          }
          // stretched selects: grow the inner "input" pill, right-pin its icon
          const compNode0 = symId ? fig.nodes.get(symId) : undefined;
          const compW0 = compNode0?.size?.x ?? 0;
          if (compNode0 && w > compW0 + 2 && /input\.(select|textfield)|Filled\?=|Clearable/.test(compNode0.name ?? "")) {
            for (const k of fig.kidsOf.get(symId) ?? []) {
              const kn = fig.nodes.get(k);
              if (kn?.type === "FRAME" && kn.name === "input" && kn.size) {
                kn.size = { ...kn.size, x: w };
                for (const k2 of fig.kidsOf.get(k) ?? []) {
                  const k2n = fig.nodes.get(k2);
                  if (k2n?.type === "INSTANCE" && k2n.transform) {
                    const iw = k2n.size?.x ?? 24;
                    k2n.transform = { ...k2n.transform, m02: w - iw - 12 };
                  }
                }
              }
            }
          }
        } else if (n.stackMode && dir) {
          applyStackLayout(id, n, dir);
        }
        if (childOverrideMap && overrideMap && overrideMap.size) {
          const merged = new Map(childOverrideMap);
          for (const [k2, v2] of overrideMap) merged.set(k2, v2);
          childOverrideMap = merged;
        }

        // contextual icon hints for stale icon instances in this subtree
        let childHint = hint;
        {
          const resId = n.type === "INSTANCE" ? (swapApplied?.newSym ?? symId0Of(n)) ?? undefined : undefined;
          const cname = resId ? fig.nodes.get(resId)?.name : n.name;
          const nameHere = `${n.name ?? ""} ${cname ?? ""}`;
          const listCtx = !!hint?.listCtx || /fieldselection|Available fields/i.test(nameHere);
          const own = iconHintFor(resId, n.type === "INSTANCE" ? undefined : n.name, hint);
          childHint = own ? { ...own, listCtx } : listCtx ? { ...(hint ?? {}), listCtx: true } : hint;
        }

        if (depth < maxDepth && nodeCount < maxNodes) {
          let childIds = fig.kidsOf.get(id) ?? [];
          if (n.type === "INSTANCE" && childIds.length === 0) {
            const symId = swapApplied?.newSym ?? symId0Of(n);
            if (symId) childIds = fig.kidsOf.get(symId) ?? [];
          }
          const kidDir = n.type === "INSTANCE" ? (childDir ?? dir) : dir;
          for (const kid of childIds) {
            const kn = fig.nodes.get(kid);
            childrenSvg += walk(kid, depth + 1, false, childOverrideMap ?? overrideMap, kidDir, w, childHint, mulM(mat, nodeMat(kn ?? {})));
          }
        }

        // variant content wider than the instance compresses into it
        // (segmented radios reflow per-option instead — see above)
        if (swapApplied) {
          const sc = fig.nodes.get(swapApplied.newSym);
          const cw = sc?.size?.x ?? 0;
          if (cw > w + 2 && cw > 0 && !/Amount=\d/.test(sc?.name ?? "")) {
            childrenSvg = `<g transform="scale(${r(w / cw)},1)">${childrenSvg}</g>`;
          }
        }

        // node background (absolute geometry)
        let shapeSvg = "";
        const geomD = geomAbs();
        const hasRad = (n.cornerRadius ?? 0) > 0;
        let paint = fill && n.type !== "GROUP" ? fill : undefined;
        if (swapApplied) {
          const comp = fig.nodes.get(swapApplied.newSym);
          const ci = comp ? paintInfo(comp.fillPaints) : null;
          if (ci?.fill) paint = ci.fill;
        }
        const fo2 = fill && fillOpacity < 0.999 ? ` fill-opacity="${r(fillOpacity)}"` : "";
        if (paint || strokeText(n)) {
          if (geomD) {
            shapeSvg = `<path d="${geomD}" fill="${paint ?? "none"}"${fo2}${strokeText(n)}${opacity}/>`;
          } else {
            shapeSvg = `<rect x="${xf(mat[4])}" y="${xf(mat[5])}" width="${w}" height="${h}" fill="${paint ?? "none"}"${fo2}${opacity}/>`;
          }
        }

        let img = "";
        if (imageHash && w > 0 && h > 0) {
          const bytes = images.get(imageHash);
          if (bytes) {
            const uri = `data:${sniffImageMime(bytes)};base64,${Buffer.from(bytes).toString("base64")}`;
            img = `<image x="${xf(mat[4])}" y="${xf(mat[5])}" width="${w}" height="${h}" href="${uri}" preserveAspectRatio="xMidYMid slice"/>`;
          }
        }

        // clip children to the instance/frame box
        const clips = n.type === "INSTANCE" || (n.type === "FRAME" && n.clipsContent === true);
        let out = `${shapeSvg}${img}${childrenSvg}`;
        if (clips && childrenSvg && w > 0 && h > 0) {
          const cid = `clip${clipSeq + 1}_${frameTag}`;
          clipSeq++;
          const clipGeom = roundedRectPath(mat[4], mat[5], w, h, hasRad ? (n.cornerRadius ?? 0) : 0);
          defs.push(`<clipPath id="${cid}"><path d="${clipGeom}"/></clipPath>`);
          out = `<g clip-path="url(#${cid})">${out}</g>`;
        }
        return out;
      }
      case "RECTANGLE":
      case "ROUNDED_RECTANGLE": {
        const rad = n.cornerRadius ?? 0;
        const paint = fill || "none";
        const fo = fill && fillOpacity < 0.999 ? ` fill-opacity="${r(fillOpacity)}"` : "";
        if (rad > 0) {
          const d = roundedRectPath(0, 0, w, h, rad);
          return `<path d="${xfPath(d, mat)}" fill="${paint}"${fo}${strokeText(n)}${opacity}/>`;
        }
        return `<rect x="${xf(mat[4])}" y="${xf(mat[5])}" width="${w}" height="${h}" fill="${paint}"${fo}${strokeText(n)}${opacity}/>`;
      }
      case "ELLIPSE": {
        const paint = fill || "none";
        const fo = fill && fillOpacity < 0.999 ? ` fill-opacity="${r(fillOpacity)}"` : "";
        const d = ellipsePath(w / 2, h / 2, w / 2, h / 2);
        return `<path d="${xfPath(d, mat)}" fill="${paint}"${fo}${strokeText(n)}${opacity}/>`;
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
            g.push(`<path d="${xfPath(p.svgPath, mat)}" fill="${(pf && hexFill(pf)) || fill || "none"}"${opacity}/>`);
          }
          for (const p of paths.stroke) {
            if (!p.svgPath) continue;
            g.push(`<path d="${xfPath(p.svgPath, mat)}" fill="none" stroke="${fill ?? "#000"}" stroke-width="${r(n.strokeWeight ?? 1)}"${opacity}/>`);
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

  function symId0Of(n: RawChange): string | null {
    return guidStr(n.symbolData?.symbolID);
  }

  const frameTag = rootId.replace(/[^0-9A-Za-z]/g, "_");
  defs.push(`<clipPath id="clip0_${frameTag}"><rect width="${W}" height="${H}"/></clipPath>`);
  const inner = walk(rootId, 0, false, undefined, undefined, undefined, undefined, M_ID);

  const svg =
    `<svg xmlns="http://www.w3.org/2000/svg" xmlns:xlink="http://www.w3.org/1999/xlink" width="${W}" height="${H}" viewBox="0 0 ${W} ${H}" fill="none">\n` +
    `<defs>${defs.join("")}</defs>\n` +
    `<g clip-path="url(#clip0_${frameTag})">\n` +
    `<rect width="${W}" height="${H}" fill="#ffffff"/>\n` +
    inner +
    `\n</g>\n</svg>\n`;

  return { svg, width: W, height: H, warnings, nodeCount };
}

type RawChange = Record<string, any>;
