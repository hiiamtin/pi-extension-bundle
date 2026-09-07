import AppKit
import CoreText
import Foundation

// measure.swift — measure Thai glyph widths against the primary font's cell
// usage: measure.swift list
//        measure.swift check <primaryFont> <font1> <font2> ...
//        measure.swift preview <output.png> [primaryFont]

// Spacing Thai glyphs only (consonants + spacing vowels); combining marks excluded
let thaiScalars: [UniChar] = Array("กขคงจดตถทนบปผฝพฟมยรลวสหอฮะาเแโใไๆ็่้๊๋".unicodeScalars.map { UniChar($0.value) })

func thaiFonts() -> [(String, CTFontDescriptor)] {
    let collection = CTFontCollectionCreateFromAvailableFonts([:] as CFDictionary)
    let descs = CTFontCollectionCreateMatchingFontDescriptors(collection) as! [CTFontDescriptor]
    var out: [(String, CTFontDescriptor)] = []
    var seen = Set<String>()
    for d in descs {
        guard let fam = CTFontDescriptorCopyAttribute(d, kCTFontFamilyNameAttribute) as? String else { continue }
        guard let langs = CTFontDescriptorCopyAttribute(d, kCTFontLanguagesAttribute) as? [String], langs.contains("th") else { continue }
        if seen.insert(fam).inserted { out.append((fam, d)) }
    }
    return out.sorted { $0.0 < $1.0 }
}

func measure(_ f: CTFont, cellW: Double) -> (max: Double, min: Double, avg: Double, count: Int, over: Int) {
    var widths: [Double] = []
    for u in thaiScalars {
        var g = CGGlyph()
        let buf: [UniChar] = [u]
        CTFontGetGlyphsForCharacters(f, buf, &g, 1)
        if g == 0 { continue }
        var adv = CGSize()
        CTFontGetAdvancesForGlyphs(f, .horizontal, [g], &adv, 1)
        widths.append(Double(adv.width))
    }
    guard !widths.isEmpty else { return (0, 0, 0, 0, 0) }
    let over = widths.filter { $0 > cellW }.count
    return (widths.max()!, widths.min()!, widths.reduce(0,+)/Double(widths.count), widths.count, over)
}

func cellWidth(_ name: String) -> Double {
    let f = CTFontCreateWithName(name as CFString, 15, nil)
    var g = CGGlyph()
    let buf: [UniChar] = [0x61] // 'a'
    CTFontGetGlyphsForCharacters(f, buf, &g, 1)
    var adv = CGSize()
    CTFontGetAdvancesForGlyphs(f, .horizontal, [g], &adv, 1)
    return Double(adv.width)
}

let args = Array(CommandLine.arguments.dropFirst())
let mode = args.first ?? "list"

switch mode {
case "list":
    for (fam, _) in thaiFonts() { print(fam) }

case "check":
    guard args.count >= 3 else { print("usage: measure.swift check <primaryFont> <font...>"); exit(1) }
    let primary = args[1]
    let cellW = cellWidth(primary)
    print(String(format: "cell of %@ @15pt = %.2f pt", primary, cellW))
    print("")
    for name in args.dropFirst(2) {
        let f = CTFontCreateWithName(name as CFString, 15, nil)
        let ps = CTFontCopyPostScriptName(f) as String
        if ps == "ArialMT" && name != "ArialMT" {
            print("\(name): not found on this system"); print(""); continue
        }
        let m = measure(f, cellW: cellW)
        if m.count == 0 { print("\(name): no Thai glyphs"); print(""); continue }
        let ok = m.max <= cellW
        let verdict = ok
            ? "OK — no overlap (0% adjust works)"
            : String(format: "OVERLAP — needs adjust-cell-width ~%.0f%% to fully clear", (m.max/cellW-1)*100)
        print(String(format: "%@", name))
        print(String(format: "   max %3.0f%% | min %3.0f%% | avg %3.0f%% | %d/%d glyphs exceed cell", m.max/cellW*100, m.min/cellW*100, m.avg/cellW*100, m.over, m.count))
        print("   \(verdict)")
        print("")
    }

case "preview":
    let out = args.count > 1 ? args[1] : "/tmp/thai_font_preview.png"
    let primary = args.count > 2 ? args[2] : "AnnotationM NFM"
    let cellW = cellWidth(primary)
    let sample = "สวัสดีครับ ทดสอบภาษาไทย Hello 123"
    let fonts = thaiFonts().sorted { a, b in
        let ma = measure(CTFontCreateWithName(a.0 as CFString, 15, nil), cellW: cellW)
        let mb = measure(CTFontCreateWithName(b.0 as CFString, 15, nil), cellW: cellW)
        if (ma.max <= cellW) != (mb.max <= cellW) { return ma.max <= cellW }
        return a.0 < b.0
    }
    let rowH: CGFloat = 36
    let W: CGFloat = 740
    let H = rowH * CGFloat(fonts.count) + 10
    let img = NSImage(size: NSSize(width: W, height: H))
    img.lockFocusFlipped(true)
    NSColor(calibratedWhite: 0.97, alpha: 1).setFill()
    NSRect(x: 0, y: 0, width: W, height: H).fill()
    var y: CGFloat = 5
    for (fam, _) in fonts {
        let m = measure(CTFontCreateWithName(fam as CFString, 15, nil), cellW: cellW)
        let ok = m.max <= cellW && m.count > 0
        NSAttributedString(string: fam, attributes: [
            .font: NSFont.monospacedSystemFont(ofSize: 10, weight: .regular),
            .foregroundColor: ok ? NSColor.systemGreen : NSColor.gray
        ]).draw(at: NSPoint(x: 10, y: y + 10))
        NSAttributedString(string: ok ? "✓" : " ", attributes: [
            .font: NSFont.systemFont(ofSize: 14), .foregroundColor: NSColor.systemGreen
        ]).draw(at: NSPoint(x: 195, y: y + 9))
        let font = NSFont(name: fam, size: 15) ?? NSFont.systemFont(ofSize: 15)
        NSAttributedString(string: sample, attributes: [.font: font, .foregroundColor: NSColor.black])
            .draw(at: NSPoint(x: 215, y: y + 8))
        y += rowH
    }
    img.unlockFocus()
    if let tiff = img.tiffRepresentation, let rep = NSBitmapImageRep(data: tiff),
       let png = rep.representation(using: .png, properties: [:]) {
        try! png.write(to: URL(fileURLWithPath: out))
        print("saved \(fonts.count) fonts -> \(out)")
    } else {
        print("RENDER FAIL"); exit(1)
    }

default:
    print("modes: list | check | preview")
    exit(1)
}
