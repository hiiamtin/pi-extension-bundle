#!/usr/bin/env node
// End-to-end functional test for the ext extension (runs OUTSIDE pi with a
// fake ExtensionAPI). Isolated: PI_CODING_AGENT_DIR + cwd point at tmp dirs —
// the REAL ~/.pi/agent settings are never read or written.
//
//   node scripts/ext-e2e.mjs
//
// Covers:
//   1. picker sections    → extensions, standalone, packages, skills (user/
//                           project/package), MCP servers, tools
//   2. direct toggle      → user skill off/on writes global settings markers
//   3. direct toggle      → project skill on writes .pi/settings.json
//   4. direct toggle      → standalone extension off writes "-<abs>" marker
//   5. direct toggle      → package skill off converts entry to object form
//   6. direct toggle      → MCP server off writes {disabled:true} into agent
//                           mcp.json; on removes it again
//   7. tools              → session-scoped toggle via setActiveTools
//   8. self-protection    → /ext ext off is refused
//   9. completions        → read-only name list, capped at 8
//
// Exit code 0 = ALL ... PASSED.

import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";

const here = path.dirname(new URL(import.meta.url).pathname);
const pkgRoot = path.dirname(here);

// ---------- isolated world ----------
const AGENT_DIR = path.join(os.tmpdir(), `pi-ext-e2e-agent-${process.pid}`);
const PROJECT_DIR = path.join(os.tmpdir(), `pi-ext-e2e-project-${process.pid}`);
const FAKE_STANDALONE = path.join(AGENT_DIR, "somewhere", "hindsight", "dist", "pi.js");
rmSync(AGENT_DIR, { recursive: true, force: true });
rmSync(PROJECT_DIR, { recursive: true, force: true });
process.env.PI_CODING_AGENT_DIR = AGENT_DIR;

mkdirSync(path.join(AGENT_DIR, "skills", "hindsight-coding-agent"), { recursive: true });
writeFileSync(path.join(AGENT_DIR, "skills", "hindsight-coding-agent", "SKILL.md"), "---\nname: hindsight-coding-agent\ndescription: test skill\n---\nbody\n");
mkdirSync(path.join(AGENT_DIR, "npm", "node_modules", "pi-mcp-adapter", "dist"), { recursive: true });
writeFileSync(
  path.join(AGENT_DIR, "npm", "node_modules", "pi-mcp-adapter", "dist", "config.js"),
  [
    "export function loadMcpConfig() {",
    "  return { mcpServers: { context7: { url: 'https://x' }, broken: { url: 'https://y', disabled: true } } };",
    "}",
    "export function getServerProvenance() {",
    "  return new Map([['context7', { kind: 'user', path: '/tmp/x' }]]);",
    "}",
  ].join("\n"),
);
mkdirSync(path.dirname(FAKE_STANDALONE), { recursive: true });
writeFileSync(FAKE_STANDALONE, "export default () => {};\n");
writeFileSync(
  path.join(AGENT_DIR, "settings.json"),
  JSON.stringify(
    {
      packages: [pkgRoot, "npm:pi-mcp-adapter", "fakepkg"],
      extensions: [FAKE_STANDALONE],
      skills: [],
    },
    null,
    2,
  ),
);

// relative package source (resolved against the agent dir, like user settings)
mkdirSync(path.join(AGENT_DIR, "fakepkg", "skills", "relskill"), { recursive: true });
writeFileSync(path.join(AGENT_DIR, "fakepkg", "skills", "relskill", "SKILL.md"), "---\nname: relskill\ndescription: rel pkg skill\n---\n");
writeFileSync(path.join(AGENT_DIR, "fakepkg", "package.json"), JSON.stringify({ name: "fakepkg", pi: { skills: ["./skills"] } }));

mkdirSync(path.join(PROJECT_DIR, ".pi", "skills", "projskill"), { recursive: true });
writeFileSync(path.join(PROJECT_DIR, ".pi", "skills", "projskill", "SKILL.md"), "---\nname: projskill\ndescription: project skill\n---\n");
mkdirSync(path.join(PROJECT_DIR, ".agents", "skills", "agentskill"), { recursive: true });
writeFileSync(path.join(PROJECT_DIR, ".agents", "skills", "agentskill", "SKILL.md"), "---\nname: agentskill\ndescription: agents skill\n---\n");
writeFileSync(path.join(PROJECT_DIR, ".pi", "settings.json"), JSON.stringify({ skills: ["-skills/projskill/SKILL.md"] }, null, 2));

process.chdir(PROJECT_DIR);

const mod = await import(path.join(pkgRoot, "extensions", "ext.ts"));

// ---------- fake pi / ctx ----------
const commands = {};
const activeTools = new Set(["read", "bash", "edit", "write", "bg_spawn", "web_search", "hindsight_search"]);
let reloads = 0;
mod.default({
  registerCommand: (name, opts) => { commands[name] = opts; },
  getAllTools: () => [
    { name: "read", sourceInfo: { source: "builtin" } },
    { name: "bg_spawn", sourceInfo: { path: path.join(pkgRoot, "extensions", "bg-task.ts") } },
    { name: "web_search", sourceInfo: { path: path.join(pkgRoot, "extensions", "web-search.ts") } },
    { name: "hindsight_search", sourceInfo: { path: FAKE_STANDALONE } },
    { name: "mcp", sourceInfo: { path: path.join(AGENT_DIR, "npm", "node_modules", "pi-mcp-adapter", "index.ts") } },
  ],
  getActiveTools: () => [...activeTools],
  setActiveTools: (names) => { activeTools.clear(); for (const n of names) activeTools.add(n); },
});

const ext = commands.ext;
if (!ext) { console.error("FATAL: /ext command not registered"); process.exit(1); }

const notifications = [];
const makeCtx = () => ({
  ui: {
    notify: (msg, level) => notifications.push({ msg, level }),
  },
  reload: async () => { reloads++; },
});

const readJson = (file) => JSON.parse(readFileSync(file, "utf8"));

// collect picker options by running the handler with a scripted select()
async function pickerOptions() {
  let captured = null;
  const ctx = makeCtx();
  ctx.ui.select = async (title, options) => {
    if (captured === null) { captured = { title, options }; return null; } // grab first screen, then close
    return undefined;
  };
  await ext.handler("", ctx);
  return captured;
}

let failures = 0;
const check = (label, cond) => {
  console.log(`${cond ? "  ✓" : "  ✗ FAIL"} ${label}`);
  if (!cond) failures++;
};

// ---------- 1. picker sections ----------
console.log("1. picker shows all sections");
{
  const { title, options } = (await pickerOptions()) ?? {};
  check("picker opens", Boolean(options));
  check("title mentions mcp/tools", /mcp\/tools/.test(title ?? ""));
  const joined = options?.join("\n") ?? "";
  check("own extension listed", joined.includes("bg-task — extension"));
  check("standalone extension listed", joined.includes("hindsight/dist/pi.js — extension (settings)"));
  check("external package listed", joined.includes("pi-mcp-adapter — package"));
  check("user skill listed", joined.includes("hindsight-coding-agent — skill (user)"));
  check("project skill listed as disabled", joined.includes("✗ projskill — skill (project)"));
  check(".agents project skill listed", joined.includes("agentskill — skill (project)"));
  check("package skill listed", joined.includes("ghostty-thai-fonts — skill (package)"));
  check("mcp server listed (enabled)", joined.includes("✓ context7 — mcp server (user)"));
  check("mcp server listed (disabled)", joined.includes("✗ broken — mcp server"));
  check("tool groups present", joined.includes("── Tools: built-in ──") && joined.includes("── Tools: mcp ──"));
  check("extension tool grouped by file", joined.includes("bg_spawn — tool (bg-task"));
  check("standalone ext tool grouped", joined.includes("hindsight_search — tool (pi.js"));
}

// ---------- 2. user skill toggle ----------
console.log("2. user skill off → global settings marker");
{
  await ext.handler("hindsight-coding-agent off", makeCtx());
  const g = readJson(path.join(AGENT_DIR, "settings.json"));
  check("marker written", g.skills.includes("-skills/hindsight-coding-agent/SKILL.md"));
  check("reload called", reloads === 1);
  await ext.handler("hindsight-coding-agent on", makeCtx());
  const g2 = readJson(path.join(AGENT_DIR, "settings.json"));
  check("marker removed on enable", !g2.skills.includes("-skills/hindsight-coding-agent/SKILL.md"));
}

// ---------- 3. project skill toggle ----------
console.log("3. project skill on → project settings");
{
  await ext.handler("projskill on", makeCtx());
  const p = readJson(path.join(PROJECT_DIR, ".pi", "settings.json"));
  check("project marker removed", !p.skills.includes("-skills/projskill/SKILL.md"));
  await ext.handler("projskill off", makeCtx());
  const p2 = readJson(path.join(PROJECT_DIR, ".pi", "settings.json"));
  check("project marker restored", p2.skills.includes("-skills/projskill/SKILL.md"));
}

// ---------- 4. standalone extension toggle ----------
console.log("4. standalone extension off → -abs marker");
{
  await ext.handler("hindsight/dist/pi.js off", makeCtx());
  const g = readJson(path.join(AGENT_DIR, "settings.json"));
  check("abs marker written", g.extensions.includes(`-${FAKE_STANDALONE}`));
  await ext.handler("hindsight/dist/pi.js on", makeCtx());
  const g2 = readJson(path.join(AGENT_DIR, "settings.json"));
  check("marker removed on enable", !g2.extensions.includes(`-${FAKE_STANDALONE}`));
}

// ---------- 4b. relative marker + relative package source ----------
console.log("4b. relative-form markers and relative package sources");
{
  const settingsFile = path.join(AGENT_DIR, "settings.json");
  const g = readJson(settingsFile);
  g.extensions = ["somewhere/hindsight/dist/pi.js", "-somewhere/hindsight/dist/pi.js"];
  writeFileSync(settingsFile, JSON.stringify(g, null, 2));
  const { options } = (await pickerOptions()) ?? {};
  check("relative marker shown as disabled", (options ?? []).some((l) => l.startsWith("✗ hindsight/dist/pi.js")));
  await ext.handler("hindsight/dist/pi.js on", makeCtx());
  const g2 = readJson(settingsFile);
  check("relative marker removed on enable", !g2.extensions.some((e) => e.startsWith("-") && e.includes("somewhere/hindsight")));
  check("relative package skill listed", ((await pickerOptions())?.options ?? []).some((l) => l.includes("relskill — skill (package)")));
}

// ---------- 5. package skill toggle ----------
console.log("5. package skill off → object form filter");
{
  await ext.handler("ghostty-thai-fonts off", makeCtx());
  const g = readJson(path.join(AGENT_DIR, "settings.json"));
  const entry = g.packages.find((p) => typeof p === "object" && p.source === pkgRoot);
  check("package entry converted", Boolean(entry));
  check("skill filter written", entry?.skills?.includes("-skills/ghostty-thai-fonts/SKILL.md") === true);
  await ext.handler("ghostty-thai-fonts on", makeCtx());
  const g2 = readJson(path.join(AGENT_DIR, "settings.json"));
  const entry2 = g2.packages.find((p) => typeof p === "object" && p.source === pkgRoot);
  check("canonical string form restored", entry2 === undefined && g2.packages.includes(pkgRoot));
}

// ---------- 6. mcp server toggle ----------
console.log("6. mcp server off/on → agent mcp.json");
{
  const mcpFile = path.join(AGENT_DIR, "mcp.json");
  await ext.handler("context7 off", makeCtx());
  const cfg = readJson(mcpFile);
  check("disabled override written", cfg.mcpServers?.context7?.disabled === true);
  await ext.handler("context7 on", makeCtx());
  const cfg2 = readJson(mcpFile);
  check("override dropped on enable", cfg2.mcpServers?.context7 === undefined);
}

// ---------- 7. tools (session-scoped) ----------
console.log("7. tool toggle → setActiveTools only, no reload");
{
  reloads = 0;
  await ext.handler("bg_spawn off", makeCtx());
  check("tool removed from active set", !activeTools.has("bg_spawn") && activeTools.has("read"));
  check("no reload for session toggles", reloads === 0);
  await ext.handler("bg_spawn on", makeCtx());
  check("tool re-enabled", activeTools.has("bg_spawn"));
}

// ---------- 8. self protection ----------
console.log("8. /ext cannot disable itself");
{
  reloads = 0;
  await ext.handler("ext off", makeCtx());
  check("refused with error", notifications.some((n) => n.level === "error" && /cannot disable \/ext/.test(n.msg)));
  check("nothing reloaded", reloads === 0);
}

// ---------- 9. completions ----------
console.log("9. argument completions (read-only, capped)");
{
  const level1 = ext.getArgumentCompletions("");
  check("returns items", Array.isArray(level1) && level1.length > 0);
  check("capped at 8", level1.length <= 8);
  check("labels describe kind", level1.every((i) => / — /.test(i.label)));
  const level2 = ext.getArgumentCompletions("bg_spawn ");
  check("level 2 offers on/off", level2?.length === 2 && level2.every((i) => /^bg_spawn (on|off)$/.test(i.value)));
  const none = ext.getArgumentCompletions("zzz-nope");
  check("unknown prefix → null", none === null);
}

// ---------- cleanup ----------
rmSync(AGENT_DIR, { recursive: true, force: true });
rmSync(PROJECT_DIR, { recursive: true, force: true });

if (failures > 0) {
  console.error(`\n${failures} FAILURE(S)`);
  process.exit(1);
}
console.log("\nALL ext-e2e TESTS PASSED");
