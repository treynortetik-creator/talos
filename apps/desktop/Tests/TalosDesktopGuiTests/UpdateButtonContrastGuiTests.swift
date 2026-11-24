import AppKit
import Foundation
import SwiftUI
import Testing
import TalosDesktopCore
import TalosTestSupport

@testable import TalosDesktop

// Every button of the update flow (ready banner, Allow updates panel, update window, About, unsent-text notice) is drawn offscreen in
// light AND dark appearance. For each button the fill and the text colour are SAMPLED from the rendered pixels (the most common colour
// inside the button is the fill; the pixel farthest from it is the text) and the WCAG contrast ratio must be at least 4.5.
// GUI-gated (needs a window server for NSHostingView + cacheDisplay): runs only with TALOS_GUI_TESTS=1.
// Set TALOS_UPD_SHOTS_DIR to keep the labelled PNGs; otherwise they go to a scratch folder.

@MainActor
@Suite("Update-flow button contrast (real AppKit)", .serialized, .guiExclusive, .enabled(if: guiTestsEnabled))
struct UpdateButtonContrastGuiTests {
  static func luminance(_ r: Int, _ g: Int, _ b: Int) -> Double {
    func ch(_ v: Int) -> Double { let c = Double(v) / 255; return c <= 0.03928 ? c / 12.92 : pow((c + 0.055) / 1.055, 2.4) }
    return 0.2126 * ch(r) + 0.7152 * ch(g) + 0.0722 * ch(b)
  }
  static func ratio(_ a: (Int, Int, Int), _ b: (Int, Int, Int)) -> Double {
    let (x, y) = (luminance(a.0, a.1, a.2), luminance(b.0, b.1, b.2))
    return (max(x, y) + 0.05) / (min(x, y) + 0.05)
  }

  @Test func theWcagMathMatchesKnownValues() {
    #expect(abs(Self.ratio((0, 0, 0), (255, 255, 255)) - 21) < 0.01)
    #expect(Self.ratio((255, 255, 255), (255, 255, 255)) == 1)
  }

  func shotsDir() throws -> String {
    let d = ProcessInfo.processInfo.environment["TALOS_UPD_SHOTS_DIR"] ?? (TestTemp.base + "talos-upd-contrast-" + UUID().uuidString)
    try FileManager.default.createDirectory(atPath: d, withIntermediateDirectories: true)
    return d
  }

  func allButtons(_ v: NSView) -> [NSButton] { ((v as? NSButton).map { [$0] } ?? []) + v.subviews.flatMap(allButtons) }

  struct Found { var title: String; var ratio: Double; var fill: (Int, Int, Int); var text: (Int, Int, Int) }

  /// Renders `view` in the appearance, saves `<name>-<light|dark>.png`, and measures every button.
  func measure<V: View>(_ view: V, name: String, size: CGSize, dark: Bool, dir: String) async throws -> [Found] {
    _ = NSApplication.shared
    let host = NSHostingView(rootView: AnyView(view.frame(width: size.width, height: size.height)))
    let w = NSWindow(contentRect: NSRect(origin: .zero, size: size), styleMask: [.borderless], backing: .buffered, defer: false)
    w.isReleasedWhenClosed = false
    w.appearance = NSAppearance(named: dark ? .darkAqua : .aqua)
    w.contentView = host
    host.frame = NSRect(origin: .zero, size: size)
    host.layoutSubtreeIfNeeded()
    try await Task.sleep(nanoseconds: 500_000_000)
    host.layoutSubtreeIfNeeded()
    host.displayIfNeeded()
    let raw = try #require(host.bitmapImageRepForCachingDisplay(in: host.bounds))
    host.cacheDisplay(in: host.bounds, to: raw)
    let rep = try #require(raw.converting(to: NSColorSpace.sRGB, renderingIntent: .default))
    let png = try #require(rep.representation(using: .png, properties: [:]))
    try png.write(to: URL(fileURLWithPath: dir + "/\(name)-\(dark ? "dark" : "light").png"))
    let img = try #require(NSBitmapImageRep(data: png))
    let scale = Double(img.pixelsWide) / Double(size.width)
    var out: [Found] = []
    var rects: [(String, CGRect)] = []
    for b in allButtons(host) {
      let title = b.attributedTitle.string.isEmpty ? b.title : b.attributedTitle.string
      var r = host.convert(b.bounds, from: b)
      if !host.isFlipped { r.origin.y = host.bounds.height - r.maxY }
      rects.append((title, r))
    }
    for (title, r) in rects {
      let x0 = Int((r.minX + r.width * 0.08) * scale), x1 = Int((r.maxX - r.width * 0.08) * scale)
      let y0 = Int((r.minY + r.height * 0.2) * scale), y1 = Int((r.maxY - r.height * 0.2) * scale)
      guard x1 > x0, y1 > y0, let data = img.bitmapData else { continue }
      let per = img.bitsPerPixel / 8
      var px: [(Int, Int, Int)] = []
      for y in max(0, y0)..<min(img.pixelsHigh, y1) { for x in max(0, x0)..<min(img.pixelsWide, x1) {
        let p = data + (y * img.bytesPerRow + x * per); px.append((Int(p[0]), Int(p[1]), Int(p[2])))
      } }
      var tally: [Int: Int] = [:]
      for p in px { tally[(p.0 / 4) << 16 | (p.1 / 4) << 8 | (p.2 / 4), default: 0] += 1 }
      guard let top = tally.max(by: { $0.value < $1.value })?.key else { continue }
      let fill = ((top >> 16) * 4 + 2, ((top >> 8) & 255) * 4 + 2, (top & 255) * 4 + 2)
      let text = px.max(by: { Self.ratio($0, fill) < Self.ratio($1, fill) }) ?? fill
      out.append(Found(title: title, ratio: Self.ratio(text, fill), fill: fill, text: text))
    }
    return out
  }

  func controller(_ s: UpdateStatus) -> UpdateController {
    let uc = UpdateController(); uc.orderFront = { _ in }; uc.apply(s); return uc
  }

  @Test func everyUpdateFlowButtonReadsAtFourPointFiveToOneInLightAndDark() async throws {
    let dir = try shotsDir()
    let clone = "/home/alex/Library/Application Support/app.talos.desktop/talos"
    let allow = CloneConfirmCenter(); allow.request(clone)
    let token = allow.activePanel ?? CloneConfirmCenter.PanelToken(clone: clone, shownAt: -1000)
    let draft = DraftNoticeCenter()
    draft.present = { _ in }; draft.hide = {}
    let mem = MemoryDraftDigest()
    let dpath = TestTemp.base + "talos-draft-notice-" + UUID().uuidString + ".json"
    draft.path = { dpath }; draft.digests = mem
    _ = DraftNote.write(DraftNote(version: "0.1.9", text: "hello", partial: false, saved_at: Date().timeIntervalSince1970), to: dpath, digests: mem)
    draft.offer(version: "0.1.9", tried: false)
    defer { try? FileManager.default.removeItem(atPath: dpath) }

    let ready = controller(.ready(version: "0.1.9"))
    let waitingThreads = controller(.waitingForTurn(version: "0.1.9", why: [], draft: .none, threads: UpdateStatus.ThreadWait(names: ["Ada"])))
    struct Case { var name: String; var size: CGSize; var make: () -> AnyView; var expect: [String] }
    let cases: [Case] = [
      Case(name: "ready-banner", size: CGSize(width: 360, height: 110),
           make: { AnyView(UpdateBannerView(controller: ready, text: "Talos 0.1.9 is ready to update.", offersUpdate: true)) }, expect: ["Later", "Update now"]),
      Case(name: "allow-panel", size: CGSize(width: 400, height: 190),
           make: { AnyView(AllowUpdatesView(center: allow, token: token)) }, expect: [AllowUpdatesCopy.notNowButton, AllowUpdatesCopy.allowButton]),
      Case(name: "update-window-ready", size: CGSize(width: 440, height: 250),
           make: { AnyView(UpdateWindow(controller: ready, allow: allow)) }, expect: ["Later", AboutCopy.installButton]),
      Case(name: "update-window-allow", size: CGSize(width: 440, height: 250),
           make: { AnyView(UpdateWindow(controller: self.controller(.needsAllow(version: "0.1.9", clone: clone)), allow: allow)) }, expect: ["Close", AllowUpdatesCopy.allowButton]),
      Case(name: "update-window-skip", size: CGSize(width: 440, height: 250),
           make: { AnyView(UpdateWindow(controller: waitingThreads, allow: allow)) }, expect: ["Later", UpdateStatus.skipThreadWaitButton]),
      Case(name: "about-ready", size: CGSize(width: 400, height: 420),
           make: { AnyView(AboutView(controller: ready, allow: allow, version: "0.1.8", build: "5.06")) }, expect: [AboutCopy.installButton]),
      Case(name: "draft-notice", size: CGSize(width: 400, height: 260),
           make: { AnyView(DraftNoticeView(center: draft)) }, expect: [DraftNoticeCopy.copyButton, DraftNoticeCopy.dismissButton]),
    ]
    var report: [String] = []
    var failures: [String] = []
    for c in cases { for dark in [false, true] {
      let tag = "\(c.name) \(dark ? "dark" : "light")"
      let found = try await measure(c.make(), name: c.name, size: c.size, dark: dark, dir: dir)
      for want in c.expect {
        guard let f = found.first(where: { $0.title == want }) else { failures.append("\(tag): no button titled \"\(want)\" found (saw \(found.map(\.title)))"); continue }
        report.append("\(tag) | \(want) | \(String(format: "%.2f", f.ratio)) | fill \(f.fill) text \(f.text)")
        if f.ratio < 4.5 { failures.append("\(tag): \"\(want)\" is \(String(format: "%.2f", f.ratio)):1, under 4.5:1") }
      }
    } }
    try report.joined(separator: "\n").write(toFile: dir + "/ratios.txt", atomically: true, encoding: .utf8)
    #expect(failures.isEmpty, "\(failures.joined(separator: "\n"))")
  }
}
