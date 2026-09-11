// Figma URL parsing + local .fig file matching.
// Pure functions — unit-testable without network or Figma.

export interface ParsedFigmaUrl {
  /** file key from the URL path, e.g. "yjYH4KUp8nhHyU6bQO6798" */
  fileKey: string;
  /** sanitized name from the URL path, e.g. "-Sonic--Common" for "[Sonic] Common" */
  slug: string | null;
  /** node-id query param normalized to guid form, e.g. "470-25675" → "470:25675" */
  nodeId: string | null;
}

export function parseFigmaUrl(input: string): ParsedFigmaUrl | null {
  const s = String(input ?? "").trim();
  if (!s) return null;
  const m = /figma\.com\/(?:design|file|proto|board)\/([A-Za-z0-9]+)(?:\/([^?#]*))?/.exec(s);
  if (m) {
    const nodeId = /[?&]node-id=([0-9]+)[-:]([0-9]+)/.exec(s);
    return {
      fileKey: m[1],
      slug: m[2] ? m[2].replace(/\/+$/, "") : null,
      nodeId: nodeId ? `${nodeId[1]}:${nodeId[2]}` : null,
    };
  }
  // bare file key (Figma keys are long alphanumerics)
  if (/^[A-Za-z0-9]{12,}$/.test(s)) return { fileKey: s, slug: null, nodeId: null };
  return null;
}

/** lowercase + strip everything non-alphanumeric: "[Sonic] Common" and "-Sonic--Common" both → "soniccommon" */
export function normalizeName(s: string): string {
  return String(s ?? "").toLowerCase().replace(/[^a-z0-9]+/g, "");
}

export interface FigCandidate {
  path: string;
  /** file name to match against (meta.json file_name or the path stem) */
  fileName: string;
  /** secondary name (e.g. the other of meta file_name / path stem) — matches too */
  altName?: string;
}

/** candidates whose normalized name (or altName) equals the URL slug's; [] when no slug or no match */
export function matchFigFiles(candidates: FigCandidate[], url: ParsedFigmaUrl): FigCandidate[] {
  if (!url.slug) return [];
  const target = normalizeName(url.slug);
  if (!target) return [];
  return candidates.filter((c) => normalizeName(c.fileName) === target || (!!c.altName && normalizeName(c.altName) === target));
}
