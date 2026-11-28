import AppKit
import Foundation
import SwiftUI
import Testing
import TalosDesktopCore
import TalosTestSupport

@testable import TalosDesktop

// The Talos About window. Runs only with TALOS_GUI_TESTS=1. Screenshots go to TALOS_ALLOW_SHOTS_DIR (else a scratch folder) as about-<state>-<light|dark>.png.

@MainActor
@Suite("About Talos window (real AppKit)", .serialized, .guiExclusive, .enabled(if: guiTestsEnabled))
struct AboutWindowGuiTests {
  func controller(_ s: UpdateStatus) -> UpdateController {
    let uc = UpdateController()
    uc.orderFront = { _ in }
    uc.apply(s)
    return uc
  }

  func host(_ v: some View) -> NSView {
    _ = NSApplication.shared
    let h = NSHostingView(rootView: v)
    let w = NSWindow(contentRect: NSRect(x: 0, y: 0, width: 400, height: 420), styleMask: [.titled], backing: .buffered, defer: true)
    w.contentView = h
    h.layoutSubtreeIfNeeded()
    return h
  }
  func buttons(_ v: NSView) -> [NSButton] { ((v as? NSButton).map { [$0] } ?? []) + v.subviews.flatMap(buttons) }

  @Test func theAboutMenuItemOpensTheTalosWindowNotTheStockPanel() throws {
    let sources = URL(fileURLWithPath: #filePath).deletingLastPathComponent().deletingLastPathComponent().deletingLastPathComponent().appendingPathComponent("Sources")
    let en = FileManager.default.enumerator(at: sources, includingPropertiesForKeys: nil)
    var read = 0
    while let u = en?.nextObject() as? URL {
      guard u.pathExtension == "swift" else { continue }
      read += 1
      #expect(!(try String(contentsOf: u, encoding: .utf8)).contains("orderFrontStandardAboutPanel"), "\(u.lastPathComponent) still opens the stock panel")
    }
    #expect(read > 100)
    let actions = try String(contentsOf: sources.appendingPathComponent("TalosDesktop/AppMenuActions.swift"), encoding: .utf8)
    #expect(actions.contains(#"case .about: window("about")"#))
    let app = try String(contentsOf: sources.appendingPathComponent("TalosDesktop/App.swift"), encoding: .utf8)
    let menu = try String(contentsOf: sources.appendingPathComponent("TalosDesktop/StatusMenu.swift"), encoding: .utf8)
    #expect(app.contains(#"Window("About Talos", id: "about") { AboutView("#), "the window exists")
    #expect(menu.contains(#"Button("About Talos") {"#) && menu.contains(#"openWindow(id: "about")"#), "the menu bar item opens it")
  }

  @Test func theAppMenuActionOpensTheAboutWindowId() throws {
    cannotTakeTheKeyboard()
    _ = TmuxWorld.root
    TmuxWorld.hookBundle()
    try #require(SupervisorController.configPath.hasPrefix(TmuxWorld.root), "refusing to build a controller on the real config")
    let model = SupervisorController(store: MemoryStore())
    var opened: [String] = []
    AppMenuActions.perform(.about, model: model, open: { opened.append($0) })
    #expect(opened == ["about"])
  }

  @Test func theAppHasItsUpdaterBeforeSignInSoCheckForUpdatesCanLook() throws {
    cannotTakeTheKeyboard()
    _ = TmuxWorld.root
    TmuxWorld.hookBundle()
    try #require(SupervisorController.configPath.hasPrefix(TmuxWorld.root), "refusing to build a controller on the real config")
    let model = SupervisorController(store: MemoryStore())
    #expect(!model.configured, "this is the app before sign-in")
    #expect(model.autoUpdater != nil, "the updater is built from the first launch (its timer stays off until Talos is set up)")
  }

  @Test func theTalosMenuHasAboutAndCheckForUpdatesFromSwiftUIToo() throws {
    let sources = URL(fileURLWithPath: #filePath).deletingLastPathComponent().deletingLastPathComponent().deletingLastPathComponent().appendingPathComponent("Sources")
    let app = try String(contentsOf: sources.appendingPathComponent("TalosDesktop/App.swift"), encoding: .utf8)
    let i = try #require(app.range(of: "CommandGroup(replacing: .appInfo)"))
    let group = String(app[i.lowerBound...].prefix(500))
    let about = try #require(group.range(of: #"Button("About Talos")"#))
    let check = try #require(group.range(of: "Button(UpdateMenu.checkTitle)"))
    #expect(about.lowerBound < check.lowerBound, "Check for Updates is right below About")
    #expect(app.contains(".commands { TalosAppCommands() }"))
  }

  @Test func theButtonStartsExactlyOneCheckAndIsIgnoredWhileOneRuns() {
    let uc = controller(.idle)
    var runs = 0
    uc.checkOverride = { runs += 1; uc.apply(.checking) }
    uc.checkFromAbout()
    uc.checkFromAbout()  // a second press while checking
    #expect(runs == 1 && uc.aboutChecks == 1)
    uc.apply(.upToDate(version: "0.1.7"))
    uc.checkFromAbout()
    #expect(runs == 2, "a new check once the first is over")
    // an update that waits, or a question owed: no check
    uc.apply(.ready(version: "0.1.8"))
    uc.checkFromAbout()
    uc.apply(.needsAllow(version: "0.1.8", clone: "/home/alex/talos"))
    uc.checkFromAbout()
    #expect(runs == 2)
  }

  @Test func theInlineWordsFollowTheUpdateFlow() {
    #expect(AboutCopy.headline(.idle).isEmpty && AboutCopy.detail(.idle) == nil)
    #expect(AboutCopy.headline(.checking) == "Checking\u{2026}")
    #expect(AboutCopy.headline(.upToDate(version: "0.1.7")) == "Talos is up to date (0.1.7)")
    #expect(AboutCopy.headline(.ready(version: "0.1.8")) == "Talos 0.1.8 is ready")
    #expect(AboutCopy.headline(.waitingForQuiet(version: "0.1.8", why: ["draft"])) == "Waiting for a quiet moment")
    #expect(AboutCopy.headline(.failed(line: "The download did not match.", logPath: "~/log")).contains("didn\u{2019}t work"))
    #expect(AboutCopy.detail(.failed(line: "The download did not match.", logPath: "~/log"))?.contains("The download did not match.") == true)
    #expect(AboutCopy.version("0.1.7") == "Version 0.1.7")
    #expect(AboutCopy.build("5.06", version: "0.1.7") == "Build 5.06" && AboutCopy.build(nil, version: "0.1.7") == nil && AboutCopy.build("0.1.7", version: "0.1.7") == nil)
    #expect(AboutCopy.offersUpdateNow(.ready(version: "1")) && !AboutCopy.offersUpdateNow(.restarting(version: "1")) && !AboutCopy.offersUpdateNow(.waitingForTurn(version: "1")))
  }

  @Test func theButtonsPerStateAreTheRightOnesAndRealClickOnly() {
    let allowC = CloneConfirmCenter()
    func titles(_ s: UpdateStatus) -> [String] {
      let h = host(AboutView(controller: controller(s), allow: allowC, version: "0.1.7", build: "5.06"))
      let bs = buttons(h)
      #expect(bs.allSatisfy { $0.keyEquivalent.isEmpty })
      return bs.map(\.title)
    }
    #expect(titles(.ready(version: "0.1.8")) == ["Install"])
    #expect(titles(.needsAllow(version: "0.1.8", clone: "/home/alex/talos")) == ["Allow updates"])
    #expect(titles(.checking).isEmpty, "no second check while one runs, and no update button")
  }

  @Test func allowUpdatesHereFollowsTheSettleRule() {
    let c = CloneConfirmCenter()
    c.clickDelay = 1
    var clock: TimeInterval = 1000
    c.now = { clock }
    c.record = { nil }  // no record: a press that gets past the settle gate says so in `failure`
    let clone = "/home/alex/talos"
    _ = host(AboutView(controller: controller(.needsAllow(version: "0.1.8", clone: clone)), allow: c))
    c.allowFromWindow(clone: clone)
    #expect(c.failure == nil, "a press right after the window showed the folder is ignored")
    c.allowFromWindow(clone: "/home/alex/other")
    clock += 2
    c.allowFromWindow(clone: "/home/alex/other")
    #expect(c.failure == nil, "a folder the window never showed is refused")
    c.allowFromWindow(clone: clone)
    #expect(c.failure != nil, "after the settle time the press reaches the real accept path")
  }

  // MARK: screenshots

  func shotsDir() throws -> String {
    let d = ProcessInfo.processInfo.environment["TALOS_ALLOW_SHOTS_DIR"] ?? (TestTemp.base + "talos-about-shots-" + UUID().uuidString)
    try FileManager.default.createDirectory(atPath: d, withIntermediateDirectories: true)
    return d
  }

  @Test func everyStateIsDrawnInLightAndDark() throws {
    _ = NSApplication.shared
    OnboardingFonts.directoryOverride = URL(fileURLWithPath: #filePath).deletingLastPathComponent().deletingLastPathComponent().deletingLastPathComponent()
      .appendingPathComponent("Resources/onboarding")
    let dir = try shotsDir()
    let states: [(String, UpdateStatus)] = [
      ("idle", .idle), ("checking", .checking), ("uptodate", .upToDate(version: "0.1.7")), ("ready", .ready(version: "0.1.8")),
      ("waiting", .waitingForQuiet(version: "0.1.8", why: ["an agent is working"])), ("failed", .failed(line: "The download did not match its checksum.", logPath: "~/Library/Logs/Talos/apply.log")),
      ("allow", .needsAllow(version: "0.1.8", clone: "/home/alex/Library/Application Support/app.talos.desktop/talos")),
    ]
    for (name, st) in states {
      for dark in [false, true] {
        let size = CGSize(width: 400, height: 400)
        let uc = controller(st)
        let hostV = NSHostingView(rootView: AnyView(AboutView(controller: uc, allow: CloneConfirmCenter(), version: "0.1.7", build: "5.06").frame(width: size.width, height: size.height, alignment: .top)))
        let w = NSWindow(contentRect: NSRect(origin: .zero, size: size), styleMask: [.borderless], backing: .buffered, defer: false)
        w.isReleasedWhenClosed = false
        w.appearance = NSAppearance(named: dark ? .darkAqua : .aqua)
        w.contentView = hostV
        hostV.frame = NSRect(origin: .zero, size: size)
        hostV.layoutSubtreeIfNeeded()
        hostV.displayIfNeeded()
        let raw = try #require(hostV.bitmapImageRepForCachingDisplay(in: hostV.bounds))
        hostV.cacheDisplay(in: hostV.bounds, to: raw)
        let rep = try #require(raw.converting(to: NSColorSpace.sRGB, renderingIntent: .default))
        let png = try #require(rep.representation(using: .png, properties: [:]))
        try png.write(to: URL(fileURLWithPath: dir + "/about-\(name)-\(dark ? "dark" : "light").png"))
        let back = try #require(NSBitmapImageRep(data: png))
        let data = try #require(back.bitmapData)
        let per = back.bitsPerPixel / 8
        var orange = 0, ink = 0
        for i in 0..<(back.pixelsWide * back.pixelsHigh) {
          let px = data + i * per
          let (r, g, b) = (Int(px[0]), Int(px[1]), Int(px[2]))
          if abs(r - 0xD9) < 16 && abs(g - 0x69) < 16 && abs(b - 0x2B) < 16 { orange += 1 }
          if r < 60 && g < 60 && b < 60 { ink += 1 }
        }
        #expect(ink > 200, "\(name) \(dark ? "dark" : "light"): ink text drawn")
        // every state but the check in flight has a filled orange button
        if name != "checking" { #expect(orange > 3000, "\(name) \(dark ? "dark" : "light"): the orange button is there (\(orange))") }
      }
    }
  }
}
