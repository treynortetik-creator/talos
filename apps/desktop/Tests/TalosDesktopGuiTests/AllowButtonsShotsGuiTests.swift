import AppKit
import Foundation
import SwiftUI
import Testing
import TalosDesktopCore
import TalosTestSupport

@testable import TalosDesktop

// The Allow updates panel and the update window's waiting state, drawn in light and dark appearance. Runs only with TALOS_GUI_TESTS=1.
// Set TALOS_ALLOW_SHOTS_DIR to keep the PNGs somewhere you can open them; otherwise they go to a scratch folder.

@MainActor
@Suite("Allow buttons look (real AppKit)", .serialized, .guiExclusive, .enabled(if: guiTestsEnabled))
struct AllowButtonsShotsGuiTests {
  func shotsDir() throws -> String {
    let d = ProcessInfo.processInfo.environment["TALOS_ALLOW_SHOTS_DIR"] ?? (TestTemp.base + "talos-allow-shots-" + UUID().uuidString)
    try FileManager.default.createDirectory(atPath: d, withIntermediateDirectories: true)
    return d
  }

  /// Draws the view in the given appearance; returns the sRGB bitmap and writes the PNG.
  func render<V: View>(_ v: V, size: CGSize, dark: Bool, to path: String) async throws -> NSBitmapImageRep {
    _ = NSApplication.shared
    let host = NSHostingView(rootView: AnyView(v.frame(width: size.width, height: size.height)))
    let w = NSWindow(contentRect: NSRect(origin: .zero, size: size), styleMask: [.borderless], backing: .buffered, defer: false)
    w.isReleasedWhenClosed = false
    w.appearance = NSAppearance(named: dark ? .darkAqua : .aqua)
    w.contentView = host
    host.frame = NSRect(origin: .zero, size: size)
    host.layoutSubtreeIfNeeded()
    try await Task.sleep(nanoseconds: 600_000_000)
    host.layoutSubtreeIfNeeded()
    host.displayIfNeeded()
    let raw = try #require(host.bitmapImageRepForCachingDisplay(in: host.bounds))
    host.cacheDisplay(in: host.bounds, to: raw)
    let rep = try #require(raw.converting(to: NSColorSpace.sRGB, renderingIntent: .default))
    let png = try #require(rep.representation(using: .png, properties: [:]))
    try png.write(to: URL(fileURLWithPath: path))
    // what is checked is what was saved
    return try #require(NSBitmapImageRep(data: png))
  }

  /// (pixels near the Talos orange, pixels near the cream ground, pixels near white)
  func count(_ rep: NSBitmapImageRep) -> (orange: Int, cream: Int, ink: Int) {
    var o = 0, c = 0, wh = 0
    guard let data = rep.bitmapData else { return (0, 0, 0) }
    let per = rep.bitsPerPixel / 8
    for i in 0..<(rep.pixelsWide * rep.pixelsHigh) {
      let px = data + i * per
      let (r, g, b) = (Int(px[0]), Int(px[1]), Int(px[2]))
      let a = per >= 4 ? Int(px[3]) : 255
      guard a > 240 else { continue }  // the panel's rounded corners are clear
      if abs(r - 0xD9) < 16 && abs(g - 0x69) < 16 && abs(b - 0x2B) < 16 { o += 1 }
      if abs(r - 0xF3) < 12 && abs(g - 0xE6) < 12 && abs(b - 0xCF) < 12 { c += 1 }
      if r < 60 && g < 60 && b < 60 { wh += 1 }
    }
    return (o, c, wh)
  }

  @Test func thePanelAndTheWindowReadClearlyInLightAndDark() async throws {
    let dir = try shotsDir()
    let clone = NSHomeDirectory() + "/Library/Application Support/app.talos.desktop/talos"
    let c = CloneConfirmCenter()
    c.request(clone)
    let token = c.activePanel ?? CloneConfirmCenter.PanelToken(clone: clone, shownAt: -1000)
    let uc = UpdateController()
    uc.orderFront = { _ in }
    uc.apply(.needsAllow(version: "0.1.6", clone: clone))
    for dark in [false, true] {
      let tag = dark ? "dark" : "light"
      let panel = try await render(AllowUpdatesView(center: c, token: token), size: CGSize(width: 400, height: 190), dark: dark, to: dir + "/panel-\(tag).png")
      let win = try await render(UpdateWindow(controller: uc, allow: c), size: CGSize(width: 440, height: 250), dark: dark, to: dir + "/window-\(tag).png")
      for (name, rep) in [("panel", panel), ("window", win)] {
        let n = count(rep)
        #expect(n.orange > 1500, "\(name) \(tag): the filled orange Allow updates button is there (\(n.orange) px)")
        #expect(n.cream > 3000, "\(name) \(tag): the cream ground stays cream")
        #expect(n.ink > 300, "\(name) \(tag): dark ink text on the buttons (\(n.ink) px)")
      }
    }
  }

  @Test func theButtonsAreStillRealClickOnlyAndNotDefault() throws {
    _ = NSApplication.shared
    let c = CloneConfirmCenter()
    c.request("/home/alex/talos")
    let host = NSHostingView(rootView: AllowUpdatesView(center: c, token: c.activePanel ?? CloneConfirmCenter.PanelToken(clone: "/home/alex/talos", shownAt: -1000)))
    let w = NSWindow(contentRect: NSRect(x: 0, y: 0, width: 420, height: 220), styleMask: [.titled], backing: .buffered, defer: true)
    w.contentView = host
    host.layoutSubtreeIfNeeded()
    func all(_ v: NSView) -> [NSButton] { ((v as? NSButton).map { [$0] } ?? []) + v.subviews.flatMap(all) }
    let bs = all(host)
    #expect(Set(bs.map(\.title)) == ["Allow updates", "Not now"])
    #expect(bs.allSatisfy { $0.keyEquivalent.isEmpty } && w.defaultButtonCell == nil)
    #expect(bs.allSatisfy { $0.superview != nil && $0.frame.height >= 44 - 1 }, "pill is at least 44 pt tall")
  }
}
