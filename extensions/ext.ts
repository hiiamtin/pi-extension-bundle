// pi extension: /ext — toggle sibling extensions AND local skills on/off
// (pi config compatible — edits the same settings.json structures:
//   extensions → packages[] object form with "-extensions/<name>.ts"
//   skills     → top-level skills[] with "-skills/<name>/SKILL.md")
//
// Bare /ext opens an interactive picker (works in TUI and pi-web): pick an
// entry to toggle it; settings are saved per pick and ONE reload runs when
// the picker closes (reload tears down the running runtime, so it must be
// the last step). /ext <name> on|off stays for fast/scripted use.

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { existsSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

type Ui = { notify: (msg: string, level: string) => void; select?: (title: string, options: string[]) => Promise<string | undefined> };
type PackageEntry = string | { source: string; extensions?: string[] };

const SETTINGS_FILE = () => path.join(os.homedir(), ".pi/agent/settings.json");
const SKILLS_DIR = () => path.join(os.homedir(), ".pi/agent/skills");
const DONE_OPTION = "── done ──";

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

export default function extToggleExtension(pi: ExtensionAPI): void {
  pi.registerCommand("ext", {
    description: "Enable/disable extensions and skills (same store as pi config). /ext opens a picker; /ext <name> on|off for direct toggle",
    handler: async (args: string, ctx: { ui: Ui; reload: () => Promise<void> }) => {
      const [name, action] = args.trim().split(/\s+/).filter(Boolean);

      // direct toggle path
      if (name) {
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
      let changed = false;
      for (;;) {
        const { packages, skills } = readSettings();
        const { items } = collectItems(packages, skills);
        const effective = items.map((i) => ({ ...i, enabled: pending.get(i.key) ?? i.enabled }));
        const options = effective.map((i) => `${i.enabled ? "✓" : "✗"} ${i.name}  (${i.kind})`);
        options.push(DONE_OPTION);
        const choice = await ctx.ui.select("Toggle — pick to switch, done to apply", options);
        if (!choice || choice === DONE_OPTION) break;
        const item = effective[options.indexOf(choice)];
        const next = !item.enabled;
        pending.set(item.key, next);

        const fresh = readSettings();
        if (item.kind === "extension") {
          const root = findOwnPackageRoot(fresh.packages);
          if (!root) throw new Error("cannot locate own package root in settings.json");
          setExtension(fresh.packages, root, item.name, next);
        } else {
          setSkill(fresh.skills, item.name, next);
        }
        writeSettings(fresh);
        changed = true;
      }
      if (changed) {
        ctx.ui.notify("changes saved — reloading…", "info");
        await ctx.reload();
      }
    },
  });
}

export { extToggleExtension };
