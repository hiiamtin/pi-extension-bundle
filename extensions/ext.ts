// pi extension: /ext — toggle extensions, packages, skills, MCP servers, and tools
// (pi config compatible — edits the same settings.json structures:
//   sibling extensions   → packages[] object form with "-extensions/<name>.ts"
//   standalone extensions→ extensions[] with "-<abs path>" exact markers
//   external packages    → packages[] object form with { source, extensions: [], skills: [], ... }
//   package skills       → packages[] object form with "-skills/<rel>/SKILL.md" filters
//   user skills          → global skills[] with "-skills/<name>/SKILL.md" (rel to agent dir)
//   project skills       → .pi/settings.json skills[] with "-skills/<name>/SKILL.md"
//   MCP servers          → ~/.pi/agent/mcp.json per-server { disabled: true } overrides
//                           (list/toggle via pi-mcp-adapter's config loaders when installed)
//   tools                → runtime pi.setActiveTools() — session-scoped, applies instantly)
//
// Bare /ext opens a grouped picker (works in TUI and pi-web): pick entries to
// toggle them as PENDING changes (tools toggle instantly, session-scoped),
// "💾 Save & reload" applies + reloads once, and closing with pending changes
// asks save/discard. /ext <name> on|off stays for direct toggling.
// ext.ts cannot disable itself.

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { existsSync, mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { pathToFileURL } from "node:url";

type Ui = {
  notify: (msg: string, level: string) => void;
  select?: (title: string, options: string[]) => Promise<string | undefined>;
  input?: (title: string, placeholder?: string) => Promise<string | undefined>;
  confirm?: (title: string, message: string) => Promise<boolean>;
};
type PackageEntry =
  | string
  | {
      source: string;
      extensions?: string[];
      skills?: string[];
      prompts?: string[];
      themes?: string[];
    };
type SettingsShape = { packages?: PackageEntry[]; extensions?: string[]; skills?: string[] };

type RuntimeTool = {
  name: string;
  description?: string;
  sourceInfo?: { path?: string; source?: string; scope?: string; origin?: string };
};

// Minimal shape of pi-mcp-adapter's exported config module. Loaded dynamically
// when installed; everything degrades gracefully when absent.
type AdapterConfigModule = {
  loadMcpConfig: (overridePath?: string, cwd?: string) => { mcpServers?: Record<string, { disabled?: boolean }> };
  getServerProvenance: (overridePath?: string, cwd?: string) => Map<string, { kind?: string; path?: string }>;
};

const SELF_NAME = "ext";
const SAVE_OPTION = "💾 Save & reload";
const SEARCH_OPTION = "🔍 Search…";
const CLEAR_OPTION = "✏️ Clear filter";
const EXT_HEADER = "── Extensions ──";
const STANDALONE_HEADER = "── Standalone Extensions ──";
const PKG_HEADER = "── Packages (External) ──";
const SKILL_HEADER = "── Skills ──";
const MCP_HEADER = "── MCP Servers ──";
const MCP_MODULE = "pi-mcp-adapter/dist/config.js";

type ToggleItem = {
  key: string;
  name: string;
  kind: "extension" | "standalone" | "package" | "skill" | "mcp" | "tool";
  enabled: boolean;
  // skills: which settings store governs it and the baseDir-relative marker path
  scope?: "user" | "project" | "package";
  markerRel?: string;
  // packages and package skills
  packageSource?: string;
  // standalone extensions
  absPath?: string;
  // mcp servers: provenance label (user/project/import/plugin)
  mcpOrigin?: string;
  // tools: display grouping
  toolGroup?: string;
};

function agentDir(): string {
  const configured = process.env.PI_CODING_AGENT_DIR?.trim();
  if (!configured) return path.join(os.homedir(), ".pi", "agent");
  if (configured === "~") return os.homedir();
  if (configured.startsWith("~/")) return path.join(os.homedir(), configured.slice(2));
  return path.resolve(configured);
}

function globalSettingsFile(): string {
  return path.join(agentDir(), "settings.json");
}

function projectSettingsFile(): string {
  return path.join(process.cwd(), ".pi", "settings.json");
}

// Our own package root: the packages[] entry containing extensions/ext.ts.
// Sources may be absolute, cwd-relative, or relative to the settings file's
// dir (= agentDir for user settings) — try all bases.
function resolveSource(source: string): string {
  if (path.isAbsolute(source)) return source;
  const fromAgent = path.resolve(agentDir(), source);
  if (existsSync(fromAgent)) return fromAgent;
  return path.resolve(source);
}

function findOwnPackageRoot(packages: PackageEntry[]): string | null {
  for (const p of packages) {
    const source = typeof p === "string" ? p : p.source;
    // return the ORIGINAL source string so it still matches the settings entry
    if (existsSync(path.join(resolveSource(source), "extensions", "ext.ts"))) return source;
  }
  return null;
}

function resolvePackageRoot(source: string): string | null {
  if (typeof source !== "string") return null;
  const resolved = resolveSource(source);
  if (existsSync(resolved)) return resolved;
  if (source.startsWith("npm:")) {
    const name = source.slice(4);
    const candidates = [
      path.join(agentDir(), "npm", "node_modules", name),
      path.join(process.cwd(), ".pi", "npm", "node_modules", name),
    ];
    for (const c of candidates) if (existsSync(c)) return c;
  }
  return null; // git sources: whole-package toggle only
}

function readSettingsFile(file: string): SettingsShape {
  if (!existsSync(file)) return {};
  try {
    return JSON.parse(readFileSync(file, "utf8")) as SettingsShape;
  } catch {
    return {};
  }
}

function readGlobalSettings(): Required<SettingsShape> {
  const s = readSettingsFile(globalSettingsFile());
  return { packages: s.packages ?? [], extensions: s.extensions ?? [], skills: s.skills ?? [] };
}

function readProjectSettings(): Required<SettingsShape> {
  const s = readSettingsFile(projectSettingsFile());
  return { packages: s.packages ?? [], extensions: s.extensions ?? [], skills: s.skills ?? [] };
}

function writeSettingsFile(file: string, patch: SettingsShape): void {
  let raw: Record<string, unknown> = {};
  if (existsSync(file)) {
    try {
      raw = JSON.parse(readFileSync(file, "utf8")) as Record<string, unknown>;
    } catch {
      throw new Error(`cannot parse ${file} — fix it manually first`);
    }
  }
  if (patch.packages !== undefined) raw.packages = patch.packages;
  if (patch.extensions !== undefined) raw.extensions = patch.extensions;
  if (patch.skills !== undefined) raw.skills = patch.skills;
  mkdirSync(path.dirname(file), { recursive: true });
  writeFileSync(file, JSON.stringify(raw, null, 2) + "\n");
}

function findPackageEntry(packages: PackageEntry[], root: string): { index: number; entry: PackageEntry } | null {
  const index = packages.findIndex((p) => (typeof p === "string" ? p : p.source) === root);
  if (index === -1) return null;
  return { index, entry: packages[index] };
}

// ---------- extension toggles (own package) ----------

function extensionEnabled(packages: PackageEntry[], root: string | null, name: string): boolean {
  if (!root) return true;
  const found = findPackageEntry(packages, root);
  if (!found) return true;
  const raw = found.entry;
  if (typeof raw === "string") return true;
  return !(raw.extensions ?? []).includes(`-extensions/${name}.ts`);
}

function setExtension(packages: PackageEntry[], root: string, name: string, enabled: boolean): void {
  const found = findPackageEntry(packages, root);
  if (!found) throw new Error(`package ${root} not found in settings.json`);
  const { index, entry: raw } = found;
  const entry = typeof raw === "string" ? { source: raw, extensions: [] as string[] } : { ...raw, extensions: [...(raw.extensions ?? [])] };
  const marker = `-extensions/${name}.ts`;
  if (enabled) entry.extensions = entry.extensions.filter((e) => e !== marker);
  else if (!entry.extensions.includes(marker)) entry.extensions.push(marker);

  // object form with no exclusions == plain string form; keep it canonical
  const hasOtherExclusions = Boolean(
    (entry.skills && entry.skills.length > 0) ||
    (entry.prompts && entry.prompts.length > 0) ||
    (entry.themes && entry.themes.length > 0)
  );
  packages[index] = (entry.extensions.length > 0 || hasOtherExclusions) ? entry : entry.source;
}

// ---------- standalone extension toggles (settings.extensions[]) ----------

// pi matches exact markers against both the abs path and the path relative to
// the settings base dir — recognize every form pi itself may have written.
function standaloneMarkers(absPath: string): string[] {
  const rel = path.relative(agentDir(), absPath);
  return [`-${absPath}`, `!${absPath}`, ...(rel && !rel.startsWith("..") ? [`-${rel}`, `!${rel}`] : [])];
}

function standaloneEnabled(entries: string[], absPath: string): boolean {
  return !entries.some((e) => standaloneMarkers(absPath).includes(e));
}

function setStandaloneExtension(entries: string[], absPath: string, enabled: boolean): void {
  const markers = standaloneMarkers(absPath);
  const filtered = entries.filter((e) => !markers.includes(e));
  if (!enabled) filtered.push(`-${absPath}`);
  entries.length = 0;
  entries.push(...filtered);
}

// ---------- package toggles ----------

function packageEnabled(entry: PackageEntry): boolean {
  if (typeof entry === "string") return true;
  // If all resources are explicitly empty arrays, it's fully disabled
  const extDisabled = Array.isArray(entry.extensions) && entry.extensions.length === 0;
  const skillDisabled = Array.isArray(entry.skills) && entry.skills.length === 0;
  return !(extDisabled && skillDisabled);
}

function setPackage(packages: PackageEntry[], source: string, enabled: boolean): void {
  const found = findPackageEntry(packages, source);
  if (!found) throw new Error(`package ${source} not found in settings.json`);
  const { index } = found;
  if (enabled) {
    packages[index] = source;
  } else {
    packages[index] = {
      source,
      extensions: [],
      skills: [],
      prompts: [],
      themes: [],
    };
  }
}

// ---------- skill toggles ----------

function skillMarkerEnabled(markers: string[], markerRel: string): boolean {
  return !markers.includes(`-${markerRel}`);
}

function setSkillMarker(markers: string[], markerRel: string, enabled: boolean): void {
  const marker = `-${markerRel}`;
  const filtered = markers.filter((m) => m !== marker);
  if (!enabled) filtered.push(marker);
  markers.length = 0;
  markers.push(...filtered);
}

function setPackageSkill(packages: PackageEntry[], source: string, markerRel: string, enabled: boolean): void {
  const found = findPackageEntry(packages, source);
  if (!found) throw new Error(`package ${source} not found in settings.json`);
  const { index, entry: raw } = found;
  const entry = typeof raw === "string" ? { source: raw, skills: [] as string[] } : { ...raw, skills: [...(raw.skills ?? [])] };
  const marker = `-${markerRel}`;
  if (enabled) entry.skills = entry.skills.filter((s) => s !== marker);
  else if (!entry.skills.includes(marker)) entry.skills.push(marker);

  const hasOtherExclusions = Boolean(
    (entry.extensions && entry.extensions.length > 0) ||
    (entry.prompts && entry.prompts.length > 0) ||
    (entry.themes && entry.themes.length > 0)
  );
  packages[index] = (entry.skills.length > 0 || hasOtherExclusions) ? entry : entry.source;
}

// ---------- skill discovery ----------

type SkillRef = { name: string; rel: string };

function hasSkillFrontmatter(file: string): string | null {
  // Returns the skill name (or fallback) when the .md declares skill frontmatter
  // with a non-empty description — pi only loads root .md files like that.
  try {
    const head = readFileSync(file, "utf8").slice(0, 1024);
    const match = head.match(/^---\r?\n([\s\S]*?)\r?\n---/);
    if (!match) return null;
    const fm = match[1];
    const description = fm.match(/^description:\s*(.+)$/m)?.[1]?.trim();
    if (!description) return null;
    return fm.match(/^name:\s*(\S+)/m)?.[1]?.trim() || path.basename(file).replace(/\.md$/, "");
  } catch {
    return null;
  }
}

function scanSkillDir(root: string, relPrefix: string, allowRootMd: boolean, out: SkillRef[]): void {
  if (!existsSync(root) || !statSync(root).isDirectory()) return;
  if (relPrefix !== "" && existsSync(path.join(root, "SKILL.md"))) {
    out.push({ name: path.basename(root), rel: path.join(relPrefix, "SKILL.md") });
    return; // skill root: do not recurse further (matches pi discovery)
  }
  const entries = readdirSync(root, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name));
  for (const e of entries) {
    if (e.name.startsWith(".")) continue;
    if (e.isDirectory()) {
      scanSkillDir(path.join(root, e.name), path.join(relPrefix, e.name), allowRootMd, out);
    } else if (allowRootMd && e.isFile() && e.name.endsWith(".md") && e.name !== "SKILL.md") {
      const name = hasSkillFrontmatter(path.join(root, e.name));
      if (name) out.push({ name, rel: path.join(relPrefix, e.name) });
    }
  }
}

function listUserSkillRefs(): { refs: SkillRef[]; baseDir: string }[] {
  return [
    { root: path.join(agentDir(), "skills"), baseDir: agentDir(), allowRootMd: true },
    { root: path.join(os.homedir(), ".agents", "skills"), baseDir: path.join(os.homedir(), ".agents"), allowRootMd: false },
  ]
    .map(({ root, baseDir, allowRootMd }) => {
      const refs: SkillRef[] = [];
      scanSkillDir(root, path.relative(baseDir, root), allowRootMd, refs);
      return { refs, baseDir };
    })
    .filter((g) => g.refs.length > 0);
}

function ancestorGitRoot(start: string): string | null {
  let dir = path.resolve(start);
  for (;;) {
    if (existsSync(path.join(dir, ".git"))) return dir;
    const parent = path.dirname(dir);
    if (parent === dir) return null;
    dir = parent;
  }
}

function listProjectSkillRefs(): { refs: SkillRef[]; baseDir: string }[] {
  const cwd = process.cwd();
  const groups: { refs: SkillRef[]; baseDir: string }[] = [];
  // cwd/.pi/skills (baseDir = <cwd>/.pi, root .md files allowed)
  {
    const refs: SkillRef[] = [];
    const piDir = path.join(cwd, ".pi");
    scanSkillDir(path.join(piDir, "skills"), "skills", true, refs);
    if (refs.length > 0) groups.push({ refs, baseDir: piDir });
  }
  // .agents/skills in cwd + ancestors up to git root (root .md ignored)
  const userAgentsSkills = path.join(os.homedir(), ".agents", "skills");
  const stop = ancestorGitRoot(cwd) ?? path.parse(cwd).root;
  let dir = path.resolve(cwd);
  for (;;) {
    const skillsDir = path.join(dir, ".agents", "skills");
    if (path.resolve(skillsDir) !== path.resolve(userAgentsSkills)) {
      const refs: SkillRef[] = [];
      scanSkillDir(skillsDir, "skills", false, refs);
      if (refs.length > 0) groups.push({ refs, baseDir: path.join(dir, ".agents") });
    }
    if (path.resolve(dir) === path.resolve(stop)) break;
    const parent = path.dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  return groups;
}

function packageSkillRefs(pkgRoot: string): SkillRef[] {
  const refs: SkillRef[] = [];
  let manifestEntries: string[] | null = null;
  const manifestPath = path.join(pkgRoot, "package.json");
  if (existsSync(manifestPath)) {
    try {
      const manifest = JSON.parse(readFileSync(manifestPath, "utf8")) as { pi?: { skills?: string[] } };
      if (Array.isArray(manifest.pi?.skills)) manifestEntries = manifest.pi!.skills!;
    } catch {
      // fall through to convention dir
    }
  }
  const entries = manifestEntries ?? (existsSync(path.join(pkgRoot, "skills")) ? ["./skills"] : []);
  for (const raw of entries) {
    if (raw.startsWith("!") || raw.startsWith("+") || raw.startsWith("-")) continue; // patterns: skip
    const abs = path.resolve(pkgRoot, raw);
    const relDir = path.relative(pkgRoot, abs);
    if (!relDir || relDir.startsWith("..")) continue;
    if (existsSync(abs) && statSync(abs).isDirectory()) {
      scanSkillDir(abs, relDir, true, refs);
    } else if (abs.endsWith(".md") && existsSync(abs)) {
      const name = hasSkillFrontmatter(abs);
      if (name) refs.push({ name, rel: relDir });
    }
  }
  return refs;
}

// ---------- MCP servers ----------

let adapterModuleCache: Promise<AdapterConfigModule | null> | null = null;

function adapterConfigModule(): Promise<AdapterConfigModule | null> {
  adapterModuleCache ??= (async () => {
    const candidates = [
      path.join(agentDir(), "npm", "node_modules", MCP_MODULE),
      path.join(process.cwd(), ".pi", "npm", "node_modules", MCP_MODULE),
    ];
    for (const p of candidates) {
      if (!existsSync(p)) continue;
      try {
        return (await import(pathToFileURL(p).href)) as AdapterConfigModule;
      } catch {
        // try next candidate
      }
    }
    return null;
  })();
  return adapterModuleCache;
}

async function collectMcpItems(): Promise<ToggleItem[]> {
  const mod = await adapterConfigModule();
  if (!mod) return [];
  try {
    const cwd = process.cwd();
    const cfg = mod.loadMcpConfig(undefined, cwd);
    const provenance = mod.getServerProvenance(undefined, cwd);
    return Object.entries(cfg.mcpServers ?? {}).map(([name, entry]) => ({
      key: `mcp:${name}`,
      name,
      kind: "mcp" as const,
      enabled: entry?.disabled !== true,
      mcpOrigin: provenance.get(name)?.kind ?? "plugin",
    }));
  } catch {
    return [];
  }
}

// Toggle lives in the user-level pi config (~/.pi/agent/mcp.json): the pi-global
// layer out-ranks shared configs, host configs, and package/plugin definitions,
// so a minimal { disabled: true } partial is enough without copying credentials.
function setMcpServerDisabled(name: string, disabled: boolean): void {
  const file = path.join(agentDir(), "mcp.json");
  let raw: { mcpServers?: Record<string, Record<string, unknown>> } = {};
  if (existsSync(file)) {
    try {
      raw = JSON.parse(readFileSync(file, "utf8"));
    } catch {
      throw new Error(`cannot parse ${file} — fix it manually first`);
    }
  }
  const servers = { ...(raw.mcpServers ?? {}) };
  const entry = { ...(servers[name] ?? {}) };
  if (disabled) {
    entry.disabled = true;
  } else {
    delete entry.disabled;
    if (Object.keys(entry).length === 0) delete servers[name]; // pure override: drop it
  }
  if (Object.keys(entry).length > 0) servers[name] = entry;
  raw.mcpServers = servers;
  mkdirSync(path.dirname(file), { recursive: true });
  writeFileSync(file, JSON.stringify(raw, null, 2) + "\n");
}

// ---------- tools (runtime, session-scoped) ----------

let extensionApi: ExtensionAPI | null = null;

function toolGroupOf(tool: RuntimeTool): string {
  const si = tool.sourceInfo;
  if (!si || si.source === "builtin") return "built-in";
  const p = si.path ?? "";
  if (p.includes("pi-mcp-adapter")) return "mcp";
  if (p && !p.startsWith("<")) {
    const base = path.basename(p).replace(/\.tsx?$/, "");
    if (base) return base;
  }
  return si.source || "other";
}

function collectToolItems(): ToggleItem[] {
  if (!extensionApi) return [];
  let all: RuntimeTool[] = [];
  let active: string[] = [];
  try {
    all = ((extensionApi as unknown as { getAllTools?: () => RuntimeTool[] }).getAllTools?.() ?? []) as RuntimeTool[];
    active = (extensionApi as unknown as { getActiveTools?: () => string[] }).getActiveTools?.() ?? [];
  } catch {
    return [];
  }
  const activeSet = new Set(active);
  return all
    .filter((t) => t && t.name)
    .map((t) => ({
      key: `tool:${t.name}`,
      name: t.name,
      kind: "tool" as const,
      enabled: activeSet.has(t.name),
      toolGroup: toolGroupOf(t),
    }));
}

function setToolEnabled(name: string, enabled: boolean): void {
  const api = extensionApi as unknown as {
    getActiveTools?: () => string[];
    setActiveTools?: (names: string[]) => void;
  };
  const active = new Set(api.getActiveTools?.() ?? []);
  if (enabled) active.add(name);
  else active.delete(name);
  api.setActiveTools?.([...active]);
}

// ---------- item collection ----------

function collectItems(packages: PackageEntry[], extensions: string[], skills: string[], projectSkills: string[]): { root: string | null; items: ToggleItem[] } {
  const root = findOwnPackageRoot(packages);
  const items: ToggleItem[] = [];

  // 1. Sibling extensions in own package
  const extDir = root ? path.join(resolveSource(root), "extensions") : null;
  if (extDir && existsSync(extDir)) {
    for (const f of readdirSync(extDir).filter((f) => f.endsWith(".ts")).sort()) {
      const n = f.replace(/\.ts$/, "");
      items.push({ key: `ext:${n}`, name: n, kind: "extension", enabled: extensionEnabled(packages, root, n) });
    }
  }

  // 2. Standalone extensions from settings.extensions[] (e.g. ~/.hindsight/.../pi.js)
  for (const raw of extensions) {
    if (raw.startsWith("-") || raw.startsWith("+") || raw.startsWith("!")) continue;
    const abs = path.isAbsolute(raw) ? raw : resolveSource(raw);
    // last 3 path segments make the entry recognizable (e.g. coding-agents/dist/pi.js)
    const segs = abs.split(path.sep).filter(Boolean);
    const label = segs.slice(-3).join("/");
    items.push({ key: `standalone:${abs}`, name: label, kind: "standalone", enabled: standaloneEnabled(extensions, abs), absPath: abs });
  }

  // 3. External packages (other than our own package root)
  for (const p of packages) {
    const src = typeof p === "string" ? p : p.source;
    if (src === root) continue;
    items.push({
      key: `pkg:${src}`,
      name: getPackageDisplayName(src),
      kind: "package",
      enabled: packageEnabled(p),
      packageSource: src,
    });
  }

  // 4. Skills — user, project, and package scopes
  const seenSkills = new Set<string>();
  const pushSkill = (name: string, scope: "user" | "project" | "package", markers: string[], markerRel: string, packageSource?: string) => {
    if (seenSkills.has(`${scope}:${name}`)) return;
    seenSkills.add(`${scope}:${name}`);
    items.push({
      key: `skill:${scope}:${name}`,
      name,
      kind: "skill",
      enabled: skillMarkerEnabled(markers, markerRel),
      scope,
      markerRel,
      packageSource,
    });
  };
  for (const group of listUserSkillRefs()) {
    for (const ref of group.refs) pushSkill(ref.name, "user", skills, ref.rel);
  }
  for (const group of listProjectSkillRefs()) {
    for (const ref of group.refs) pushSkill(ref.name, "project", projectSkills, ref.rel);
  }
  for (const p of packages) {
    const src = typeof p === "string" ? p : p.source;
    const pkgRoot = resolvePackageRoot(src);
    if (!pkgRoot) continue;
    const entry = typeof p === "string" ? undefined : p;
    for (const ref of packageSkillRefs(pkgRoot)) {
      items.push({
        key: `skill:pkg:${src}::${ref.rel}`,
        name: ref.name,
        kind: "skill",
        enabled: !(entry?.skills ?? []).includes(`-${ref.rel}`),
        scope: "package",
        markerRel: ref.rel,
        packageSource: src,
      });
      seenSkills.add(`package:${ref.name}`);
    }
  }

  return { root, items };
}

function getPackageDisplayName(source: string): string {
  if (source.startsWith("npm:")) return source.slice(4);
  if (source.startsWith("git:")) return source.slice(4).split("/").pop() ?? source;
  return path.basename(source);
}

// ---------- applying pending changes ----------

type PendingChange = { item: ToggleItem; enabled: boolean };

function applyPending(pending: Map<string, PendingChange>): void {
  const globalSettings = readGlobalSettings();
  let projectSettings: Required<SettingsShape> | null = null;
  const mcpChanges: Array<[string, boolean]> = [];
  const root = findOwnPackageRoot(globalSettings.packages);

  for (const { item, enabled } of pending.values()) {
    switch (item.kind) {
      case "extension":
        if (!root) throw new Error("cannot locate own package root in settings.json");
        setExtension(globalSettings.packages, root, item.name, enabled);
        break;
      case "standalone":
        setStandaloneExtension(globalSettings.extensions, item.absPath!, enabled);
        break;
      case "package":
        setPackage(globalSettings.packages, item.packageSource!, enabled);
        break;
      case "skill":
        if (item.scope === "user") {
          setSkillMarker(globalSettings.skills, item.markerRel!, enabled);
        } else if (item.scope === "project") {
          projectSettings ??= readProjectSettings();
          setSkillMarker(projectSettings.skills, item.markerRel!, enabled);
        } else {
          setPackageSkill(globalSettings.packages, item.packageSource!, item.markerRel!, enabled);
        }
        break;
      case "mcp":
        mcpChanges.push([item.name, enabled]);
        break;
      case "tool":
        break; // handled live, never persisted
    }
  }

  writeSettingsFile(globalSettingsFile(), globalSettings);
  if (projectSettings) writeSettingsFile(projectSettingsFile(), projectSettings);
  for (const [name, enabled] of mcpChanges) setMcpServerDisabled(name, !enabled);
}

// ---------- command ----------

export default function extToggleExtension(pi: ExtensionAPI): void {
  extensionApi = pi;

  // getArgumentCompletions runs on every keystroke: cache the (read-only) scan
  // result for a moment instead of rescanning settings + skill dirs each time.
  // The picker always bypasses the cache so it reflects on-disk state now.
  let syncCache: { at: number; root: string | null; items: ToggleItem[] } | null = null;
  const collectAllSync = (bypassCache = false): { root: string | null; items: ToggleItem[] } => {
    if (!bypassCache && syncCache && Date.now() - syncCache.at < 1000) return { root: syncCache.root, items: syncCache.items };
    const g = readGlobalSettings();
    const p = readProjectSettings();
    const { root, items } = collectItems(g.packages, g.extensions, g.skills, p.skills);
    syncCache = { at: Date.now(), root, items };
    return { root, items };
  };

  const collectAll = async (): Promise<{ root: string | null; items: ToggleItem[] }> => {
    const base = collectAllSync(true);
    const mcpItems = await collectMcpItems();
    return { root: base.root, items: [...base.items, ...mcpItems, ...collectToolItems()] };
  };

  pi.registerCommand("ext", {
    description: "Enable/disable extensions, packages, skills, MCP servers, and tools. /ext opens a picker; /ext <name> on|off for direct toggle",
    getArgumentCompletions: (prefix: string) => {
      // Read-only: settings reads + directory scans + cached MCP list only.
      const normalized = prefix.trimStart();
      const argumentMatch = normalized.match(/^(\S+)\s+(\S*)$/);
      if (!argumentMatch) {
        const { items } = collectAllSync();
        const all = [...items, ...collectToolItems()]; // mcp items appear once cached by the picker
        const entries = all
          .filter((i) => i.name.startsWith(normalized))
          .slice(0, 8)
          .map((i) => ({ value: i.name, label: `${i.name} — ${describeItem(i)}` }));
        return entries.length > 0 ? entries : null;
      }
      // Level 2: on|off for the chosen item
      const [, name, actionPrefix] = argumentMatch;
      if (actionPrefix === undefined) return null;
      const values = ["on", "off"]
        .filter((v) => v.startsWith(actionPrefix.trimStart()))
        .map((v) => ({ value: `${name} ${v}`, label: `${v} — ${v === "on" ? "Enable" : "Disable"} ${name}` }));
      return values.length > 0 ? values : null;
    },
    handler: async (args: string, ctx: { ui: Ui; reload: () => Promise<void> }) => {
      const [name, action] = args.trim().split(/\s+/).filter(Boolean);

      // direct toggle path
      if (name) {
        if (name === SELF_NAME) {
          ctx.ui.notify("cannot disable /ext itself (it is the toggle UI)", "error");
          return;
        }
        const { items } = await collectAll();
        const item = items.find((i) => i.name === name || i.key === name || (i.packageSource && i.packageSource === name));
        if (!item) {
          ctx.ui.notify(`unknown: ${name} (${items.map((i) => i.name).join(", ") || "none"})`, "error");
          return;
        }
        if (action !== "on" && action !== "off") {
          ctx.ui.notify("usage: /ext <name> on|off  (bare /ext opens the picker)", "error");
          return;
        }
        if (item.kind === "tool") {
          setToolEnabled(item.name, action === "on");
          ctx.ui.notify(`${item.name}: ${action === "on" ? "enabled" : "disabled"} (this session)`, "info");
          return;
        }
        const pending = new Map<string, PendingChange>([[item.key, { item, enabled: action === "on" }]]);
        applyPending(pending);
        ctx.ui.notify(`${item.name}: ${action === "on" ? "enabled" : "disabled"} — reloading…`, "info");
        await ctx.reload();
        return;
      }

      // interactive picker loop
      if (!ctx.ui.select) {
        ctx.ui.notify("interactive picker unavailable in this mode — use /ext <name> on|off", "error");
        return;
      }
      const pending = new Map<string, PendingChange>();
      let filter = "";
      const dirty = () => pending.size > 0;

      for (;;) {
        const { items } = await collectAll();
        const effective = items
          .map((i) => ({ ...i, enabled: pending.get(i.key)?.enabled ?? i.enabled }))
          .filter((i) => !filter || i.name.toLowerCase().includes(filter.toLowerCase()));

        // options and map stay index-aligned: headers are null, actions are {action}
        type Pickable = ToggleItem | { action: "search" | "clear" | "save" };
        const options: string[] = [];
        const map: Array<Pickable | null> = [];
        const push = (option: string, pickable: Pickable | null = null) => { options.push(option); map.push(pickable); };

        const section = (header: string, sectionItems: ToggleItem[]) => {
          if (sectionItems.length === 0) return;
          push(header);
          for (const i of sectionItems) push(optionLabel(i), i);
        };

        section(EXT_HEADER, effective.filter((i) => i.kind === "extension"));
        section(STANDALONE_HEADER, effective.filter((i) => i.kind === "standalone"));
        section(PKG_HEADER, effective.filter((i) => i.kind === "package"));
        section(SKILL_HEADER, effective.filter((i) => i.kind === "skill"));
        section(MCP_HEADER, effective.filter((i) => i.kind === "mcp"));

        // tools grouped by origin: built-in first, then mcp, then the rest
        const tools = effective.filter((i) => i.kind === "tool");
        const groups = [...new Set(tools.map((t) => t.toolGroup ?? "other"))].sort((a, b) => {
          const rank = (g: string) => (g === "built-in" ? 0 : g === "mcp" ? 1 : 2);
          return rank(a) - rank(b) || a.localeCompare(b);
        });
        for (const g of groups) section(`── Tools: ${g} ──`, tools.filter((t) => t.toolGroup === g));

        if (filter) push(CLEAR_OPTION, { action: "clear" });
        push(SEARCH_OPTION, { action: "search" });
        if (dirty()) push(`${SAVE_OPTION} (${pending.size})`, { action: "save" });

        const title = `Toggle extensions/packages/skills/mcp/tools${filter ? ` — filter: "${filter}"` : ""}${dirty() ? ` — ${pending.size} unsaved` : ""}`;
        const choice = await ctx.ui.select(title, options);
        if (!choice) break;

        const picked = map[options.indexOf(choice)];
        if (!picked) continue; // section header
        if ("action" in picked) {
          if (picked.action === "search") {
            const q = await ctx.ui.input?.("Filter by name (empty = show all)", filter);
            filter = (q ?? "").trim();
          } else if (picked.action === "clear") {
            filter = "";
          } else {
            applyPending(pending);
            ctx.ui.notify(`${pending.size} change(s) saved — reloading…`, "info");
            await ctx.reload();
            return;
          }
          continue;
        }
        if (picked.kind === "extension" && picked.name === SELF_NAME) {
          ctx.ui.notify("cannot disable /ext itself (it is the toggle UI)", "warning");
          continue;
        }
        // tools apply instantly (session-scoped) instead of queueing a save
        if (picked.kind === "tool") {
          const next = !picked.enabled;
          setToolEnabled(picked.name, next);
          ctx.ui.notify(`${picked.name}: ${next ? "enabled" : "disabled"} (this session)`, "info");
          continue;
        }
        const next = !picked.enabled;
        // toggling back to the on-disk value cancels the pending change
        const onDisk = items.find((i) => i.key === picked.key)?.enabled ?? picked.enabled;
        if (next === onDisk) pending.delete(picked.key);
        else pending.set(picked.key, { item: picked, enabled: next });
      }

      if (dirty()) {
        const save = await ctx.ui.confirm?.("Unsaved changes", `${pending.size} toggle(s) not saved — save & reload now?`);
        if (save) {
          applyPending(pending);
          ctx.ui.notify(`${pending.size} change(s) saved — reloading…`, "info");
          await ctx.reload();
          return;
        }
        ctx.ui.notify("discarded (settings unchanged)", "info");
      }
    },
  });
}

function describeItem(i: ToggleItem): string {
  switch (i.kind) {
    case "extension":
      return `extension${i.enabled ? " (enabled)" : " (disabled)"}`;
    case "standalone":
      return `extension (settings)${i.enabled ? " (enabled)" : " (disabled)"}`;
    case "package":
      return `package${i.enabled ? " (enabled)" : " (disabled)"}`;
    case "skill":
      return `skill (${i.scope ?? "user"})${i.enabled ? " (enabled)" : " (disabled)"}`;
    case "mcp":
      return `mcp server (${i.mcpOrigin ?? "config"})${i.enabled ? " (enabled)" : " (disabled)"}`;
    case "tool":
      return `tool (${i.toolGroup ?? "runtime"}, session toggle)${i.enabled ? " (active)" : " (inactive)"}`;
  }
}

function optionLabel(i: ToggleItem): string {
  return `${i.enabled ? "✓" : "✗"} ${i.name} — ${describeItem(i)}`;
}

export { extToggleExtension };
