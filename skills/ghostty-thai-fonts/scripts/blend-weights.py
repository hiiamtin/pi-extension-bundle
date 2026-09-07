#!/usr/bin/env python3
"""blend-weights.py <regular.ttf> <heavier.ttf> <t> <out.ttf>

Interpolate two compatible static fonts (same glyph names, same point counts)
to create an in-between weight. t=0 -> regular, t=1 -> heavier.
Glyphs that are not compatible keep the regular outline.

Example: blend-weights.py Mali-Regular.ttf Mali-Medium.ttf 0.2 out.ttf
(weight becomes ~400 + 0.2*(500-400) = 420)
"""
import sys, os
from fontTools.ttLib import TTFont
from fontTools.ttLib.tables._g_l_y_f import GlyphCoordinates


def main(reg_path, med_path, t, out):
    reg = TTFont(reg_path)
    med = TTFont(med_path)

    if reg["head"].unitsPerEm != med["head"].unitsPerEm:
        print("error: unitsPerEm mismatch"); sys.exit(1)

    rglyf, mglyf = reg["glyf"], med["glyf"]
    rhmtx, mhmtx = reg["hmtx"], med["hmtx"]

    ok = bad = 0
    for gname in reg.getGlyphOrder():
        if gname not in mglyf.keys():
            bad += 1; continue
        rg, mg = rglyf[gname], mglyf[gname]

        # advance widths blend
        ra, ma = rhmtx[gname][0], mhmtx[gname][0]
        rhmtx[gname] = (round(ra + (ma - ra) * t), rhmtx[gname][1])

        if rg.numberOfContours != mg.numberOfContours:
            bad += 1; continue  # keep regular outline
        if rg.numberOfContours == 0:
            bad += 1; continue  # empty glyph, nothing to blend

        if rg.isComposite():
            if len(rg.components) != len(mg.components):
                bad += 1; continue
            good = True
            for cr, cm in zip(rg.components, mg.components):
                if cr.glyphName != cm.glyphName:
                    good = False; break
            if not good:
                bad += 1; continue
            for cr, cm in zip(rg.components, mg.components):
                cr.x = round(cr.x + (cm.x - cr.x) * t)
                cr.y = round(cr.y + (cm.y - cr.y) * t)
            ok += 1
        else:
            if len(rg.coordinates) != len(mg.coordinates):
                bad += 1; continue
            if rg.endPtsOfContours != mg.endPtsOfContours:
                bad += 1; continue
            newc = GlyphCoordinates([
                (round(x + (mx - x) * t), round(y + (my - y) * t))
                for (x, y), (mx, my) in zip(rg.coordinates, mg.coordinates)
            ])
            rg.coordinates = newc
            ok += 1

    # GPOS/GSUB stay from regular (anchor delta at small t is negligible)

    reg.save(out)
    print(f"blended t={t}: {ok} glyphs interpolated, {bad} kept regular")
    print(f"saved: {out}")


if __name__ == "__main__":
    if len(sys.argv) != 5:
        print(__doc__); sys.exit(1)
    main(sys.argv[1], sys.argv[2], float(sys.argv[3]), sys.argv[4])
