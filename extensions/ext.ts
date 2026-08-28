// pi extension: /ext — toggle sibling extensions, external packages, AND local skills
// (pi config compatible — edits the same settings.json structures:
//   sibling extensions → packages[] object form with "-extensions/<name>.ts"
//   external packages  → packages[] object form with { source, extensions: [], skills: [], ... }
//   skills             → top-level skills[] with "-skills/<name>/SKILL.md")
//
// Bare /ext opens a grouped picker (works in TUI and pi-web): pick entries to
// toggle them as PENDING changes, "💾 Save & reload" applies + reloads once,
// and closing with pending changes asks save/discard. /ext <name> on|off stays
// for direct toggling. ext.ts cannot disable itself.

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { existsSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

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

const SETTINGS_FILE = () => path.join(os.homedir(), ".pi/agent/settings.json");
// pi's user-level skills root is the cross-agent convention dir ~/.agents/skills
// (NOT ~/.pi/agent/skills). Settings overrides use "-skills/<name>/SKILL.md"
// relative to that root.
const SKILLS_DIR = () => path.join(os.homedir(), ".agents", "skills");
const SELF_NAME = "ext";
const SAVE_OPTION = "💾 Save & reload";
const SEARCH_OPTION = "🔍 Search…";
const CLEAR_OPTION = "✏️ Clear filter";
const EXT_HEADER = "── Extensions ──";
const PKG_HEADER = "── Packages (External) ──";
const SKILL_HEADER = "── Skills ──";

type ToggleItem = {
  key: string;
  name: string;
  kind: "extension" | "package" | "skill";
  enabled: boolean;
  packageSource?: string;
};

// Our own package root: the packages[] entry containing extensions/ext.ts.
// Works for local-path (VM) and git installs (~/.pi/agent/git/...) alike.
function findOwnPackageRoot(packages: PackageEntry[]): string | null {
  for (const p of packages) {
    const source = typeof p === "string" ? p : p.source;
    if (existsSync(path.join(source, "extensions", "ext.ts"))) return source;
  }
  return null;
}

function listExtensions(root: string | null): string[] {
  if (!root) return [];
  const dir = path.join(root, "extensions");
  if (!existsSync(dir)) return [];
  return readdirSync(dir).filter((f) => f.endsWith(".ts")).map((f) => f.replace(/\.ts$/, "")).sort();
}

function listSkills(): string[] {
  const dir = SKILLS_DIR();
  if (!existsSync(dir)) return [];
  return readdirSync(dir, { withFileTypes: true }).filter((d) => d.isDirectory() && existsSync(path.join(dir, d.name, "SKILL.md"))).map((d) => d.name).sort();
}

function readSettings(): { packages: PackageEntry[]; skills: string[] } {
  const settings = JSON.parse(readFileSync(SETTINGS_FILE(), "utf8")) as { packages?: PackageEntry[]; skills?: string[] };
  return { packages: settings.packages ?? [], skills: settings.skills ?? [] };
}

function writeSettings(settings: { packages?: PackageEntry[]; skills?: string[] }): void {
  const raw = JSON.parse(readFileSync(SETTINGS_FILE(), "utf8")) as Record<string, unknown>;
  raw.packages = settings.packages;
  raw.skills = settings.skills;
  writeFileSync(SETTINGS_FILE(), JSON.stringify(raw, null, 2) + "\n");
}

function findPackageEntry(packages: PackageEntry[], root: string): { index: number; entry: PackageEntry } | null {
  const index = packages.findIndex((p) => (typeof p === "string" ? p : p.source) === root);
  if (index === -1) return null;
  return { index, entry: packages[index] };
}

function extensionEnabled(packages: PackageEntry[], root: string | null, name: string): boolean {
  if (!root) return true;
  const found = findPackageEntry(packages, root);
  if (!found) return true;
  const raw = found.entry;
  if (typeof raw === "string") return true;
  return !(raw.extensions ?? []).includes(`-extensions/${name}.ts`);
}

function packageEnabled(entry: PackageEntry): boolean {
  if (typeof entry === "string") return true;
  // If all resources are explicitly empty arrays, it's fully disabled
  const extDisabled = Array.isArray(entry.extensions) && entry.extensions.length === 0;
  const skillDisabled = Array.isArray(entry.skills) && entry.skills.length === 0;
  return !(extDisabled && skillDisabled);
}

function skillEnabled(skills: string[], name: string): boolean {
  return !skills.includes(`-skills/${name}/SKILL.md`);
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

function setSkill(skills: string[], name: string, enabled: boolean): void {
  const marker = `-skills/${name}/SKILL.md`;
  const filtered = skills.filter((s) => s !== marker);
  if (!enabled) filtered.push(marker);
  skills.length = 0;
  skills.push(...filtered);
}

function getPackageDisplayName(source: string): string {
  if (source.startsWith("npm:")) return source.slice(4);
  if (source.startsWith("git:")) return source.slice(4).split("/").pop() ?? source;
  return path.basename(source);
}

function collectItems(packages: PackageEntry[], skills: string[]): { root: string | null; items: ToggleItem[] } {
  const root = findOwnPackageRoot(packages);
  const items: ToggleItem[] = [];

  // 1. Sibling extensions in own package
  for (const n of listExtensions(root)) {
    items.push({
      key: `ext:${n}`,
      name: n,
      kind: "extension",
      enabled: extensionEnabled(packages, root, n),
    });
  }

  // 2. External packages (other than our own package root)
  for (const p of packages) {
    const src = typeof p === "string" ? p : p.source;
    if (src === root) continue;
    const name = getPackageDisplayName(src);
    items.push({
      key: `pkg:${src}`,
      name,
      kind: "package",
      enabled: packageEnabled(p),
      packageSource: src,
    });
  }

  // 3. Top-level skills in ~/.agents/skills
  // (package skills like the adapter's mcp-scripting live under the package and are
  //  toggled together with that package; package-level skills options would need
  //  glob support and are intentionally out of scope for the picker)
  for (const n of listSkills()) {
    items.push({
      key: `skill:${n}`,
      name: n,
      kind: "skill",
      enabled: skillEnabled(skills, n),
    });
  }

  return { root, items };
}

function applyPending(pending: Map<string, boolean>): void {
  const settings = readSettings();
  const root = findOwnPackageRoot(settings.packages);
  for (const [key, enabled] of pending) {
    const colonIdx = key.indexOf(":");
    const prefix = key.slice(0, colonIdx);
    const nameOrSrc = key.slice(colonIdx + 1);
    if (prefix === "ext") {
      if (!root) throw new Error("cannot locate own package root in settings.json");
      setExtension(settings.packages, root, nameOrSrc, enabled);
    } else if (prefix === "pkg") {
      setPackage(settings.packages, nameOrSrc, enabled);
    } else if (prefix === "skill") {
      setSkill(settings.skills, nameOrSrc, enabled);
    }
  }
  writeSettings(settings);
}

export default function extToggleExtension(pi: ExtensionAPI): void {
  pi.registerCommand("ext", {
    description: "Enable/disable extensions, packages, and skills (same store as pi config). /ext opens a picker; /ext <name> on|off for direct toggle",
    getArgumentCompletions: (prefix: string) => {
      const normalized = prefix.trimStart();
      const argumentMatch = normalized.match(/^(\S+)\s+(\S*)$/);
      if (!argumentMatch) {
        // Level 1: item names (extensions, packages, skills) from the current settings
        const { packages, skills } = readSettings();
        const { items } = collectItems(packages, skills);
        const entries = items
          .filter((i) => i.name.startsWith(normalized))
          .map((i) => ({
            value: i.name,
            label: `${i.name} — ${i.kind}${i.enabled ? " (enabled)" : " (disabled)"}`,
          }));
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
        const { packages, skills } = readSettings();
        const { root, items } = collectItems(packages, skills);
        const item = items.find((i) => i.name === name || (i.packageSource && i.packageSource === name));
        if (!item) {
          ctx.ui.notify(`unknown: ${name} (${items.map((i) => i.name).join(", ") || "none"})`, "error");
          return;
        }
        if (action !== "on" && action !== "off") {
          ctx.ui.notify("usage: /ext <name> on|off  (bare /ext opens the picker)", "error");
          return;
        }
        if (item.kind === "extension") {
          if (!root) throw new Error("cannot locate own package root in settings.json");
          setExtension(packages, root, item.name, action === "on");
        } else if (item.kind === "package") {
          setPackage(packages, item.packageSource!, action === "on");
        } else {
          setSkill(skills, item.name, action === "on");
        }
        writeSettings({ packages, skills });
        ctx.ui.notify(`${item.name}: ${action === "on" ? "enabled" : "disabled"} — reloading…`, "info");
        await ctx.reload();
        return;
      }

      // interactive picker loop
      if (!ctx.ui.select) {
        ctx.ui.notify("interactive picker unavailable in this mode — use /ext <name> on|off", "error");
        return;
      }
      const pending = new Map<string, boolean>();
      let filter = "";
      const dirty = () => pending.size > 0;

      for (;;) {
        const { packages, skills } = readSettings();
        const { items } = collectItems(packages, skills);
        const effective = items
          .map((i) => ({ ...i, enabled: pending.get(i.key) ?? i.enabled }))
          .filter((i) => !filter || i.name.toLowerCase().includes(filter.toLowerCase()));

        // options and map stay index-aligned: headers are null, actions are {action}
        type Pickable = ToggleItem | { action: "search" | "clear" | "save" };
        const options: string[] = [];
        const map: Array<Pickable | null> = [];
        const push = (option: string, pickable: Pickable | null = null) => { options.push(option); map.push(pickable); };

        const exts = effective.filter((i) => i.kind === "extension");
        if (exts.length > 0) {
          push(EXT_HEADER);
          for (const i of exts) push(`${i.enabled ? "✓" : "✗"} ${i.name}`, i);
        }

        const pkgs = effective.filter((i) => i.kind === "package");
        if (pkgs.length > 0) {
          push(PKG_HEADER);
          for (const i of pkgs) push(`${i.enabled ? "✓" : "✗"} ${i.name}`, i);
        }

        const skls = effective.filter((i) => i.kind === "skill");
        if (skls.length > 0) {
          push(SKILL_HEADER);
          for (const i of skls) push(`${i.enabled ? "✓" : "✗"} ${i.name}`, i);
        }

        if (filter) push(CLEAR_OPTION, { action: "clear" });
        push(SEARCH_OPTION, { action: "search" });
        if (dirty()) push(`${SAVE_OPTION} (${pending.size})`, { action: "save" });

        const title = `Toggle extensions/packages/skills${filter ? ` — filter: "${filter}"` : ""}${dirty() ? ` — ${pending.size} unsaved` : ""}`;
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
        if (picked.name === SELF_NAME) {
          ctx.ui.notify("cannot disable /ext itself (it is the toggle UI)", "warning");
          continue;
        }
        const next = !picked.enabled;
        // toggling back to the on-disk value cancels the pending change
        if (next === (items.find((i) => i.key === picked.key)?.enabled ?? picked.enabled)) pending.delete(picked.key);
        else pending.set(picked.key, next);
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

export { extToggleExtension };
