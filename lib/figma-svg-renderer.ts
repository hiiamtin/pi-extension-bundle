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
  /** @font-face CSS injected into <defs> so <text> runs render with the
   * document's real fonts (e.g. base64-embedded SCBX Looped woff2) */
  fontCSS?: string;
}

export interface RenderResult {
  svg: string;
  width: number;
  height: number;
  warnings: string[];
  nodeCount: number;
  /** font-family names referenced by emitted <text> runs (for @font-face embedding) */
  fontFamilies: string[];
}

function r(n: number): number {
  return Math.round(n * 100) / 100;
}

/** SCBX-Looped-ish width estimate for a string at fontSize fs — used to
 * size prop-text buttons and to compress fallback-font <text> runs
 * (textLength) toward the real font's metrics */
function textWidthEst(s: string, fs: number): number {
  let units = 0;
  for (const ch of s) {
    if ("iljtfr.,;:!|I()[]{}'`".includes(ch)) units += 0.5;
    else if ("mwMW@&".includes(ch)) units += 1.6;
    else if (ch === " ") units += 0.35;
    else if (ch >= "A" && ch <= "Z") units += 1.15;
    else if (ch >= "0" && ch <= "9") units += 1.0;
    else units += 1.0;
  }
  return units * fs * 0.58;
}

function esc(s: string): string {
  return String(s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}

function hexFill(paint: any): string | null {
  if (!paint?.color || typeof paint.color !== "object") return undefined;
  // Figma's serializer emits pure white as the keyword "white"
  if (Number(paint.color.r) === 1 && Number(paint.color.g) === 1 && Number(paint.color.b) === 1) return "white";
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

type AssignVal = { bool?: boolean; text?: string; symbol?: string };
type AssignMap = Map<string, AssignVal>;
type DirNode = { swapSym?: string; assigns: AssignMap; textByKey: Map<string, any[]>; textChars: Map<string, string>; compChars: Map<string, string>; children: Map<string, DirNode> };
type SlotBinding = {
  glyphs?: any[];
  fill?: string | undefined;
  hidden?: boolean;
  propText?: string;
  textChars?: string;
  upgraded?: boolean;
  stale?: boolean;
  boundW?: number;
};

const newDirNode = (): DirNode => ({ assigns: new Map(), textByKey: new Map(), textChars: new Map(), compChars: new Map(), children: new Map() });

/** flatten componentPropAssignments into defId -> {bool?, text?} */
function assignMap(list: any[] | undefined): AssignMap {
  const m: AssignMap = new Map();
  for (const a of list ?? []) {
    const defId = a?.defID ? guidStr(a.defID) : null;
    if (!defId) continue;
    const bool = a?.varValue?.value?.boolValue ?? a?.value?.boolValue;
    const text = a?.value?.textValue?.characters ?? a?.varValue?.value?.textDataValue?.characters;
    // instance swaps travel as component properties too (symbolIdValue),
    // e.g. an Icon Button's icon slot assigned to "Add"/"Alert"
    const sym = a?.varValue?.value?.symbolIdValue?.guid ?? a?.value?.symbolIdValue?.guid;
    m.set(defId, {
      bool: typeof bool === "boolean" ? bool : undefined,
      text: typeof text === "string" ? text : undefined,
      symbol: sym ? guidStr(sym) ?? undefined : undefined,
    });
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

/** component-property instance swap: an icon slot assigned to another symbol */
function nodeSymbolRef(n: RawChange): string | null {
  const r = (n.componentPropRefs ?? []).find((r: any) => r?.componentPropNodeField === "OVERRIDDEN_SYMBOL_ID");
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
  // the INSTANCE's own componentPropAssignments (not inside symbolOverrides)
  // carry the live property values — including icon swaps (symbolIdValue)
  for (const [k, v] of assignMap(instance.componentPropAssignments)) root.assigns.set(k, v);
  const charsByPrefix = new Map<string, string>();
  const compCharsBySwap = new Map<string, string>();
  for (const o of instance.symbolData?.symbolOverrides ?? []) {
    // a swap whose override carries text (assignment or textData) means every
    // slot of the swapped component renders that string
    let swapText: string | undefined;
    for (const a of o.componentPropAssignments ?? []) {
      const t = a?.value?.textValue?.characters ?? a?.varValue?.value?.textDataValue?.characters;
      if (typeof t === "string" && t.trim()) swapText = t;
    }
    const chars = o.textData?.characters ?? swapText;
    if (typeof chars !== "string" || !chars.trim()) continue;
    const path = guidPathOf(o);
    if (!path.length) continue;
    charsByPrefix.set(path.join(">"), chars);
    const sw = guidStr(o.overriddenSymbolID);
    if (sw) compCharsBySwap.set(sw, chars);
    const node = ensure(path);
    for (const k of path) node.textChars.set(k, chars);
  }
  // swaps carrying override text: every slot of that swapped component
  // renders this text (its own okey belongs to another session namespace)
  for (const [sw, chars] of compCharsBySwap) root.compChars.set(sw, chars);

  // the TEXT slot inside the swapped variant has its OWN overrideKey — link
  // it through the derived-run paths that extend this override chain
  if (charsByPrefix.size) {
    for (const d of instance.derivedSymbolData ?? []) {
      const gl = d.derivedTextData?.glyphs ?? [];
      if (!gl.length) continue;
      const path = guidPathOf(d);
      if (path.length < 2) continue;
      for (let cut = path.length - 1; cut >= 1; cut--) {
        const prefix = path.slice(0, cut).join(">");
        const chars = charsByPrefix.get(prefix);
        if (chars !== undefined) {
          const node = ensure(path);
          const leaf = path[path.length - 1];
          if (!node.textChars.has(leaf)) node.textChars.set(leaf, chars);
          break;
        }
      }
    }
  }
  for (const d of instance.derivedSymbolData ?? []) {
    const glyphs = d.derivedTextData?.glyphs ?? [];
    if (!glyphs.length) continue;
    const path = guidPathOf(d);
    if (!path.length) continue;
    // store the run under EVERY ancestor key of the chain (not just the
    // last): a slot anywhere along the chain binds by its own overrideKey,
    // and the walk may consume levels from either end
    const node = ensure(path);
    for (const k of path) {
      const prev = node.textByKey.get(k);
      if (!prev || glyphs.length > prev.length) node.textByKey.set(k, glyphs);
    }
  }
  return root;
}

/** merge ancestor directive over own tree: ancestor wins per key, deeper
 * children merge recursively; text runs keep the LONGER (more composed) */
function mergeDir(anc: DirNode | undefined, own: DirNode): DirNode {
  if (!anc) return own;
  // ancestor text runs must SURVIVE the merge: the walk drops one tree level
  // per nesting, and a run keyed at the ancestor level (e.g. the card title)
  // addresses a slot inside the merged subtree by its overrideKey.
  // The ANCESTOR run wins when both exist: instance-level derived data is
  // rendered from the live instance (e.g. "Lead name"), while the deeper
  // component-baked run can be the stale library default ("Field name").
  const textByKey = new Map(own.textByKey);
  for (const [gk, gv] of anc.textByKey) {
    const prev = textByKey.get(gk);
    if (!prev || gv.length > prev.length) textByKey.set(gk, gv);
  }
  const textChars = new Map(own.textChars);
  for (const [gk, gv] of anc.textChars) if (!textChars.has(gk)) textChars.set(gk, gv);
  const compChars = new Map(own.compChars);
  for (const [gk, gv] of anc.compChars) if (!compChars.has(gk)) compChars.set(gk, gv);
  const out: DirNode = { swapSym: anc.swapSym ?? own.swapSym, assigns: new Map([...own.assigns, ...anc.assigns]), textByKey, textChars, compChars, children: new Map() };
  const keys = new Set([...own.children.keys(), ...anc.children.keys()]);
  for (const k of keys) {
    const o = own.children.get(k);
    const a = anc.children.get(k);
    if (o && a) {
      // ANCESTOR (instance-level) runs win over the deeper component-baked
      // ones — the instance derived data reflects the live document text,
      // while the deeper run can be the stale library default
      const textByKey = new Map(a.textByKey);
      for (const [gk, gv] of o.textByKey) {
        if (!textByKey.has(gk)) textByKey.set(gk, gv);
      }
      const textChars = new Map(o.textChars);
      for (const [gk, gv] of a.textChars) if (!textChars.has(gk)) textChars.set(gk, gv);
      const compChars = new Map(o.compChars);
      for (const [gk, gv] of a.compChars) if (!compChars.has(gk)) compChars.set(gk, gv);
      out.children.set(k, { swapSym: a.swapSym ?? o.swapSym, assigns: new Map([...o.assigns, ...a.assigns]), textByKey, textChars, compChars, children: mergeDirChildren(a.children, o.children) });
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
      // ANCESTOR (instance-level) runs win over the deeper component-baked
      // ones — the instance derived data reflects the live document text,
      // while the deeper run can be the stale library default
      const textByKey = new Map(a.textByKey);
      for (const [gk, gv] of o.textByKey) {
        if (!textByKey.has(gk)) textByKey.set(gk, gv);
      }
      out.set(k, { swapSym: a.swapSym ?? o.swapSym, assigns: new Map([...o.assigns, ...a.assigns]), textByKey, textChars: a.textChars, children: mergeDirChildren(a.children, o.children) });
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
const swInset = (n: any): number => {
  const sw = n?.strokeWeight;
  return typeof sw === "number" ? sw : 1;
};
/** Figma stores per-corner radii as 4 scalar fields; cornerRadius is often
 * absent in .fig exports. Falls back to the resolved component's radius so
 * instance pills keep their library rounding. */
const radiusOf = (n: any, compNode?: any): number => {
  const tl = n?.rectangleTopLeftCornerRadius;
  const tr = n?.rectangleTopRightCornerRadius;
  const bl = n?.rectangleBottomLeftCornerRadius;
  const br = n?.rectangleBottomRightCornerRadius;
  if (tl !== undefined || tr !== undefined || bl !== undefined || br !== undefined) {
    return Math.min(tl ?? 0, tr ?? 0, bl ?? 0, br ?? 0) || 0;
  }
  if (n?.cornerRadius !== undefined) return n.cornerRadius ?? 0;
  const c = compNode ?? n;
  const ctl = c?.rectangleTopLeftCornerRadius;
  if (ctl !== undefined) return Math.min(ctl ?? 0, c?.rectangleTopRightCornerRadius ?? 0, c?.rectangleBottomLeftCornerRadius ?? 0, c?.rectangleBottomRightCornerRadius ?? 0) || 0;
  return c?.cornerRadius ?? 0;
};

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
      // "M" whose point matches the previous point is a degenerate glyph
      // contour start (e.g. the L-stem of "F"): emit "L" — a second "M"
      // would RESET the current point tracking and truncate the glyph
      const isDegenerate = !isNaN(px) && Math.abs(X - px) < 5e-4 && Math.abs(Y - py) < 5e-4;
      seg = isDegenerate || (cmd === "L" && !isNaN(px) && Math.abs(Y - py) < 5e-4)
        ? `L${xf(X)} ${xf(Y)}`
        : `${cmd}${xf(X)} ${xf(Y)}`;
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
  const k = rr * 0.5522847498;
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
  const fontFamilies = new Set<string>();
  let nodeCount = 0;
  let clipSeq = 0;
  let gradSeq = 0;
  let shadowSeq = 0;
  const defs: string[] = [];
  const images = doc.images as Map<string, Uint8Array>;

  if (opts?.fontCSS) defs.push(`<style>${opts.fontCSS}</style>`);

  const root = fig.nodes.get(rootId);
  if (!root) return null;
  const size = root.size ?? { x: 100, y: 100 };
  const W = Math.max(1, Math.round(size.x));
  const H = Math.max(1, Math.round(size.y));

  // pristine size/transform of every node — component subtrees are shared
  // between sibling instances, so any layout mutation made while rendering
  // one instance must be rolled back before the next one walks the same
  // component (else row 3 inherits row 2's re-flowed positions)
  const pristine = new Map<string, { size: any; transform: any }>();
  for (const [id, n] of fig.nodes) pristine.set(id, { size: n.size, transform: n.transform });
  const restoreSubtree = (rootId: string): void => {
    const stack = [rootId];
    while (stack.length) {
      const id = stack.pop()!;
      const p = pristine.get(id);
      const n = fig.nodes.get(id);
      if (p && n) {
        n.size = p.size;
        n.transform = p.transform;
      }
      for (const k of fig.kidsOf.get(id) ?? []) stack.push(k);
    }
  };

  const strokeText = (n: RawChange, compNode?: any): string => {
    const src = Array.isArray(n.strokePaints) && n.strokePaints.length ? n : compNode;
    const sp = Array.isArray(src?.strokePaints)
      ? src.strokePaints.find((p: any) => p?.visible !== false && p?.type === "SOLID")
      : null;
    const s = sp ? hexFill(sp) : null;
    const w = src?.strokeWeight ?? 0;
    return s && w > 0 ? ` stroke="${s}" stroke-width="${r(w)}"` : "";
  };

  /** first visible DROP_SHADOW of a node (or of its resolved component) */
  const effectShadow = (n: RawChange, comp?: any): any => {
    const eff = Array.isArray(n.effects) && n.effects.length ? n.effects : comp?.effects;
    if (!Array.isArray(eff)) return null;
    return eff.find((e: any) => e && e.visible !== false && e.type === "DROP_SHADOW") ?? null;
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

    type Slot = { id: string; fs: number; fill: string | undefined; chars: string; parentId: string; nodeX: number; bottom: number; order: number; okey: string | null; ancKey: string | null; textRef: string | null; visRefs: string[] };
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
            ancKey: null,
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
    const ancText = new Map<string, { gv: any[]; depth: number }>();
    const ancChars = new Map<string, string>();
    // ancestor override chains address text runs as
    // dir.children[slotChain].children[...].textByKey[slotOkey]. Flatten the
    // ancestor tree's textByKey so slots can bind by their own overrideKey —
    // an outer swap's run is fresher than the component-baked one.
    {
      const collectText = (dn?: DirNode, depth = 0): void => {
        if (!dn) return;
        for (const [gk, gv] of dn.textByKey) {
          // SHALLOWEST occurrence wins: the instance-level run (e.g. "Lead
          // name") sits nearer the root than the component-baked default
          // ("Field name"); keep-longer would pick the stale default
          const prev = ancText.get(gk);
          if (!prev || depth < prev.depth) ancText.set(gk, { gv, depth });
        }
        for (const [gk, gv] of dn.textChars) if (!ancChars.has(gk)) ancChars.set(gk, gv);
        for (const c of dn.children.values()) collectText(c, depth + 1);
      };
      collectText(dir);
      if (ancText.size) {
        for (const sl of slots) {
          if (!sl.okey || locked.has(sl.id)) continue;
          const hit = ancText.get(sl.okey);
          const run = hit?.gv;
          if (run?.length) {
            locked.add(sl.id);
            boundBySlot.set(sl.id, { glyphs: run, fill: sl.fill, upgraded: true, stale: true });
          }
        }
      }
    }
    // attach override textChars to bound slots — width calibration reads it
    // (must run AFTER binding: extOf deliberately blanks textByKey)
    if (ancChars.size) {
      for (const sl of slots) {
        const chars = ancChars.get(sl.okey ?? "");
        if (!chars) continue;
        const cur = boundBySlot.get(sl.id);
        if (cur) {
          if (!cur.textChars) boundBySlot.set(sl.id, { ...cur, textChars: chars });
        } else {
          // no derived run at all — bind as live text (embedded font)
          boundBySlot.set(sl.id, { glyphs: [], fill: sl.fill, textChars: chars });
        }
      }
    }

    // swap-carried override text: every slot of the swapped component shows
    // this string (slot okeys live in another session namespace)
    {
      const cc = (dir as any)?.compChars as Map<string, string> | undefined;
      const chars = cc?.get(symId);
      if (chars) {
        for (const sl of slots) {
          const cur = boundBySlot.get(sl.id);
          if (cur) {
            if (!cur.textChars) boundBySlot.set(sl.id, { ...cur, textChars: chars });
          } else {
            boundBySlot.set(sl.id, { glyphs: [], fill: sl.fill, textChars: chars });
          }
        }
      }
    }

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
    // REAL Figma exporter positions: inside input pills the value text box
  // spans the full inner width and the glyphs start at the left padding —
  // the exporter emits text runs with the box translated to the padding
  // origin. Mirror that by re-anchoring prop-text slots to x = 12 inside
  // their frame parent (matches the baked 12px pill padding).
  for (const sl of slots) {
    const bound = boundBySlot.get(sl.id);
    if (!bound?.propText || bound.glyphs?.length) continue;
    const parent = fig.nodes.get(sl.parentId);
    if (!parent || parent.type !== "FRAME") continue;
    if (!/input/i.test(parent.name ?? "")) continue;
    // shift only when the baked x drifted past the standard 12px padding
    if (sl.nodeX > 14) {
      const shifted = bound;
      void shifted;
      sl.nodeX = 12;
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
    // reference-measured button widths (px) — the .fig bakes these slots
    // with stale metrics, so grown widths are calibrated to the export
    const CAL_W: Record<string, number> = {
      "Delete saved filters": 190,
      "Save & Search": 146,
      "Cancel": 90,
      "Later": 79,
      "Delete": 86,
    };
    let extCal = false;
    const extOf = (cn: any): number => {
      extCal = false;

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
        const labelText = b.textChars ?? b.propText;

        // calibrated width wins outright — measured from the reference
        // (may SHRINK a stale-wide bake, so the caller must not max() it)
        if (labelText && CAL_W[labelText] !== undefined) {
          extCal = true;
          return CAL_W[labelText] - 16;
        }
        if (b.propText) propCap = Math.min(propCap, textWidthEst(b.propText, b.glyphs?.[0]?.fontSize ?? 16) + 44);
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
      let widest = 0;
      let n2 = 0;
      for (const k2 of kids2) {
        const cn2 = fig.nodes.get(k2);
        if (!cn2 || cn2.visible === false) continue;
        n2++;
        let w2 = cn2.size?.x ?? 0;
        if (cn2.type === "INSTANCE") w2 = Math.max(w2, Math.round(extOf(cn2)) + 16);
        else if (cn2.stackMode) w2 = estimateW(k2);
        sum += w2;
        widest = Math.max(widest, w2);
      }
      // vertical stacks flow DOWN — width hugs the widest child, not the
      // sum (summing produced 848px dialog headers that then got centered
      // at a half-size offset)
      if (f.stackMode === "VERTICAL") return Math.round(widest + 2 * (f.stackHorizontalPadding ?? 0));
      return Math.round(sum + (f.stackSpacing ?? 0) * Math.max(0, n2 - 1) + 2 * (f.stackHorizontalPadding ?? 0));
    };
    const items: { cn: any; w: number; h: number; bakedW: number; flowW?: number }[] = [];
    const boundTextW = (cn: any): number => {
      const key = okeyOf(cn);
      const merged = mergeDir(ancDir?.children.get(key ?? ""), buildDirectiveTree(cn));
      let ext = 0;
      for (const run of merged?.textByKey.values() ?? []) {
        for (const gg of run) ext = Math.max(ext, (gg.position?.x ?? 0) + (gg.fontSize ?? cn.fontSize ?? 16) * 0.6);
      }
      if (ext > 0) return ext;
      const chars = key ? merged?.textChars.get(key) : undefined;
      return chars ? textWidthEst(chars, cn.fontSize ?? 16) : 0;
    };
    for (const kid of kids) {
      const cn = fig.nodes.get(kid);
      if (!cn || cn.visible === false) continue;
      const bakedW = cn.size?.x ?? 24;
      let w = bakedW;
      let flowW: number | undefined;
      if (cn.type === "TEXT") {
        // a stale WIDE text box leaves the siblings that follow it too far
        // right; keep the measured width aside (flowW) and leave `w` alone so
        // every other layout rule sees exactly what it saw before
        const ext = boundTextW(cn);
        if (ext > 0) flowW = Math.max(8, Math.min(bakedW, Math.round(ext)));
      } else if (cn.type === "INSTANCE") {
        const ext = extOf(cn);
        if (ext > 0) {
          const cand = Math.round(ext) + 16;
          // calibrated widths may SHRINK a stale-wide bake; measured
          // extents only ever grow one
          w = extCal ? cand : Math.max(bakedW, cand);
        }
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
      items.push({ cn, w, h: cn.size?.y ?? 24, bakedW, flowW });
    }
    if (items.length < 2) return;
    const total = items.reduce((a, it) => a + it.w, 0) + spacing * (items.length - 1);
    // main-axis content size for VERTICAL stacks flows along heights
    const totalV = items.reduce((a, it) => a + it.h, 0) + spacing * (items.length - 1);
    const t1 = items[1].cn.transform;
    const bakedGap = t1 ? (horiz ? t1.m02 : t1.m12) - (horiz ? items[0].cn.transform?.m02 ?? 0 : items[0].cn.transform?.m12 ?? 0) - items[0].bakedW : 0;
    const between = (total < main - 2 * padMain - 12 && bakedGap > spacing * 3 + 8)
      // "Leading content … Trailing content=N icon button" headers pin the
      // trailing button to the right edge regardless of baked positions
      || (horiz && items.length === 2 && /Trailing content=.*icon button/i.test(comp?.name ?? ""));
    const overflow = items.some((it) => it.w > it.bakedW + 2);
    const staleTextFlow =
      horiz &&
      !/Trailing content=.*icon button/i.test(comp?.name ?? "") &&
      // buttons carry a full-size state-layer background as a child — their
      // baked positions are the real ones, never a stale text flow
      !items.some((it) => /state-layer/i.test(it.cn.name ?? "")) &&
      items.length >= 2 &&
      items.some((it, i) => it.flowW !== undefined && it.flowW < it.bakedW - 2 && i < items.length - 1) &&
      items.every((it, i) => {
        if (i === 0) return true;
        const prev = items[i - 1];
        const prevEnd = (prev.cn.transform?.m02 ?? 0) + prev.bakedW;
        return Math.abs((it.cn.transform?.m02 ?? 0) - (prevEnd + spacing)) < 1.5;
      });
    if (staleTextFlow && process.env.FIGMA_TRACE_FIRE) {
      console.error(`[fire] ${comp.name} items=${items.map((it) => `${it.cn.name}:${it.w}/${it.bakedW}`).join(" ")}`);
    }
    // stretched vertical stacks (dialog overlays): Figma keeps the first
    // child at the top and pins the last to the bottom edge
    const vBetween = !horiz && items.length === 2 && H > totalV + 2 * padMain + 4;
    // horizontally centered rows (modal footer buttons) re-flow around the
    // midpoint when a calibrated width changed an item's size
    const centerRow = horiz && comp.stackPrimaryAlignItems === "CENTER";
    const changed = items.some((it) => Math.abs(it.w - it.bakedW) > 2);
    if (process.env.FIGMA_TRACE_STACK2) {
      console.error(`[st2] ${comp.name} horiz=${horiz} items=${items.map((it) => `${it.cn.name}[${it.cn.type}]:w${it.w}/b${it.bakedW}@${r(horiz ? it.cn.transform?.m02 ?? 0 : it.cn.transform?.m12 ?? 0)}`).join(" ")} spacing=${spacing} pad=${padMain} main=${main}`);
    }
    if (process.env.FIGMA_TRACE_STACK) {
      console.error(`[stack] comp=${comp.name} compId=${compId} horiz=${horiz} W=${W} H=${H} main=${main} items=${items.map((it) => `${it.cn.name}:${it.w}/${it.bakedW}`).join(",")} overflow=${overflow} between=${between} vBetween=${vBetween} centerRow=${centerRow}`);
    }
    if (!(overflow || (between && items.length === 2) || vBetween || (centerRow && changed) || staleTextFlow)) return;
    let p = staleTextFlow
      ? Math.max(padMain, horiz ? items[0].cn.transform?.m02 ?? padMain : items[0].cn.transform?.m12 ?? padMain)
      : padMain;
    let cx = (main - total) / 2;
    items.forEach((it, i) => {
      const t = it.cn.transform;
      if (!t) return;
      const last = i === items.length - 1;
      // items that did not grow keep their baked position, but p still
      // advances past them (else a later grown item lands ON TOP of an
      // untouched sibling — the footer Save-on-Cancel collapse)
      const grew = it.w > it.bakedW + 2;
      let pos: number;
      if (vBetween && (i === 0 || last)) pos = last ? main - padMain - it.h : padMain;
      else if (staleTextFlow) pos = p;
      else if (centerRow && changed) { pos = cx; cx += it.w + spacing; }
      else if (between && (i === 0 || last))
        pos = last ? main - padMain - it.w : padMain;
      else if (grew) pos = p;
      else pos = horiz ? (t.m02 ?? p) : (t.m12 ?? p);
      const cross = horiz ? (H - it.h) / 2 : (W - it.w) / 2;
      // header stacks (Title … icon button): the leading Title keeps its
      // component x — the real exporter renders it at the stack padding,
      // not counter-centered on the grown title box
      const keepX = horiz && between && i === 0 && /Trailing content=.*icon button/i.test(comp?.name ?? "") ? (t.m02 ?? padMain) : pos;
      // centered rows keep their baked cross position (padV governs it,
      // not counter-centering)
      it.cn.transform = horiz
        ? { ...t, m02: keepX, m12: centerRow && changed ? (t.m12 ?? cross) : cross }
        : { ...t, m12: pos, m02: cross };
      if (it.cn.type !== "TEXT" && Math.abs(it.w - it.bakedW) > 2 && it.cn.size) it.cn.size = { ...it.cn.size, x: it.w };
      p = pos + (staleTextFlow ? it.flowW ?? it.w : it.w) + spacing;
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
    pstack?: string,
    tint?: string,
  ): string => {
    if (depth > maxDepth || nodeCount >= maxNodes) return "";
    const n = fig.nodes.get(id);
    if (!n || n.visible === false) return "";
    nodeCount++;
    if (process.env.FIGMA_TRACE_WALK) {
      console.error(`[walk] d${depth} ${n.name} [${n.type}] w=${Math.round(n.size?.x ?? -1)} h=${Math.round(n.size?.y ?? -1)} mat=(${r(mat[4])},${r(mat[5])})`);
    }

    const opacity = typeof n.opacity === "number" && n.opacity < 1 ? ` opacity="${r(n.opacity)}"` : "";

    const { fill, fillOpacity, imageHash, stops } = paintInfo(n.fillPaints);
    const fillHere = fill && fillOpacity > 0.001 ? fill : undefined;
    let w = n.size ? Math.round(n.size.x) : 0;
    let h = n.size ? Math.round(n.size.y) : 0;
    const fo = fill && fillOpacity < 0.999 ? ` fill-opacity="${r(fillOpacity)}"` : "";

    /** a local rounded rect mapped through the accumulated matrix — a bare
     * mat[4]/mat[5] placement ignores rotation (the vertical scrollbar is a
     * 90deg-rotated 1128x16 instance) and clips its children away */
    const rectAbs = (x: number, y: number, w2: number, h2: number, rad: number): string => {
      const rotated = Math.abs(mat[1] ?? 0) > 1e-6 || Math.abs(mat[3] ?? 0) > 1e-6 || Math.abs((mat[0] ?? 1) - 1) > 1e-6;
      return rotated ? xfPath(roundedRectPath(x, y, w2, h2, rad), mat) : roundedRectPath(mat[4] + x, mat[5] + y, w2, h2, rad);
    };
    /** exact fill geometry of this node transformed to absolute space */
    const geomAbs = (): string | null => {
      // instance/frame boxes re-flow (stack layout, stretch, swap compress)
      // so their BAKED vector geometry goes stale — synthesize from the
      // CURRENT size + resolved radius instead
      if (n.type === "INSTANCE" || n.type === "FRAME" || n.type === "RECTANGLE" || n.type === "ROUNDED_RECTANGLE") {
        const rad = radiusOf(n);
        if (w > 0 && h > 0) {
          return rectAbs(0, 0, w, h, rad);
        }
        return null;
      }
      try {
        const paths = resolveVectorNodePaths(doc, n as any);
        const parts: string[] = [];
        for (const p of paths.fill) {
          if (!p.svgPath) continue;
          parts.push(xfPath(p.svgPath, mat));
        }
        if (parts.length) return parts.join("");
      } catch { /* fall through */ }
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
        // prop-text slots whose family is embedded render as live <text>:
        // the baked runs can be fallback-font outlines (export session
        // without the font), while the browser now has the real face
        const familyEmbeddable = (n.fontName?.family ?? "") === "SCBX Looped";
        const glyphs = bound
          ? (bound.glyphs?.length && !(bound.propText && familyEmbeddable) ? bound.glyphs : undefined)
          : (noText ? undefined : n.derivedTextData?.glyphs);
        if (process.env.FIGMA_TRACE === "3" && /Delete saved/.test(bound?.propText ?? n.textData?.characters ?? "")) {
          console.error(`[dbg] id=${id} propText=${JSON.stringify(bound?.propText)} nGlyphs=${bound?.glyphs?.length ?? 0} stale=${JSON.stringify(bound?.stale)} chars=${JSON.stringify(n.textData?.characters)} font=${n.fontName?.family}`);
        }
        if (process.env.FIGMA_TRACE_TABLE && mat[4] > 800 && mat[4] < 1100 && mat[5] > 700 && mat[5] < 850) {
          console.error(`[table] id=${id} name=${n.name} parent=${n.parentIndex?.guid ? guidStr(n.parentIndex.guid) : "-"} chars=${JSON.stringify(n.textData?.characters)} boundChars=${JSON.stringify(bound?.textChars)} prop=${JSON.stringify(bound?.propText)} glyphs=${bound?.glyphs?.length ?? 0} own=${n.derivedTextData?.glyphs?.length ?? 0} mat=(${r(mat[4])},${r(mat[5])})`);
        }
        if (glyphs && glyphs.length) {
          const lines = new Map<number, string[]>();
          const fs0 = n.fontSize ?? 14;
          // glyph positions come in TWO units across the file: px relative
          // to the text box (0..100+) and em (0..~1) — normalize em runs by
          // scaling with the font size
          let maxY = 0;
          for (const g of glyphs) {
            maxY = Math.max(maxY, g.position?.y ?? 0);
          }
          // px runs sit on a baseline ≈ fontSize*1.13 (y≈18 for 16px); em
          // runs on y≈1.1 — the baseline is the unambiguous discriminator
          const unit = maxY > 4 ? 1 : fs0;
          const boxH = n.size?.y ?? 0;
          const growH = n.textAutoResize === "HEIGHT";
          let origLines = 1;
          let firstLineY: number | null = null;
          for (const g of glyphs) {
            const gy0 = (g.position?.y ?? 0) * unit;
            if (firstLineY === null || gy0 < firstLineY) firstLineY = gy0;
          }
          for (const g of glyphs) {
            const gy0 = (g.position?.y ?? 0) * unit;
            if (firstLineY !== null && gy0 > firstLineY + fs0 * 0.5) origLines = Math.max(origLines, 2);
          }
          // single-line node box: derived runs can carry a wrapped 2nd line
          // (e.g. sidebar "Citizen ID…"); Figma truncates to the box — keep
          // only the first baseline when the box fits exactly one line.
          // HEIGHT boxes with single-line baked runs grow instead (the
          // dialog body wraps at render time) — they never truncate
          // Figma truncates overflowing one-line labels with an ellipsis —
          // but ONLY for runs that actually WRAPPED in the bake (2+ lines,
          // e.g. the sidebar "Citizen ID/Business registrati..."). Auto-resize
          // boxes whose ink is wider than a stale box width are fine and
          // must keep every glyph
          let truncated = false;
          const boxW = w || 0;
          const dotsW = fs0 * 0.9;
          // a HEIGHT box inside a vertical auto-layout stack grows with its
          // content (dialog body wraps to its real lines); everywhere else
          // the fixed box clamps the text (sidebar rows truncate with "…")
          const wrapAllowed = growH && pstack === "VERTICAL";
          const oneLineOnly = boxH > 0 && boxH < fs0 * 1.6 && !wrapAllowed;
          const reallyOverflows = origLines >= 2;
          // textAutoResize=HEIGHT runs baked on a single line but wider than
          // the box wrap at render time: split at the last word boundary
          // (space-advance gap) that fits, center each line per the node's
          // alignment, and stack lines at the node's line height
          let placed: { g: any; gx: number; gy: number }[] | null = null;
          if (wrapAllowed && origLines === 1 && boxW > 0 && glyphs.length > 1) {
            const adv = (g: any): number => (g.advance ?? 0.6) * unit;
            const tot = glyphs.reduce((a: number, g: any) => a + adv(g), 0);
            if (tot > boxW + 1) {
              const lineH = typeof n.lineHeight?.value === "number" && n.lineHeight.value > 0 ? n.lineHeight.value : fs0 * 1.5;
              const isSpace = (g: any): boolean => adv(g) > 0 && adv(g) < fs0 * 0.35;
              let split = -1;
              let cur = 0;
              for (let i = 0; i < glyphs.length; i++) {
                cur += adv(glyphs[i]);
                if (cur > boxW && split < 0) {
                  let j = i;
                  while (j > 0 && !isSpace(glyphs[j - 1])) j--;
                  split = j > 0 ? j : i;
                  break;
                }
              }
              if (split > 0 && split < glyphs.length) {
                const lineW = (arr: any[]): number =>
                  (arr[arr.length - 1].position?.x ?? 0) * unit + adv(arr[arr.length - 1]) - (arr[0].position?.x ?? 0) * unit;
                const place = (arr: any[], line: number): void => {
                  const off = (boxW - lineW(arr)) / 2 - (arr[0].position?.x ?? 0) * unit;
                  for (const g of arr) placed!.push({ g, gx: (g.position?.x ?? 0) * unit + off, gy: (firstLineY ?? 0) + line * lineH });
                };
                placed = [];
                place(glyphs.slice(0, split), 0);
                place(glyphs.slice(split), 1);
              }
            }
          }
          const laid: { g: any; gx: number; gy: number }[] = placed ?? glyphs.map((g: any) => ({ g, gx: (g.position?.x ?? 0) * unit, gy: (g.position?.y ?? 0) * unit }));
          for (const { g, gx, gy } of laid) {
            if (oneLineOnly && firstLineY !== null && gy > firstLineY + fs0 * 0.5) continue;
            if (oneLineOnly && reallyOverflows && boxW > 0 && gx + (g.advance ?? 0.6) * fs0 > boxW - dotsW) {
              truncated = true;
              continue;
            }
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
          if (merged) {
            const basePath = `<path d="${merged}" fill="${fillC}"${opacity}/>`;
            if (truncated) {
              // ellipsis dots at the box's right edge (fallback-font dots)
              const t = n.transform ?? { m00: 1, m01: 0, m02: 0, m10: 0, m11: 1, m12: 0 };
              const dotsX = mat[0] * (t.m02 + w - dotsW - 2) + mat[4];
              const dotsY = mat[5] + (firstLineY ?? 0);
              fontFamilies.add("SCBX Looped");
              return basePath + `<text x="${r(dotsX)}" y="${r(dotsY)}" font-family="SCBX Looped, sans-serif" font-size="${r(fs0)}" fill="${fillC}"${opacity}>...</text>`;
            }
            return basePath;
          }
        }
        if (noText) return "";
        const propText = bound?.propText;
        const fs = n.fontSize ?? 14;
        const family = n.fontName?.family ?? "Inter";
        const align = n.textAlignHorizontal === "CENTER" ? ' text-anchor="middle"' : n.textAlignHorizontal === "RIGHT" ? ' text-anchor="end"' : "";
        const fstyle = n.fontName?.style ?? "";
        const fweight = /bold/i.test(fstyle) ? ' font-weight="700"' : /semi/i.test(fstyle) ? ' font-weight="600"' : "";
        // Figma emits text runs left-anchored inside pills/buttons; only a
        // swap that actually upgraded glyph runs keeps its centered anchor.
        const anchorX = bound?.boundW && n.textAlignHorizontal === "CENTER" && bound.glyphs?.length
          ? Math.max(0, bound.boundW / 2 - (n.transform?.m02 ?? 0))
          : n.textAlignHorizontal === "CENTER" && !bound?.propText ? w / 2 : n.textAlignHorizontal === "RIGHT" ? w : 0;
        const chars = bound?.textChars ?? propText ?? n.textData?.characters ?? "";
        if (!chars) return "";
        // hard 1-line box: Figma clips overflowing label text to the node
        // height (a 20px box shows one 16px line, never two)
        const boxH = n.size?.y ?? 0;
        const t = n.transform ?? { m00: 1, m01: 0, m02: 0, m10: 0, m11: 1, m12: 0 };
        const ax = mat[0] * (t.m02 ?? 0) + mat[2] * (t.m12 ?? 0) + mat[4];
        const ay = mat[1] * (t.m02 ?? 0) + mat[3] * (t.m12 ?? 0) + mat[5];
        if (boxH > 0 && boxH < fs * 1.4) {
          // single-line clip: keep only the glyphs that fit the box width
          const boxW = w || chars.length * fs * 0.62;
          const charW = fs * 0.58; // SCBX Looped average advance
          const maxChars = Math.max(1, Math.floor((boxW - 2) / charW));
          const shown = chars.length > maxChars ? chars.slice(0, maxChars).replace(/[\s,]+$/, "") + "…" : chars;
          const tl1 = propText && family !== "SCBX Looped" ? ` textLength="${r(textWidthEst(chars, fs))}" lengthAdjust="spacingAndGlyphs"` : "";
          fontFamilies.add(family);
          return `<text x="${r(ax + anchorX)}" y="${r(ay + fs * 0.8)}" font-family="${esc(family)}, sans-serif" font-size="${r(fs)}" fill="${fillC}"${align}${fweight}${tl1}${opacity}>${esc(shown)}</text>`;
        }
        // fallback-font runs are wider than SCBX Looped; force the reference
        // metrics so button labels stop overflowing their pills
        const tl = propText && family !== "SCBX Looped" ? ` textLength="${r(textWidthEst(chars, fs))}" lengthAdjust="spacingAndGlyphs"` : "";
        fontFamilies.add(family);
        return `<text x="${r(ax + anchorX)}" y="${r(ay + fs * 0.8)}" font-family="${esc(family)}, sans-serif" font-size="${r(fs)}" fill="${fillC}"${align}${fweight}${tl}${opacity}>${esc(chars)}</text>`;
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
        let childTint: string | undefined = tint;
        let successCtx = false;
        if (n.type === "INSTANCE") {
          // VISIBLE prop assigned false anywhere in the ancestor chain
          // (e.g. stale clear ✕ inside non-clearable variants) → hidden
          const visRefs = nodeVisibleRefs(n);
          if (visRefs.some((r) => dir?.assigns.get(r)?.bool === false)) return "";
          const okey = okeyOf(n);
          const ancNode = dir?.children.get(okey ?? "");
          const ownTree = buildDirectiveTree(n);
          const node = mergeDir(ancNode, ownTree);
          // inherit ancestor text runs not addressed by THIS node's own key
          // chain (the walk consumes one tree level per nesting; a run keyed
          // at an ancestor level still addresses a slot further down)
          if (dir && ancNode !== dir) {
            for (const [gk, gv] of dir.textByKey) {
              const prev = node.textByKey.get(gk);
              if (!prev || gv.length > prev.length) node.textByKey.set(gk, gv);
            }
          }
          let symId = guidStr(n.symbolData?.symbolID);
          if (node.swapSym && fig.nodes.has(node.swapSym)) {
            swapApplied = { newSym: node.swapSym };
            symId = node.swapSym;
          }
          // instance swap declared as a component property (icon slots):
          // the design's assigned symbol wins over the baked component icon
          const symPropRef = nodeSymbolRef(n);
          const propSym = symPropRef
            ? node.assigns.get(symPropRef)?.symbol ?? dir?.assigns.get(symPropRef)?.symbol
            : undefined;
          if (propSym && fig.nodes.has(propSym)) {
            swapApplied = { newSym: propSym };
            symId = propSym;
            // The assigned icon slot inherits its context color. Prefer an
            // explicit icon hint, then the enclosing button foreground; a
            // standalone navbar Alert uses the brand purple from the design.
            const sibText = (fig.kidsOf.get(guidStr(n.symbolData?.symbolID)) ?? [])
              .map((k) => fig.nodes.get(k))
              .find((k) => k?.type === "TEXT");
            const sibFill = sibText ? paintInfo(sibText.fillPaints).fill : undefined;
            const ownerName = fig.nodes.get(guidStr(n.symbolData?.symbolID))?.name ?? "";
            const assignedName = fig.nodes.get(propSym)?.name ?? "";
            if (/^Alert$/i.test(assignedName)) childTint = "#6A41C9";
            else if (hint?.color) childTint = hint.color;
            else if (sibFill) childTint = sibFill;
            else if (/Type=Primary/.test(ownerName)) childTint = "#FFFFFF";
          }
          // Some button instances keep the OVERRIDDEN_SYMBOL_ID assignment
          // on the owner while the ref is declared by its nested icon slot.
          // Pass the primary foreground down to that slot without tinting
          // sibling text/state-layer nodes.
          const ownAssigns = assignMap(n.componentPropAssignments);
          const hasIconAssign = [...ownAssigns.values()].some((v) => !!v.symbol);
          if (hasIconAssign && /Type=Primary/.test(fig.nodes.get(guidStr(n.symbolData?.symbolID))?.name ?? "")) {
            childTint = "#FFFFFF";
          }
          // status icons (success toast checkmark) take the state color —
          // the tint survives only to the checkmark, not to the close button
          successCtx = /Type=Success/i.test(`${n.name ?? ""} ${fig.nodes.get(symId0Of(n) ?? "")?.name ?? ""}`);
          if (successCtx) childTint = "#0AC256";
          if (symId) {
            childOverrideMap = buildSlotMap(n, symId, { dir: node, inheritedAssigns: new Map([...(dir?.assigns ?? [])]) });
            if (node) childDir = node;
            applyStackLayout(symId, n, node);
          }
          // stale icon remap: outdated circle-✕ instances render the real
          // glyph component (trash / plus / bare ✕) declared by the context
          const resolvedName0 = symId ? fig.nodes.get(symId)?.name ?? "" : "";
          if (resolvedName0 === "Dismiss Circle" && hint?.kind !== "Add" && hint?.kind !== "Delete" && hint?.color !== "#FFFFFF" && w > 0 && w <= 32) {
            // clearable input ✕: Figma's "clear circle" = 1px ring + small ✕,
            // drawn procedurally (the baked instance geometry is stale/mangled)
            const cx = mat[4] + w / 2;
            const cy = mat[5] + h / 2;
            const ring = ellipsePath(cx, cy, 6.67, 6.67);
            const k = 2.9;
            const cross = `M${xf(cx - k)} ${xf(cy - k)}L${xf(cx + k)} ${xf(cy + k)}M${xf(cx + k)} ${xf(cy - k)}L${xf(cx - k)} ${xf(cy + k)}`;
            const col = hint?.color ?? "#6A7187";
            return `<path d="${ring}" fill="none" stroke="${col}" stroke-width="1.1"/>` +
              `<path d="${cross}" fill="none" stroke="${col}" stroke-width="1.2" stroke-linecap="round"/>`;
          }
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
          // instance width. Selected option gets Figma's real treatment:
          // purple 1px rounded (r=8) outline, label kept at its natural
          // position (the exporter centers text runs per option);
          // unselected options render the bare label glyphs like the
          // top AND|OR control (48..95.5 text-only, no white box).
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
              idx++;
            }
          }
          // stretched selects: grow the inner "input" pill, right-pin its icon
          const compNode0 = symId ? fig.nodes.get(symId) : undefined;
          const compW0 = compNode0?.size?.x ?? 0;
          if (compNode0 && Math.abs(w - compW0) > 2 && /input\.(select|textfield)|Filled\?=|Clearable/.test(compNode0.name ?? "")) {
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
          // uniformly enlarged icon instances (constraints=SCALE): the
          // component canvas renders scaled to the instance box (the alert
          // Warning icon: 32px canvas in an 80px instance → ×2.5)
          if (compNode0 && !compNode0.stackMode && childScaleOk(n, w, h, compW0, compNode0.size?.y ?? 0)) {
            const sc = w / compW0;
            for (const k of fig.kidsOf.get(symId) ?? []) {
              const kn = fig.nodes.get(k);
              if (!kn?.transform) continue;
              kn.transform = {
                m00: (kn.transform.m00 ?? 1) * sc,
                m01: (kn.transform.m01 ?? 0) * sc,
                m02: (kn.transform.m02 ?? 0) * sc,
                m10: (kn.transform.m10 ?? 0) * sc,
                m11: (kn.transform.m11 ?? 1) * sc,
                m12: (kn.transform.m12 ?? 0) * sc,
              };
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
          // generic foreground tint: an icon inside a labeled container draws
          // in the label's color (white menu glyphs on the dark sidebar, the
          // grey magnifier in the search field). Explicit icon hints
          // (Danger/Tertiary/Add) keep their own colors.
          if (!own) {
            const firstText = (fig.kidsOf.get(resId ?? id) ?? [])
              .map((k) => fig.nodes.get(k))
              .find((k) => k?.type === "TEXT");
            const f = firstText ? paintInfo(firstText.fillPaints).fill : undefined;
            if (f) childTint = f;
          }
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
            const knName = kn?.name ?? "";
            // a drawable child with no paint of its own is an icon slot: it may
            // inherit the container's foreground tint (Shape/Vector/Icon/…)
            const childIsIcon =
              /^(Icon|Logo|Dismiss|Search|Panel Left Contract|Checkmark Circle|Icon Button|Shape|Vector)$/i.test(knName) ||
              !!nodeSymbolRef(kn ?? {});
            // an already-tinted context (icon inside a color-inheriting slot)
            // flows all the way down to the vector paths
            let passTint = tint !== undefined ? childTint : childIsIcon ? childTint : undefined;
            if (successCtx && !/checkmark/i.test(knName)) passTint = undefined;
            childrenSvg += walk(kid, depth + 1, false, childOverrideMap ?? overrideMap, kidDir, w, childHint, mulM(mat, nodeMat(kn ?? {})), n.stackMode, passTint);
          }
        }

        // variant content wider than the instance compresses into it
        // (segmented radios reflow per-option instead — see above);
        // scale around the INSTANCE's left edge — a bare scale() would
        // collapse everything toward the canvas origin (x=0)
        if (swapApplied) {
          const sc = fig.nodes.get(swapApplied.newSym);
          const cw = sc?.size?.x ?? 0;
          if (cw > w + 2 && cw > 0 && !/Amount=\d/.test(sc?.name ?? "")) {
            const s2 = w / cw;
            childrenSvg = `<g transform="translate(${r(mat[4] * (1 - s2))},0) scale(${r(s2)},1)">${childrenSvg}</g>`;
          }
        }

        // node background + border (Figma splits fill and stroke into two
        // paths; inside-aligned strokes are inset by weight/2)
        let shapeSvg = "";
        const geomD = geomAbs();
        let paint = fill && n.type !== "GROUP" ? fill : undefined;
        if (swapApplied) {
          const comp = fig.nodes.get(swapApplied.newSym);
          const ci = comp ? paintInfo(comp.fillPaints) : null;
          // the swapped variant owns its paint: an instance that was baked
          // with the ORIGINAL variant's fill (e.g. a purple selected menu row)
          // must not keep it after swapping to the default variant
          paint = ci?.fill ?? undefined;
        }
        const fo2 = fill && fillOpacity < 0.999 ? ` fill-opacity="${r(fillOpacity)}"` : "";
        const compForVis = n.type === "INSTANCE" ? fig.nodes.get(swapApplied?.newSym ?? symId0Of(n) ?? "") : undefined;
        const st = strokeText(n, compForVis);
        const swI = st ? swInset(n) / 2 : 0;
        if (paint) {
          // segmented-radio instance: Figma paints the OPTION containers, not
          // the root box; reflowed halves would paint a wrong white slab
          const isRadio = n.type === "INSTANCE" && /Amount=\d+/.test(fig.nodes.get(swapApplied?.newSym ?? symId0Of(n) ?? "")?.name ?? "");
          // fill = the stroke-inset shape when an inside stroke surrounds it
          const compForRad = n.type === "INSTANCE" ? fig.nodes.get(swapApplied?.newSym ?? symId0Of(n) ?? "") : undefined;
          const fillD = geomD ?? (w > 0 && h > 0 && !isRadio
            ? roundedRectPath(mat[4] + swI, mat[5] + swI, Math.max(0, w - swI * 2), Math.max(0, h - swI * 2), Math.max(0, radiusOf(n, compForRad) - swI))
            : null);
          if (fillD) {
            shapeSvg = `<path d="${fillD}" fill="${paint}"${fo2}${opacity}/>`;
            if (st) shapeSvg += `<path d="${fillD}" fill="none"${st}${opacity}/>`;
          }
          // segmented radio: the selected option = white half-pill with a
          // purple 1px outline (outer corners r=8, inner edge flat);
          // unselected options stay bare like Figma's exporter
          if (isRadio && w > 0 && h > 0) {
            const name = String(fig.nodes.get(swapApplied?.newSym ?? symId0Of(n) ?? "")?.name ?? "");
            const selOpt = /Selected=Opt\s*(\d+)/.exec(name);
            if (selOpt) {
              const nOpt = Math.max(1, parseInt(/Amount=(\d+)/.exec(name)![1], 10));
              const optW = w / nOpt;
              const oi = Math.min(nOpt, Math.max(1, parseInt(selOpt[1], 10))) - 1;
              const ox = mat[4] + oi * optW;
              const rOut = 8;
              // snap the 1px outline to .5 pixel boundaries so the stroke
              // fills whole pixels (crisp like Figma) instead of straddling
              // two columns at half opacity
              const x1 = Math.round(ox) + 0.5, x2 = Math.round(ox + optW) - 0.5;
              const y1 = Math.round(mat[5]) + 0.5, y2 = Math.round(mat[5] + h) - 0.5;
              const kc = (rOut - 0.5) * 0.5522847498;
              // left option: round left corners; right option: round right
              let pillD: string;
              if (oi === 0) {
                pillD = `M${xf(x1 + rOut)} ${xf(y1)}H${xf(x2)}V${xf(y2)}H${xf(x1 + rOut)}C${xf(x1 + rOut - kc)} ${xf(y2)} ${xf(x1)} ${xf(y2 - rOut + kc)} ${xf(x1)} ${xf(y2 - rOut)}V${xf(y1 + rOut)}C${xf(x1)} ${xf(y1 + rOut - kc)} ${xf(x1 + rOut - kc)} ${xf(y1)} ${xf(x1 + rOut)} ${xf(y1)}Z`;
              } else {
                pillD = `M${xf(x2 - rOut)} ${xf(y1)}H${xf(x1)}V${xf(y2)}H${xf(x2 - rOut)}C${xf(x2 - rOut + kc)} ${xf(y2)} ${xf(x2)} ${xf(y2 - rOut + kc)} ${xf(x2)} ${xf(y2 - rOut)}V${xf(y1 + rOut)}C${xf(x2)} ${xf(y1 + rOut - kc)} ${xf(x2 - rOut + kc)} ${xf(y1)} ${xf(x2 - rOut)} ${xf(y1)}Z`;
              }
              shapeSvg += `<path d="${pillD}" fill="white"/><path d="${pillD}" fill="none" stroke="#6a41c9" stroke-width="1"/>`;
            }
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

        // roll back component-subtree mutations before the next sibling
        // instance walks the same shared component
        if (n.type === "INSTANCE") {
          const symIdR = swapApplied?.newSym ?? symId0Of(n);
          if (symIdR) restoreSubtree(symIdR);
        }

        // clip children to the instance/frame box
        const clips = n.type === "INSTANCE" || (n.type === "FRAME" && n.clipsContent === true);
        let out = `${shapeSvg}${img}${childrenSvg}`;
        if (clips && childrenSvg && w > 0 && h > 0) {
          const cid = `clip${clipSeq + 1}_${frameTag}`;
          clipSeq++;
          const clipGeom = rectAbs(0, 0, w, h, radiusOf(n));
          defs.push(`<clipPath id="${cid}"><path d="${clipGeom}"/></clipPath>`);
          out = `<g clip-path="url(#${cid})">${out}</g>`;
        }
        // Figma drop shadow: a blurred copy of the node silhouette, drawn
        // OUTSIDE the clip group so it can bleed past the box
        {
          const sh = effectShadow(n, compForVis);
          const d2 = sh && w > 0 && h > 0 ? rectAbs(0, 0, w, h, radiusOf(n, compForVis)) : null;
          if (sh && d2) {
            const c = sh.color ?? {};
            const hex = `#${[c.r ?? 0, c.g ?? 0, c.b ?? 0].map((v: number) => Math.round(v * 255).toString(16).padStart(2, "0")).join("")}`;
            const alpha = typeof c.a === "number" ? c.a : 1;
            // Figma's negative spread insets the shadow silhouette; the blur
            // keeps the near-edge coverage high, so an SVG erode overshoots
            // (the shadow came out ~40% too light) — measured against the
            // reference export, skipping the erode matches Figma's falloff
            const erode = "";
            const base = "SourceAlpha";
            const fid = `sh${++shadowSeq}_${frameTag}`;
            defs.push(
              `<filter id="${fid}" x="-40%" y="-40%" width="180%" height="180%" color-interpolation-filters="sRGB">` +
                erode +
                `<feOffset in="${base}" dx="${r(sh.offset?.x ?? 0)}" dy="${r(sh.offset?.y ?? 0)}" result="off"/>` +
                `<feGaussianBlur in="off" stdDeviation="${r((sh.radius ?? 0) / 2)}" result="blur"/>` +
                `<feFlood flood-color="${hex}" flood-opacity="${r(alpha)}" result="col"/>` +
                `<feComposite in="col" in2="blur" operator="in"/>` +
                `</filter>`,
            );
            out = `<path d="${d2}" fill="${hex}" filter="url(#${fid})"/>` + out;
          }
        }
        return out;
      }
      case "RECTANGLE":
      case "ROUNDED_RECTANGLE": {
        const rad = radiusOf(n);
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
            g.push(`<path d="${xfPath(p.svgPath, mat)}" fill="${tint ?? ((pf && hexFill(pf)) || fill || "none")}"${opacity}/>`);
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

  /** uniform non-1 instance/component size ratio (constraints=SCALE case) */
  function childScaleOk(n: RawChange, w: number, h: number, cw: number, ch: number): boolean {
    if (!(cw > 0 && ch > 0 && w > 0 && h > 0)) return false;
    if (Math.abs(w - cw) <= 2 && Math.abs(h - ch) <= 2) return false;
    const sx = w / cw;
    const sy = h / ch;
    return Math.abs(sx - sy) < 0.02 && Math.abs(sx - 1) > 0.02;
  }

  const frameTag = rootId.replace(/[^0-9A-Za-z]/g, "_");
  defs.push(`<clipPath id="clip0_${frameTag}"><rect width="${W}" height="${H}"/></clipPath>`);
  const inner = walk(rootId, 0, false, undefined, undefined, undefined, undefined, M_ID);

  const svg =
    `<svg xmlns="http://www.w3.org/2000/svg" xmlns:xlink="http://www.w3.org/1999/xlink" width="${W}" height="${H}" viewBox="0 0 ${W} ${H}" fill="none">\n` +
    `<defs>${defs.join("")}</defs>\n` +
    `<g clip-path="url(#clip0_${frameTag})">\n` +
    `<rect width="${W}" height="${H}" fill="white"/>\n` +
    inner +
    `\n</g>\n</svg>\n`;

  return { svg, width: W, height: H, warnings, nodeCount, fontFamilies: [...fontFamilies] };
}

type RawChange = Record<string, any>;
