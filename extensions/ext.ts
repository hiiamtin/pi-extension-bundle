// pi extension: /ext — toggle sibling extensions AND local skills
// (pi config compatible — edits the same settings.json structures:
//   extensions → packages[] object form with "-extensions/<name>.ts"
//   skills     → top-level skills[] with "-skills/<name>/SKILL.md")
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
type PackageEntry = string | { source: string; extensions?: string[] };

const SETTINGS_FILE = () => path.join(os.homedir(), ".pi/agent/settings.json");
// pi's user-level skills root is the cross-agent convention dir ~/.agents/skills
// (NOT ~/.pi/agent/skills). Settings overrides use "-skills/<name>/SKILL.md"
// relative to that root.
const SKILLS_DIR = () => path.join(os.homedir(), ".agents", "skills");
const SELF_NAME = "ext";
const DONE_OPTION = "── done ──";
const SAVE_OPTION = "💾 Save & reload";
const SEARCH_OPTION = "🔍 Search…";
const CLEAR_OPTION = "✏️ Clear filter";
const EXT_HEADER = "── Extensions ──";
const SKILL_HEADER = "── Skills ──";

type ToggleItem = { key: string; name: string; kind: "extension" | "skill"; enabled: boolean };

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

function findPackageEntry(packages: PackageEntry[], root: string): { index: number; entry: { source: string; extensions: string[] } } | null {
  const index = packages.findIndex((p) => (typeof p === "string" ? p : p.source) === root);
  if (index === -1) return null;
  const raw = packages[index];
  const entry = typeof raw === "string" ? { source: raw, extensions: [] } : { source: raw.source, extensions: raw.extensions ?? [] };
  return { index, entry };
}

function extensionEnabled(entry: { extensions: string[] } | null, name: string): boolean {
  return !entry || !entry.extensions.includes(`-extensions/${name}.ts`);
}

function skillEnabled(skills: string[], name: string): boolean {
  return !skills.includes(`-skills/${name}/SKILL.md`);
}

function setExtension(packages: PackageEntry[], root: string, name: string, enabled: boolean): void {
  const found = findPackageEntry(packages, root);
  if (!found) throw new Error(`package ${root} not found in settings.json`);
  const { index, entry } = found;
  const marker = `-extensions/${name}.ts`;
  if (enabled) entry.extensions = entry.extensions.filter((e) => e !== marker);
  else if (!entry.extensions.includes(marker)) entry.extensions.push(marker);
  // object form with no exclusions == plain string form; keep it canonical
  packages[index] = entry.extensions.length > 0 ? entry : entry.source;
}

function setSkill(skills: string[], name: string, enabled: boolean): void {
  const marker = `-skills/${name}/SKILL.md`;
  const filtered = skills.filter((s) => s !== marker);
  if (!enabled) filtered.push(marker);
  skills.length = 0;
  skills.push(...filtered);
}

function collectItems(packages: PackageEntry[], skills: string[]): { root: string | null; items: ToggleItem[] } {
  const root = findOwnPackageRoot(packages);
  const entry = root ? findPackageEntry(packages, root)?.entry ?? null : null;
  const items: ToggleItem[] = [];
  for (const n of listExtensions(root)) items.push({ key: `ext:${n}`, name: n, kind: "extension", enabled: extensionEnabled(entry, n) });
  for (const n of listSkills()) items.push({ key: `skill:${n}`, name: n, kind: "skill", enabled: skillEnabled(skills, n) });
  return { root, items };
}

function applyPending(pending: Map<string, boolean>): void {
  const settings = readSettings();
  const root = findOwnPackageRoot(settings.packages);
  if (!root) throw new Error("cannot locate own package root in settings.json");
  for (const [key, enabled] of pending) {
    const [kind, name] = key.split(":") as ["extension" | "skill", string];
    if (kind === "extension") setExtension(settings.packages, root, name, enabled);
    else setSkill(settings.skills, name, enabled);
  }
  writeSettings(settings);
}

export default function extToggleExtension(pi: ExtensionAPI): void {
  pi.registerCommand("ext", {
    description: "Enable/disable extensions and skills (same store as pi config). /ext opens a picker; /ext <name> on|off for direct toggle",
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
        const item = items.find((i) => i.name === name);
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
          setExtension(packages, root, name, action === "on");
        } else {
          setSkill(skills, name, action === "on");
        }
        writeSettings({ packages, skills });
        ctx.ui.notify(`${name}: ${action === "on" ? "enabled" : "disabled"} — reloading…`, "info");
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
      let dirty = () => pending.size > 0;

      for (;;) {
        const { packages, skills } = readSettings();
        const { items } = collectItems(packages, skills);
        const effective = items
          .map((i) => ({ ...i, enabled: pending.get(i.key) ?? i.enabled }))
          .filter((i) => !filter || i.name.toLowerCase().includes(filter.toLowerCase()));

        const options: string[] = [EXT_HEADER];
        for (const i of effective.filter((i) => i.kind === "extension")) options.push(`${i.enabled ? "✓" : "✗"} ${i.name}`);
        options.push(SKILL_HEADER);
        for (const i of effective.filter((i) => i.kind === "skill")) options.push(`${i.enabled ? "✓" : "✗"} ${i.name}`);
        if (filter) options.push(CLEAR_OPTION);
        options.push(SEARCH_OPTION);
        if (dirty()) options.push(`${SAVE_OPTION} (${pending.size})`);
        options.push(DONE_OPTION);

        const title = `Toggle extensions/skills${filter ? ` — filter: "${filter}"` : ""}${dirty() ? ` — ${pending.size} unsaved` : ""}`;
        const choice = await ctx.ui.select(title, options);
        if (!choice || choice === DONE_OPTION) break;

        if (choice === EXT_HEADER || choice === SKILL_HEADER) continue;
        if (choice === SEARCH_OPTION) {
          const q = await ctx.ui.input?.("Filter by name (empty = show all)", filter);
          filter = (q ?? "").trim();
          continue;
        }
        if (choice === CLEAR_OPTION) {
          filter = "";
          continue;
        }
        if (choice.startsWith(SAVE_OPTION)) {
          applyPending(pending);
          ctx.ui.notify(`${pending.size} change(s) saved — reloading…`, "info");
          await ctx.reload();
          return;
        }

        const picked = effective[options.indexOf(choice)];
        if (!picked) continue;
        if (picked.name === SELF_NAME) {
          ctx.ui.notify("cannot disable /ext itself (it is the toggle UI)", "warning");
          continue;
        }
        pending.set(picked.key, !(pending.get(picked.key) ?? picked.enabled));
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
