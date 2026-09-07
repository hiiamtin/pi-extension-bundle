#!/usr/bin/env python3
"""build-mono.py — convert a proportional Thai font into an Ayuthaya-style monospace font

Keeps the original glyph shapes but forces a uniform advance of 0.594em (Ayuthaya's
formula). Over-wide ink is condensed on x only (never stretched — stretching makes
vertical strokes visibly bolder). Glyphs are centered in the cell; Thai pre-vowels
lean right toward the following consonant. GPOS MarkBase anchors are patched so
vowels/tone marks stay attached.

Usage: build-mono.py <source.ttf> "<New Family Name>" [version]
"""
import sys, os
from fontTools.ttLib import TTFont
from fontTools.pens.boundsPen import BoundsPen
from fontTools.pens.recordingPen import DecomposingRecordingPen
from fontTools.pens.ttGlyphPen import TTGlyphPen
from fontTools.pens.transformPen import TransformPen
from fontTools.misc.transform import Transform

AYU_ADV_RATIO = 1248 / 2100  # Ayuthaya's advance in em units
CELL_MARGIN = 15             # margin on each side of the cell (upem-1000 units)
GLOBAL_SCALE_FLOOR = 0.96    # never shrink the whole set below this
SIZE_SCALE = 0.90           # uniform (x=y) size match against Ayuthaya's absolute glyph size
MIN_FILL = 0.0              # disabled: user prefers unstretched vowels (set 0.72 + 1.2x cap to enable)

# Algorithm ("match the biggest glyph"):
# 1. Find the widest glyph; the global scale is whatever makes it fit the cell
#    (capped at GLOBAL_SCALE_FLOOR — shrinking everything that far is too much).
# 2. Apply the same global scale to every spacing glyph -> all glyphs share one
#    size/weight, original aspect ratio, original height.
# 3. Any glyph still wider than the cell gets a tiny individual x-squeeze, just
#    enough to fit (barely-noticeable thinning on a few outliers only).
# 4. Everything is optically centered; pre-vowels lean right toward the consonant.


def transform_glyph(glyphSet, gname, fx, dx, fy):
    if gname not in glyphSet:
        return None
    rec = DecomposingRecordingPen(glyphSet)
    glyphSet[gname].draw(rec)
    pen = TTGlyphPen(None)
    tp = TransformPen(pen, Transform(fx, 0, 0, fy, dx, 0))
    for op, args in rec.value:
        getattr(tp, op)(*args)
    return pen.glyph()


def main(src, family, version="1.0"):
    font = TTFont(src)
    upem = font["head"].unitsPerEm
    A = round(AYU_ADV_RATIO * upem)

    glyf = font["glyf"]
    glyphSet = font.getGlyphSet()
    cmap = font.getBestCmap()
    hmtx = font["hmtx"]
    R = CELL_MARGIN * upem / 1000
    usable = A - 2 * R

    transforms = {}  # gname -> (fx, dx, fy) for GPOS anchor patching
    stats = {"fitted": 0, "extra-squeezed": 0, "skipped": 0}

    # pass 1: measure ink widths of all spacing Thai glyphs
    inks = {}
    for cp, gname in sorted(cmap.items()):
        if not (0x0E01 <= cp <= 0x0E5B):
            continue
        if hmtx[gname][0] == 0:
            continue  # combining mark — untouched, GPOS handles it
        bp = BoundsPen(glyphSet)
        glyphSet[gname].draw(bp)
        if bp.bounds is None:
            stats["skipped"] += 1
            continue
        inks[cp] = (gname, bp.bounds[0], bp.bounds[2] - bp.bounds[0])

    # pass 2: global scale from the widest glyph (floored), then per-glyph extra squeeze
    max_ink = max(w for _, _, w in inks.values())
    global_scale = min(1.0, max(GLOBAL_SCALE_FLOOR, usable / max_ink))
    print(f"widest glyph: {max_ink} units ({max_ink/A*100:.0f}% of cell) -> global scale {global_scale:.2f}")

    for cp, (gname, xMin, ink) in sorted(inks.items()):
        fx = global_scale * SIZE_SCALE
        if ink * fx > usable:
            fx = usable / ink  # individual x-squeeze, just enough to fit
            stats["extra-squeezed"] += 1
        else:
            stats["fitted"] += 1
        # minimum optical width for smallish glyphs (stretch x up to 1.2x max)
        ink_fx = ink * fx
        if 0.40 * A <= ink_fx < MIN_FILL * A and fx < MIN_FILL * A / ink:
            fx = min(MIN_FILL * A / ink, fx * 1.2)
            stats["widened"] = stats.get("widened", 0) + 1
        if 0x0E40 <= cp <= 0x0E44:
            xMin_new = (A - ink * fx) * 0.55  # pre-vowels lean right toward the consonant
        else:
            xMin_new = (A - ink * fx) / 2
        dx = xMin_new - xMin * fx
        ng = transform_glyph(glyphSet, gname, fx, dx, SIZE_SCALE)  # uniform y: aspect kept
        if ng is None:
            continue
        ng.recalcBounds(glyf)
        glyf[gname] = ng
        hmtx[gname] = (A, round(xMin_new))
        transforms[gname] = (fx, dx, SIZE_SCALE)

    # ---- patch GPOS MarkBase anchors so vowels/tone marks follow the moved ink ----
    if "GPOS" in font and transforms:
        patched = 0
        for lookup in font["GPOS"].table.LookupList.Lookup:
            if lookup.LookupType != 4:  # MarkBasePos only (bases are the glyphs we moved)
                continue
            for st in lookup.SubTable:
                try:
                    for gname, rec in zip(st.BaseCoverage.glyphs, st.BaseArray.BaseRecord):
                        if gname not in transforms:
                            continue
                        fx, dx, fy = transforms[gname]
                        for anchor in rec.BaseAnchor:
                            if anchor is None:
                                continue
                            # fontTools anchors use XCoordinate (older versions use x)
                            if hasattr(anchor, "XCoordinate") and anchor.XCoordinate is not None:
                                anchor.XCoordinate = round(anchor.XCoordinate * fx + dx)
                                if hasattr(anchor, "YCoordinate") and anchor.YCoordinate is not None:
                                    anchor.YCoordinate = round(anchor.YCoordinate * fy)
                                patched += 1
                            elif hasattr(anchor, "x") and anchor.x is not None:
                                anchor.x = round(anchor.x * fx + dx)
                                patched += 1
                except Exception as e:
                    print(f"warning: skipped subtable: {e}")
        print(f"GPOS anchors patched: {patched}")

    # ---- rename: strip ALL name records (legacy mac-platform names shadow the real font!) ----
    name = font["name"]
    name.names = []
    ps = family.replace(" ", "") + "-Regular"
    name.setName(family, 1, 3, 1, 0x409)
    name.setName("Regular", 2, 3, 1, 0x409)
    name.setName(f"{family};RL;{ps}", 3, 3, 1, 0x409)
    name.setName(f"{family} Regular", 4, 3, 1, 0x409)
    name.setName(f"Version {version}", 5, 3, 1, 0x409)
    name.setName(ps, 6, 3, 1, 0x409)
    name.setName(family, 16, 3, 1, 0x409)
    name.setName("Regular", 17, 3, 1, 0x409)

    out = os.path.expanduser(f"~/Library/Fonts/{ps}.ttf")
    font.save(out)
    print(f"saved: {out}")
    print(f"advance = {A} units (upem {upem}) | {stats}")


if __name__ == "__main__":
    if len(sys.argv) not in (3, 4):
        print(__doc__)
        sys.exit(1)
    main(sys.argv[1], sys.argv[2], sys.argv[3] if len(sys.argv) == 4 else "1.0")
