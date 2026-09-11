// Resolve Figma .fig component instances to their REAL rendered content:
// symbolData.symbolID → component definition, symbolOverrides (textData +
// componentPropAssignments) for the actual strings, derivedSymbolData for
// geometry/reading order.
//
// WHY THE CUSTOM MERGE: instance edits arrive as separate nodeChanges over
// time — later changes often carry ONLY the edited field (e.g. a size tweak).
// symbolOverrides / derivedSymbolData are accumulating ARRAYS, so a
// replace-style merge silently DROPS text overrides that were recorded
// earlier (verified against a real file: the "Save filter" header override
// vanished until arrays were concatenated).
//
// Pure functions over the raw kiwi nodeChanges — no pi/openfig imports, so
// the e2e tests can drive them with synthetic documents.

export type RawChange = Record<string, any>;

export interface MergedFig {
  nodes: Map<string, RawChange>;
  kidsOf: Map<string, string[]>;
}

export function guidStr(g: any): string | null {
  return g && typeof g === "object" && Number.isFinite(g.sessionID) ? `${g.sessionID}:${g.localID}` : null;
}

export function mergeNodeChanges(nodeChanges: RawChange[]): MergedFig {
  const nodes = new Map<string, RawChange>();
  const kidsOf = new Map<string, string[]>();
  for (const nc of nodeChanges ?? []) {
    const id = guidStr(nc?.guid);
    if (!id || nc.phase === "REMOVED") continue;
    const entry: RawChange = { ...(nodes.get(id) ?? {}) };
    for (const [k, v] of Object.entries(nc)) {
      if (v === null || v === undefined) continue;
      if (k === "symbolData" && v && typeof v === "object") {
        // symbolOverrides accumulate inside symbolData across changes
        const ps = (entry.symbolData ?? {}) as RawChange;
        entry.symbolData = {
          ...ps,
          ...v,
          symbolOverrides: [...((ps.symbolOverrides as any[]) ?? []), ...((v.symbolOverrides as any[]) ?? [])],
          derivedSymbolData: [...((ps.derivedSymbolData as any[]) ?? []), ...((v.derivedSymbolData as any[]) ?? [])],
        };
      } else if (k === "derivedSymbolData") {
        entry[k] = [...((entry[k] as any[]) ?? []), ...((v as any[]) ?? [])];
      } else {
        entry[k] = v;
      }
    }
    nodes.set(id, entry);
    const pid = guidStr((entry.parentIndex as any)?.guid);
    if (pid) {
      if (!kidsOf.has(pid)) kidsOf.set(pid, []);
      const arr = kidsOf.get(pid);
      if (arr && !arr.includes(id)) arr.push(id);
    }
  }
  return { nodes, kidsOf };
}

export interface ResolvedNode {
  type: string;
  name?: string;
  size?: string;
  /** own text (TEXT nodes) */
  text?: string;
  fills?: string[];
  hidden?: boolean;
  opacity?: number;
  radius?: number;
  /** INSTANCE: component definition name (encodes the variant selection) */
  component?: string;
  /** INSTANCE: real strings from symbolOverrides, sorted by derived position */
  overrideTexts?: string[];
  /** INSTANCE: strings assigned via componentPropAssignments */
  propTexts?: string[];
  children?: ResolvedNode[];
}

function hex(c: any): string | undefined {
  if (!c || typeof c !== "object") return undefined;
  const b = (v: number) => Math.round(Math.max(0, Math.min(1, Number(v) || 0)) * 255).toString(16).padStart(2, "0");
  const base = `#${b(c.r)}${b(c.g)}${b(c.b)}`;
  return typeof c.a === "number" && c.a < 1 ? `${base}${b(c.a)}` : base;
}

function fillsOf(n: RawChange): string[] | undefined {
  const paints = n.fillPaints;
  if (!Array.isArray(paints)) return undefined;
  const out = paints
    .map((p: any) => (p?.type === "SOLID" ? hex(p.color) : p?.type ? String(p.type).toLowerCase() : null))
    .filter(Boolean) as string[];
  return out.length ? out : undefined;
}

export function resolveSubtree(fig: MergedFig, rootId: string, opts?: { maxDepth?: number; maxChildren?: number }): ResolvedNode | null {
  const maxDepth = Math.min(14, Math.max(1, opts?.maxDepth ?? 10));
  const maxChildren = Math.max(1, opts?.maxChildren ?? 40);

  function resolveInstance(id: string, n: RawChange, depth: number): ResolvedNode {
    const symId = guidStr(n.symbolData?.symbolID);
    const comp = symId ? fig.nodes.get(symId) : undefined;
    const node: ResolvedNode = { type: "INSTANCE" };
    if (n.name) node.name = n.name;
    if (comp?.name) node.component = comp.name;
    if (n.size) node.size = `${Math.round(n.size.x)}x${Math.round(n.size.y)}`;
    const overrides: Array<{ text: string; x: number | null; y: number | null; fs: number | null }> = [];
    const propTexts: string[] = [];
    for (const o of n.symbolData?.symbolOverrides ?? []) {
      const ta = o.textData?.characters;
      if (typeof ta === "string" && ta.trim()) {
        const key = (o.guidPath?.guids ?? []).map(guidStr).join(">");
        const der = (n.derivedSymbolData ?? []).find(
          (d: any) => (d.guidPath?.guids ?? []).map(guidStr).join(">") === key,
        );
        overrides.push({
          text: ta.trim(),
          x: der?.derivedTextData?.baselines?.[0]?.position?.x ?? null,
          y: der?.derivedTextData?.baselines?.[0]?.position?.y ?? null,
          fs: der?.derivedTextData?.glyphs?.[0]?.fontSize ?? null,
        });
      }
      for (const a of o.componentPropAssignments ?? []) {
        const t = a?.value?.textValue?.characters ?? a?.varValue?.value?.textDataValue?.characters;
        if (typeof t === "string" && t.trim()) propTexts.push(t.trim());
      }
    }
    if (overrides.length) {
      overrides.sort((a, b) => (a.y ?? 0) - (b.y ?? 0) || (a.x ?? 0) - (b.x ?? 0));
      node.overrideTexts = overrides.map((o) => o.text);
    }
    if (propTexts.length) node.propTexts = [...new Set(propTexts)];
    if (depth < maxDepth && symId) {
      const kids: ResolvedNode[] = [];
      for (const kid of fig.kidsOf.get(symId) ?? []) {
        if (kids.length >= maxChildren) break;
        const r = resolveNode(kid, depth + 1);
        if (r) kids.push(r);
      }
      if (kids.length) node.children = kids;
    }
    return node;
  }

  function resolveNode(id: string, depth: number): ResolvedNode | null {
    const n = fig.nodes.get(id);
    if (!n || n.visible === false) return null;
    if (n.type === "INSTANCE") return resolveInstance(id, n, depth);
    const node: ResolvedNode = { type: n.type };
    if (n.name) node.name = n.name;
    if (n.size) node.size = `${Math.round(n.size.x)}x${Math.round(n.size.y)}`;
    if (typeof n.opacity === "number" && n.opacity < 1) node.opacity = Math.round(n.opacity * 100) / 100;
    if (n.cornerRadius) node.radius = n.cornerRadius;
    const fills = fillsOf(n);
    if (fills) node.fills = fills;
    if (n.type === "TEXT" && n.textData?.characters?.trim()) node.text = n.textData.characters.trim();
    if (depth < maxDepth) {
      const kids: ResolvedNode[] = [];
      for (const kid of fig.kidsOf.get(id) ?? []) {
        if (kids.length >= maxChildren) break;
        const r = resolveNode(kid, depth + 1);
        if (r) kids.push(r);
      }
      if (kids.length) node.children = kids;
    }
    return node;
  }

  return resolveNode(rootId, 0);
}
