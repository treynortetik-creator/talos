import Foundation
import Testing

@testable import TalosDesktopCore
import TalosTestSupport

/// "Allow Talos to update itself?": what may count as accepted without a click, the words, and that no screen points at a window that
/// is gone. The prompt itself (the real click) is in AllowUpdatesGuiTests.
@Suite("Allow updates: words and the own-clone rule")
struct AllowUpdatesCoreTests {
  /// A scratch home with the app's own folder, a whole clone at the app's fixed place and the app's own record of it.
  struct Home {
    let scratch = AgentFolderSetupTests.Scratch()
    let home: String
    let clone: String
    let record: String
    init() throws {
      home = try TestTemp.real(scratch.root)
      clone = AutoSetup.cloneFolder(home: home)
      record = AutoSetup.appFolder(home: home) + "/checkout"
      try Self.makeClone(clone)
      try Self.write(record, clone + "\n")
    }
    static func makeClone(_ dir: String) throws {
      for f in ["install.sh", "plugins/talos-app-mod/x", "apps/bridge/src/cli.ts"] {
        try write(dir + "/" + f, "x\n")
      }
    }
    static func write(_ path: String, _ text: String) throws {
      try FileManager.default.createDirectory(atPath: (path as NSString).deletingLastPathComponent, withIntermediateDirectories: true)
      try Data(text.utf8).write(to: URL(fileURLWithPath: path))
    }
    var rec: (clone: String, file: String) { (clone, record) }
  }

  // MARK: the onboarding's own clone may count as accepted, a planted one may not

  @Test func theAppsOwnFixedPlaceCloneThatPassesTheChecksCountsAsAccepted() throws {
    let h = try Home()
    #expect(AgentFolderSetup.ownCloneMayBeAccepted(clone: h.clone, record: h.rec, home: h.home, unsafe: []))
  }

  @Test func aPlantedCloneIsStillAsked() throws {
    let h = try Home()
    // a whole, tidy clone somewhere else, recorded by hand in the app's own record file
    let planted = h.home + "/planted"
    try Home.makeClone(planted)
    try Home.write(h.record, planted + "\n")
    #expect(!AgentFolderSetup.ownCloneMayBeAccepted(clone: planted, record: (planted, h.record), home: h.home, unsafe: []), "not the fixed place")
    // the fixed place, but the record that names it is the old folder's (an install.sh run from Terminal wrote it)
    let old = h.home + "/Library/Application Support/Talos/checkout"
    try Home.write(old, h.clone + "\n")
    #expect(!AgentFolderSetup.ownCloneMayBeAccepted(clone: h.clone, record: (h.clone, old), home: h.home, unsafe: []), "not the app's own record")
    // the record names another clone than the one the app says it made
    #expect(!AgentFolderSetup.ownCloneMayBeAccepted(clone: h.clone, record: (planted, h.record), home: h.home, unsafe: []))
    // no record at all
    #expect(!AgentFolderSetup.ownCloneMayBeAccepted(clone: h.clone, record: nil, home: h.home, unsafe: []))
  }

  @Test func theFixedPlaceCloneStillHasToPassEveryCheck() throws {
    let h = try Home()
    chmod(h.clone, 0o777)
    #expect(!AgentFolderSetup.ownCloneMayBeAccepted(clone: h.clone, record: h.rec, home: h.home, unsafe: []), "writable by others")
    chmod(h.clone, 0o755)
    #expect(AgentFolderSetup.ownCloneMayBeAccepted(clone: h.clone, record: h.rec, home: h.home, unsafe: []))
    #expect(!AgentFolderSetup.ownCloneMayBeAccepted(clone: h.clone, record: h.rec, home: h.home, unsafe: [h.home]), "inside a session folder")
    #expect(!AgentFolderSetup.ownCloneMayBeAccepted(clone: h.clone, record: h.rec, home: h.home, unsafe: [], uid: getuid() + 1), "another user's")
    try FileManager.default.removeItem(atPath: h.clone + "/install.sh")
    #expect(!AgentFolderSetup.ownCloneMayBeAccepted(clone: h.clone, record: h.rec, home: h.home, unsafe: []), "not whole")
  }

  // MARK: the words

  @Test func theWaitingStateAsksTheOwnerAndOffersTheButton() {
    let s = UpdateStatus.needsAllow(version: "0.1.6", clone: "/home/alex/talos")
    #expect(s.words.headline == "Allow Talos to update itself?")
    #expect(s.words.detail.contains("/home/alex/talos"), "the folder is named")
    #expect(s.allowClone == "/home/alex/talos" && s.pendingVersion == nil && !s.isBusy)
    #expect(UpdateMenu.title(s) == UpdateMenu.checkTitle)
    #expect(AllowUpdatesCopy.allowButton == "Allow updates" && AllowUpdatesCopy.notNowButton == "Not now")
    #expect(AllowUpdatesCopy.menuItem == "Allow updates\u{2026}")
  }

  @Test func theQuestionUsesTheNewWordsAndShowsAShortPath() {
    #expect(AllowUpdatesCopy.title == "Allow Talos to update itself?")
    #expect(
      AllowUpdatesCopy.body("/home/alex/talos", home: "/home/alex")
        == "Talos keeps itself up to date from this folder: ~/talos. Allow it if this is where you installed Talos.")
    // a folder outside home, and a home that only shares a prefix, stay whole
    #expect(AllowUpdatesCopy.shownPath("/opt/talos", home: "/home/alex") == "/opt/talos")
    #expect(AllowUpdatesCopy.shownPath("/home/" + "alexander/talos", home: "/home/alex") == "/home/" + "alexander/talos")
    let long = "/home/alex/Library/Application Support/app.talos.desktop/some/very/deep/folder/of/talos/code"
    let shown = AllowUpdatesCopy.shownPath(long, home: "/home/alex")
    #expect(shown.count <= 56 && shown.hasPrefix("~/Library") && shown.hasSuffix("talos/code") && shown.contains("\u{2026}"))
    #expect(!AllowUpdatesCopy.shownPath("/home/alex/a\nb", home: "/home/alex").contains("\n"), "one line")
    #expect(!AllowUpdatesCopy.body("/home/alex/talos", home: "/home/alex").contains("has not used it"), "the old wording is gone")
  }

  /// WCAG contrast of the button text and the panel text on their grounds (the same hexes the onboarding screens use).
  @Test func buttonAndPanelTextMeetFourPointFiveToOne() {
    func lum(_ hex: Int) -> Double {
      func c(_ v: Int) -> Double { let x = Double(v) / 255; return x <= 0.03928 ? x / 12.92 : pow((x + 0.055) / 1.055, 2.4) }
      return 0.2126 * c(hex >> 16 & 255) + 0.7152 * c(hex >> 8 & 255) + 0.0722 * c(hex & 255)
    }
    func ratio(_ a: Int, _ b: Int) -> Double { let (x, y) = (lum(a), lum(b)); return (max(x, y) + 0.05) / (min(x, y) + 0.05) }
    #expect(ratio(0x141110, 0xD9692B) >= 4.5, "Allow updates: ink on orange")
    #expect(ratio(0x141110, 0xF3E6CF) >= 4.5, "Not now: ink on cream")
    #expect(ratio(0x5A4A3C, 0xF3E6CF) >= 4.5, "body text on cream")
  }

  @Test func theLineInTheThreadNamesTheRealPlaces() {
    let line = AutoUpdate.cloneNeedsOKLine("/home/alex/talos")
    #expect(line.contains("/home/alex/talos") && line.contains("Allow updates\u{2026}") && line.contains("update window"))
  }

  // MARK: no user string sends the owner to a window that was renamed

  private static let desktop = URL(fileURLWithPath: #filePath).deletingLastPathComponent().deletingLastPathComponent().deletingLastPathComponent()

  /// The old pointer was "Open the Set up window (Agent folder) and press Use this clone". The Set up window is now the first-run screens;
  /// the clone card lives in the Advanced window and is for Create, Adopt and Choose only.
  @Test func noUserStringPointsAtTheOldWindowForAcceptance() throws {
    let sources = Self.desktop.appendingPathComponent("Sources")
    let web = Self.desktop.deletingLastPathComponent().appendingPathComponent("web/src/features/help/content.ts")
    var files = [web]
    let en = FileManager.default.enumerator(at: sources, includingPropertiesForKeys: nil)
    while let u = en?.nextObject() as? URL { if u.pathExtension == "swift" { files.append(u) } }
    var checked = 0
    for f in files {
      let text = try String(contentsOf: f, encoding: .utf8)
      checked += 1
      for bad in ["Set up window", "(Agent folder) and press", "press Use this clone"] {
        #expect(!text.contains(bad), Comment(rawValue: "\(f.lastPathComponent) still says “\(bad)”"))
      }
    }
    #expect(checked > 100, "the scan really read the sources")
  }

  @Test func theMenuBarItemAndTheWindowButtonAreReallyThere() throws {
    let app = try String(contentsOf: Self.desktop.appendingPathComponent("Sources/TalosDesktop/StatusMenu.swift"), encoding: .utf8)
    #expect(app.contains(#"Button("Allow updates\u{2026}")"#) && app.contains("allowUpdates.pending != nil"), "shown only while an answer is owed")
    let win = try String(contentsOf: Self.desktop.appendingPathComponent("Sources/TalosDesktop/UpdateWindow.swift"), encoding: .utf8)
    #expect(win.contains("PillRealClickButton(title: AllowUpdatesCopy.allowButton"))
    let panel = try String(contentsOf: Self.desktop.appendingPathComponent("Sources/TalosDesktop/CloneConfirmCenter.swift"), encoding: .utf8)
    #expect(panel.contains("PillRealClickButton(title: AllowUpdatesCopy.notNowButton") && panel.contains("PillRealClickButton(title: AllowUpdatesCopy.allowButton"))
  }
}
