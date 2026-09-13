import { readFileSync } from 'node:fs';
const { parseFig } = await import('openfig-core');
const { mergeNodeChanges, guidStr } = await import('./lib/figma-instance-resolver.ts');
const doc = parseFig(new Uint8Array(readFileSync('.pi/figma-exports/[Sonic] Common.fig')));
const fig = mergeNodeChanges(doc.message?.nodeChanges ?? []);
// Check the OTHER advsearch.fieldcondition content states: for the fc family in session 782, what title TEXT does the override hold? (maybe those are 'Field name' too?) — irrelevant. Instead: CONFIRM what the OLD pre-chain-keying behavior bound for Title: before ANY of my flatten changes, flatten didn't exist; binding for Title came from 'authoritative' loop: ownByGuid (own = 58949's own) → Field ✓ then the STALE '*' helper, then TEXT_DATA loop → propText 'Lead name' vs bound... 
// At TEXT case: bound.glyphs=Field-run → renders Field. THAT WAS THE ORIGINAL BUG. My flatten (ancestor Lead) — was CORRECT but came BEFORE swapRuns pairing: swapRuns = ALL dir.textByKey values sorted by fs — flattened ancText used only for direct key hits. OK.
// NOW: why does flatten yield Field? Direct probe of node2 build: replicate mergeDir quickly with real functions copied from file... too big. Instead instrument buildSlotMap flatten via env var to dump ancText keys+adv when instance=7360:58949:
PYEOF
python3 - <<'PYEOF'
s = open('lib/figma-svg-renderer.ts').read()
old = '''      collectText(dir);
      if (ancText.size) {'''
new = '''      collectText(dir);
      if (process.env.FIGMA_TRACE === "2" && guidStr(instance.guid) === "7360:58949") {
        const r = ancText.get("655:538");
        console.error(`[flatten 58949] 655:538 → n=${r?.length ?? 0} adv0=${r?.[0]?.advance?.toFixed(3)}`);
      }
      if (ancText.size) {'''
assert old in s
s = s.replace(old, new)
open('lib/figma-svg-renderer.ts','w').write(s)
print('probe added')
PYEOF
FIGMA_TRACE=2 node render-now.mjs 2>&1 | grep "flatten 58949" | head -3
