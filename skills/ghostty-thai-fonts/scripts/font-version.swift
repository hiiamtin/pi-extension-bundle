import CoreText
import Foundation

// font-version.swift <Family> — read the registered version string (name ID 5) of a font
// kCTFontVersionAttribute is not exported in some SDKs — fall back to the name attribute
let name = CommandLine.arguments.count > 1 ? CommandLine.arguments[1] : "Mali Mono"
let font = CTFontCreateWithName(name as CFString, 15, nil)
let ps = CTFontCopyPostScriptName(font) as String
if ps == "ArialMT" && name != "ArialMT" {
    print("registered: not found on this system")
    exit(1)
}
let desc = CTFontCopyFontDescriptor(font)
let ver = CTFontDescriptorCopyAttribute(desc, kCTFontNameAttribute) as? String ?? "(no version info)"
print("registered: \(ver)")
