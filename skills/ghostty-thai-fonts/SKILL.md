---
name: ghostty-thai-fonts
description: Manage Thai fonts in the Ghostty terminal — find/download Thai fonts from Google Fonts, measure glyph widths against the terminal cell (overlap detection), set font-codepoint-map and adjust-cell-width in the Ghostty config, generate preview images comparing all installed Thai fonts, and build custom monospace Thai fonts from proportional ones. Use when the user mentions changing, finding, measuring, or building Thai fonts for Ghostty.
---

# Ghostty Thai Fonts

Manage Thai fonts for the Ghostty terminal on macOS.

## Key concepts

- The primary font (`font-family`) determines the terminal cell width.
- Thai uses a separate font via `font-codepoint-map = U+0E00-U+0E7F=<font>`.
- Thai glyphs whose ink is wider than the cell overlap neighbors. Fixable with
  `adjust-cell-width = N%` — but that widens cells for ALL text (English too).
- Key metric: widest glyph fill <= 100% of cell = no overlap, no adjust needed.
- Note: "min 0%" in measurements = combining marks (vowels/tone marks) — normal.
- Ghostty does NOT support per-codepoint font size; `font-size` is global.
- After editing the config, press `Cmd+Shift+,` in Ghostty to reload.
- **CoreText caches fonts aggressively**: overwriting a font file under the same
  family name serves stale renders. Always use a NEW family name per build
  (e.g. "Mali Mono v0.3") while iterating, and fully restart Ghostty (Cmd+Q).

## Commands

All via: `"$HOME/.pi/agent/skills/ghostty-thai-fonts/scripts/thaifont" <mode>`

```bash
thaifont list                     # all Thai-capable fonts installed on the system
thaifont check <font...>          # measure overlap vs the current primary font cell
thaifont search [query]           # search Thai fonts on Google Fonts (with category)
thaifont download <Family>        # download+install TTFs from the google/fonts repo
thaifont apply <Family> [%|none]  # write font-codepoint-map (+adjust-cell-width) to config
thaifont preview                  # render a PNG comparing every installed Thai font + open it
thaifont config                   # show current config and fonts
thaifont version <Family>         # show registered vs on-disk font (cache debugging)
```

Helper: `scripts/build-mono.py <source.ttf> "<New Family>" [version]` — converts a
proportional Thai font into an Ayuthaya-style monospace font (uniform advance
0.594em, condense-but-never-stretch, centered ink, right-leaning pre-vowels,
GPOS MarkBase anchor patching). See the script docstring for tuning parameters.

## Standard workflow (new Thai font)

1. `thaifont search "..."` — pick by category (HANDWRITING, SANS_SERIF, ...)
2. `thaifont download "<Family>"`
3. Wait ~2s for macOS to register, then `thaifont check "<Family>"`
4. No overlap -> `thaifont apply "<Family>"`
5. Overlap -> either `thaifont apply "<Family>" "N%"` (English gets wider too)
   or build a custom mono version with `scripts/build-mono.py`
6. Remind the user to reload (`Cmd+Shift+,`) — full restart when replacing font files

## Verified results (2025, macOS, cell = AnnotationM NFM)

**True monospace Thai fonts (std=0, all fit):** Ayuthaya (95% fill — the chosen one),
Tlwg Typist / Tlwg Mono / Tlwg Typewriter / Tlwg Typo (96%), SOV_monomon (90%).
These are the ONLY true-mono Thai fonts found anywhere (system + all of Google Fonts).

**No overlap (✅ 0% adjust):** Silom (95%), Sathu (91%), Charm (88%), Pattaya (98%),
Charmonman (92%), Srisakdi (94%)

**Overlaps:** Thonburi (108%), Sukhumvit Set (112%), Itim (110%), K2D (110%),
Iannnnn-COW (109%), Playpen Sans Thai (126%+), Mali (127%), Sriracha (117%),
MN Chaeo Hon (124%), Prompt (124%), Krungthep (125%), Anuphan (115%),
IBM Plex Sans Thai (115%), Kanit (116%), Sarabun (115%) — nearly all modern
Google Fonts Thai faces are proportional.

**Custom font success story:** "Mali Mono" = Mali (handwriting) converted with
build-mono.py. Final recipe: source = original Mali-Regular.ttf, no blending,
GLOBAL_SCALE_FLOOR 0.96, SIZE_SCALE 0.90 (x and y uniform), MIN_FILL disabled.
See the lessons in the build-mono.py docstring:
- never stretch glyphs (bolds vertical strokes), cap condensing at 0.85
- pure uniform scaling of over-wide glyphs makes them look short ("น ญ เล็ก") —
  x-only squeeze keeps heights equal (final choice)
- strip ALL name-table records when renaming (legacy mac-platform names shadow
  the real font and break `ghostty +show-face`)
- `scripts/blend-weights.py` (interpolate Regular->Medium for extra weight)
  works mechanically (479/773 glyphs) but user rejected the result: imperfect
  point correspondence made some vowel outlines morph oddly. Kept for reference.
