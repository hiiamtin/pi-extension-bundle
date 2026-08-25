// pi extension: /ext — toggle sibling extensions AND local skills on/off
// (pi config compatible — edits the same settings.json structures:
//   extensions → packages[] object form with "-extensions/<name>.ts"
//   skills     → top-level skills[] with "-skills/<name>/SKILL.md")
// After toggling, ctx.reload() re-runs the extension runtime immediately.

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { existsSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

type Ui = { notify: (msg: string, level: string) => void };
type PackageEntry = string | { source: string; extensions?: string[] };

const SETTINGS_FILE = () => path.join(os.homedir(), ".pi/agent/settings.json");
const SKILLS_DIR = () => path.join(os.homedir(), ".pi/agent/skills");

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

export default function extToggleExtension(pi: ExtensionAPI): void {
  pi.registerCommand("ext", {
    description: "Enable/disable extensions and skills (same store as pi config). /ext [name on|off]",
    handler: async (args: string, ctx: { ui: Ui; reload: () => Promise<void> }) => {
      const { packages, skills } = readSettings();
      const root = findOwnPackageRoot(packages);
      const extensions = listExtensions(root);
      const skillNames = listSkills();
      const [name, action] = args.trim().split(/\s+/).filter(Boolean);

      if (!name) {
        const extLines = extensions.map((n) => `  ${extensionEnabled(findPackageEntry(packages, root)?.entry ?? null, n) ? "✓" : "✗"} ${n}`);
        const skillLines = skillNames.map((n) => `  ${skillEnabled(skills, n) ? "✓" : "✗"} ${n}`);
        ctx.ui.notify([`/ext <name> on|off`, "extensions:", ...extLines, "skills:", ...skillLines].join("\n"), "info");
        return;
      }

      const isExtension = extensions.includes(name);
      const isSkill = skillNames.includes(name);
      if (!isExtension && !isSkill) {
        ctx.ui.notify(`unknown: ${name} (extensions: ${extensions.join(", ") || "none"} | skills: ${skillNames.join(", ") || "none"})`, "error");
        return;
      }
      if (action !== "on" && action !== "off") {
        ctx.ui.notify("usage: /ext <name> on|off", "error");
        return;
      }

      if (isExtension) {
        if (!root) throw new Error("cannot locate own package root in settings.json");
        setExtension(packages, root, name, action === "on");
      } else {
        setSkill(skills, name, action === "on");
      }
      writeSettings({ packages, skills });
      ctx.ui.notify(`${name}: ${action === "on" ? "enabled" : "disabled"} — reloading…`, "info");
      await ctx.reload();
    },
  });
}

export { extToggleExtension };
