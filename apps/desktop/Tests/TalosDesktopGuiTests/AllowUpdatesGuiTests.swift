import AppKit
import Foundation
import SwiftUI
import Testing
import TalosDesktopCore
import TalosTestSupport

@testable import TalosDesktop

// "Allow Talos to update itself?" with the real AppKit pieces. Runs only with TALOS_GUI_TESTS=1. Nothing is put on the screen and no
// event is posted; the Keychain is a memory double, the record and the clone are real files in a scratch home.

@MainActor
@Suite("Allow updates prompt (real AppKit)", .serialized, .guiExclusive, .enabled(if: guiTestsEnabled))
struct AllowUpdatesGuiTests {
  /// A scratch home with a whole clone, and the record naming it, written the way `install.sh --from-release` writes it.
  struct World {
    let home: String
    let clone: String
    let record: String
    init() throws {
      let raw = TestTemp.base + "talos-allow-" + UUID().uuidString
      try FileManager.default.createDirectory(atPath: raw, withIntermediateDirectories: true)
      home = try TestTemp.real(raw)
      clone = home + "/Library/Application Support/app.talos.desktop/talos"
      record = home + "/Library/Application Support/app.talos.desktop/checkout"
      for f in ["install.sh", "plugins/talos-app-mod/x", "apps/bridge/src/cli.ts"] {
        try FileManager.default.createDirectory(atPath: ((clone + "/" + f) as NSString).deletingLastPathComponent, withIntermediateDirectories: true)
        try Data("x\n".utf8).write(to: URL(fileURLWithPath: clone + "/" + f))
      }
      try Data((clone + "\n").utf8).write(to: URL(fileURLWithPath: record))
    }
    /// Another whole clone next to the first, and the record rewritten to name it (what a re-run of install.sh does).
    func recordOther() throws -> String {
      let other = home + "/Library/Application Support/app.talos.desktop/other"
      for f in ["install.sh", "plugins/talos-app-mod/x", "apps/bridge/src/cli.ts"] {
        try FileManager.default.createDirectory(atPath: ((other + "/" + f) as NSString).deletingLastPathComponent, withIntermediateDirectories: true)
        try Data("x\n".utf8).write(to: URL(fileURLWithPath: other + "/" + f))
      }
      try Data((other + "\n").utf8).write(to: URL(fileURLWithPath: record))
      return other
    }
    func remove() { try? FileManager.default.removeItem(atPath: home) }
    var rec: (clone: String, file: String)? { AgentFolderSetup.recordedCheckout(in: AutoSetup.recordFolders(home: home)) }
  }

  final class Shown { var count = 0; var hidden = 0; var accepted = 0; var tokens: [CloneConfirmCenter.PanelToken] = []; var clock: TimeInterval = 1000 }

  func center(_ w: World, _ acceptance: MemoryCloneAcceptance, _ shown: Shown) -> CloneConfirmCenter {
    let c = CloneConfirmCenter()
    c.acceptance = acceptance
    c.record = { w.rec }
    c.unsafe = { [] }
    c.present = { _, t in shown.count += 1; shown.tokens.append(t) }
    c.now = { shown.clock }
    c.clickDelay = 1
    c.dismiss = { shown.hidden += 1 }
    c.onAccepted = { shown.accepted += 1 }
    return c
  }

  func buttons(_ v: NSView) -> [NSButton] { (v as? NSButton).map { [$0] } ?? [] + v.subviews.flatMap(buttons) }

  func host<V: View>(_ v: V) -> (NSWindow, NSView) {
    let w = NSWindow(contentRect: NSRect(x: 0, y: 0, width: 420, height: 220), styleMask: [.titled], backing: .buffered, defer: true)
    let h = NSHostingView(rootView: v)
    w.contentView = h
    h.layoutSubtreeIfNeeded()
    return (w, h)
  }

  /// What the app's launch (and its poll) finds: the record and the Keychain, as the wiring reads them.
  func unaccepted(_ w: World, _ a: MemoryCloneAcceptance) -> String? {
    AgentFolderSetup.unacceptedRecordedClone(record: w.rec, accepted: a.accepted(), unsafe: [])
  }

  // MARK: ROOT CAUSE, reproduced

  /// A release-built app has no `TalosCheckout`, and the clone a hand-run `install.sh --from-release` recorded was never accepted. The
  /// updater said "awaiting_clone_acceptance" and the owner found no button anywhere. The prompt now comes from the record itself, at
  /// launch, with nothing from the updater needed first.
  @Test func aReleaseBuiltAppWithARecordedUnacceptedCloneShowsThePromptAtLaunch() throws {
    _ = NSApplication.shared
    let w = try World()
    defer { w.remove() }
    let keychain = MemoryCloneAcceptance()
    let shown = Shown()
    let c = center(w, keychain, shown)
    // the release app: no stamped clone, so the updater's only candidate is the record, which needs the Keychain's yes
    #expect(AgentFolderSetup.updaterCheckout(stamped: nil, record: w.rec, accepted: keychain.accepted(), unsafe: []) == nil, "the update has no clone to use")
    #expect(c.pending == nil && shown.count == 0)
    c.sync(unaccepted: unaccepted(w, keychain))  // what AllowUpdatesWatch does at launch
    #expect(c.pending == w.clone && c.visible && shown.count == 1, "the prompt is up")
    // and it is the real window: its title, the folder in plain words, and the two buttons
    let (_, root) = host(AllowUpdatesView(center: c, token: c.activePanel ?? CloneConfirmCenter.PanelToken(clone: c.pending ?? "", shownAt: -1000)))
    let titles = buttons(root).map(\.title)
    #expect(titles.contains("Allow updates") && titles.contains("Not now"))
    #expect(c.acceptance.accepted() == nil, "nothing was accepted by showing it")
  }

  @Test func theUpdateWindowShowsAllowUpdatesDirectlyWhileItWaits() throws {
    _ = NSApplication.shared
    let w = try World()
    defer { w.remove() }
    let uc = UpdateController()
    uc.orderFront = { _ in }
    uc.apply(.needsAllow(version: "0.1.6", clone: w.clone))
    let (_, root) = host(UpdateWindow(controller: uc, allow: center(w, MemoryCloneAcceptance(), Shown())))
    let allow = try #require(buttons(root).first { $0.title == "Allow updates" })
    #expect(allow.keyEquivalent.isEmpty)
  }

  // MARK: only a real click

  @Test func aPressThatIsNoRealClickNeverAcceptsAndTheModelAcceptsExactlyWhatWasShown() throws {
    _ = NSApplication.shared
    let w = try World()
    defer { w.remove() }
    let keychain = MemoryCloneAcceptance()
    let shown = Shown()
    let c = center(w, keychain, shown)
    c.request(w.clone)
    let (win, root) = host(AllowUpdatesView(center: c, token: c.activePanel ?? CloneConfirmCenter.PanelToken(clone: c.pending ?? "", shownAt: -1000)))
    let allow = try #require(buttons(root).first { $0.title == "Allow updates" })
    #expect(allow.keyEquivalent.isEmpty && win.defaultButtonCell == nil, "Return does nothing")
    // an Accessibility press, an AppleScript press, a program's call: the action runs with no mouse event behind it
    click(allow)
    click(allow)
    #expect(keychain.accepted() == nil && shown.accepted == 0, "refused")
    #expect(c.pending == w.clone && c.visible)
    // the action a real click reaches
    c.allow(clone: w.clone)
    #expect(keychain.accepted() == w.clone && shown.accepted == 1 && c.pending == nil && !c.visible)
  }

  @Test func theAnswerBindsWhatWasShownAndRefusesAChangedOrUnsafeRecord() throws {
    _ = NSApplication.shared
    let w = try World()
    defer { w.remove() }
    let keychain = MemoryCloneAcceptance()
    let c = center(w, keychain, Shown())
    c.request(w.clone)
    // another caller reuses the old prompt for a clone it did not show
    c.allow(clone: "/home/alex/other")
    #expect(keychain.accepted() == nil && c.failure != nil)
    // the record changes under the open prompt
    try Data("/home/alex/other\n".utf8).write(to: URL(fileURLWithPath: w.record))
    c.allow(clone: w.clone)
    #expect(keychain.accepted() == nil && c.failure?.contains("changed") == true)
    // the clone is made loose after it was shown
    try Data((w.clone + "\n").utf8).write(to: URL(fileURLWithPath: w.record))
    chmod(w.clone, 0o777)
    c.allow(clone: w.clone)
    #expect(keychain.accepted() == nil && c.failure?.contains("written by other users") == true, "\(c.failure ?? "nil")")
    // the Keychain refuses: the owner is told, nothing is claimed
    chmod(w.clone, 0o755)
    keychain.failing = true
    c.allow(clone: w.clone)
    #expect(keychain.accepted() == nil && c.failure?.contains("Keychain") == true && c.pending == w.clone)
  }

  // MARK: Not now

  @Test func notNowLeavesItUnacceptedAndItComesBackOnlyForANewReleaseOrTheMenu() throws {
    _ = NSApplication.shared
    let w = try World()
    defer { w.remove() }
    let keychain = MemoryCloneAcceptance()
    let shown = Shown()
    let c = center(w, keychain, shown)
    c.request(w.clone, version: "0.1.6")
    c.notNow()
    #expect(keychain.accepted() == nil && !c.visible && c.pending == w.clone && shown.hidden == 1)
    // the poll and the next hourly check for the same release do not nag
    c.sync(unaccepted: w.clone)
    c.request(w.clone, version: "0.1.6")
    #expect(shown.count == 1 && !c.visible, "hidden until the next release")
    // the menu item brings it back
    c.showAgain()
    #expect(c.visible && shown.count == 2)
    c.notNow()
    // a new release asks again
    c.request(w.clone, version: "0.1.7")
    #expect(c.visible && shown.count == 3)
    // accepted somewhere else (the record settles): the prompt and the menu item go
    c.sync(unaccepted: nil)
    #expect(c.pending == nil && !c.visible)
  }

  // MARK: the update proceeds

  @Test func afterAcceptanceTheUpdaterHasAClone() throws {
    let w = try World()
    defer { w.remove() }
    let keychain = MemoryCloneAcceptance()
    #expect(AgentFolderSetup.updaterCheckout(stamped: nil, record: w.rec, accepted: keychain.accepted(), unsafe: []) == nil)
    #expect(keychain.accept(w.clone))
    #expect(AgentFolderSetup.updaterCheckout(stamped: nil, record: w.rec, accepted: keychain.accepted(), unsafe: []) == w.clone)
    #expect(unaccepted(w, keychain) == nil, "nothing is asked any more")
  }

  // MARK: a visible prompt never changes its clone

  @Test func aSwapWhileShownDismissesTheOldPanelRefusesItsClickAndTheNewPanelIgnoresAnImmediateClick() throws {
    _ = NSApplication.shared
    let w = try World()
    defer { w.remove() }
    let keychain = MemoryCloneAcceptance()
    let shown = Shown()
    let c = center(w, keychain, shown)
    c.request(w.clone)
    let old = try #require(shown.tokens.last)
    shown.clock += 5  // the owner has been looking at it a while
    // the record changes to another clone while the first panel is up, and the watch finds it
    let other = try w.recordOther()
    c.sync(unaccepted: other)
    #expect(shown.hidden >= 1 && shown.count == 2, "the old panel was taken down and a new one made")
    let fresh = try #require(shown.tokens.last)
    #expect(fresh.id != old.id && fresh.clone == other && c.activePanel == fresh)
    // a click that lands on the old panel (it was on screen a moment ago) accepts nothing, for either clone
    c.allow(clone: w.clone, panel: old)
    c.allow(clone: other, panel: old)
    #expect(keychain.accepted() == nil, "the dismissed panel is refused")
    // the new panel ignores a click made the instant it appears
    c.allow(clone: other, panel: fresh)
    #expect(keychain.accepted() == nil && c.pending == other, "ignored inside the settle time")
    // a click on the new panel for the clone the OLD one named is refused too
    shown.clock += 2
    c.allow(clone: w.clone, panel: fresh)
    #expect(keychain.accepted() == nil)
    // after the settle time the new panel works, for exactly its own clone
    c.allow(clone: other, panel: fresh)
    #expect(keychain.accepted() == other && c.pending == nil)
  }

  @Test func theAnswerIsRefusedWhenTheRecordChangedBetweenRenderAndClick() throws {
    _ = NSApplication.shared
    let w = try World()
    defer { w.remove() }
    let keychain = MemoryCloneAcceptance()
    let shown = Shown()
    let c = center(w, keychain, shown)
    c.request(w.clone)
    let t = try #require(shown.tokens.last)
    shown.clock += 5
    _ = try w.recordOther()  // the record now names another clone; the poll has not run yet
    c.allow(clone: w.clone, panel: t)
    #expect(keychain.accepted() == nil && c.failure?.contains("changed") == true)
  }

  @Test func theLaunchLooksFirstVersionIsNotANewReleaseSoNotNowHolds() throws {
    _ = NSApplication.shared
    let w = try World()
    defer { w.remove() }
    let shown = Shown()
    let c = center(w, MemoryCloneAcceptance(), shown)
    c.request(w.clone)  // the launch watch: no version
    c.notNow()
    c.request(w.clone, version: "0.1.6")  // the first check meets the same clone
    #expect(!c.visible && shown.count == 1, "nil then v1 is not a new release")
    c.request(w.clone, version: "0.1.6")
    #expect(!c.visible && shown.count == 1)
    c.request(w.clone, version: "0.1.7")  // v1 then v2 is
    #expect(c.visible && shown.count == 2)
  }

  // MARK: automatic updates off, and a Keychain that cannot answer

  @Test func aKeychainThatCannotBeReadIsNeverAQuestionAndTheOthersAre() throws {
    let w = try World()
    defer { w.remove() }
    let rec = w.rec
    #expect(AllowUpdatesLook.make(record: rec, read: .notFound, unsafe: []) == .ask(clone: w.clone))
    #expect(AllowUpdatesLook.make(record: rec, read: .accepted("/home/alex/other"), unsafe: []) == .ask(clone: w.clone), "another path was accepted")
    #expect(AllowUpdatesLook.make(record: rec, read: .accepted(w.clone), unsafe: []) == .nothing)
    #expect(AllowUpdatesLook.make(record: rec, read: .unreadable(-25308), unsafe: []) == .keychainUnreadable(-25308), "not asked")
    #expect(AllowUpdatesLook.make(record: nil, read: .unreadable(-25308), unsafe: []) == .nothing)
    #expect(AllowUpdatesCopy.keychainUnreadable(-25308).contains("-25308") && AllowUpdatesCopy.keychainUnreadable(-25308).contains("Keychain"))
  }

  // MARK: the update window's button settles too

  @Test func aChangeOfTheFolderTheWindowNamesIsNotClickableAtOnceAndAcceptsOnlyTheShownClone() throws {
    _ = NSApplication.shared
    let w = try World()
    defer { w.remove() }
    let keychain = MemoryCloneAcceptance()
    let shown = Shown()
    let c = center(w, keychain, shown)
    // the window opens on clone A (the record's) and the owner reads it
    c.windowShows(w.clone)
    c.allowFromWindow(clone: w.clone)
    #expect(keychain.accepted() == nil, "a click the instant the window shows it is ignored")
    // the updater's next check changes the waiting clone to B; text and button re-render together
    shown.clock += 30
    let b = try w.recordOther()
    c.windowShows(b)
    c.allowFromWindow(clone: b)
    #expect(keychain.accepted() == nil, "a change, then an immediate click, is refused")
    c.allowFromWindow(clone: w.clone)
    #expect(keychain.accepted() == nil, "a click that names what the window no longer shows is refused")
    shown.clock += 2
    c.allowFromWindow(clone: w.clone)
    #expect(keychain.accepted() == nil, "still not A")
    c.allowFromWindow(clone: b)
    #expect(keychain.accepted() == b, "after the delay it accepts exactly the shown clone")
    // a window that was closed starts over
    c.windowShows(nil)
    c.allowFromWindow(clone: b)
    #expect(c.pending == nil)
  }

  @Test func theWindowsButtonGoesThroughTheSettleAndNotStraightToAllow() throws {
    let win = try String(
      contentsOf: URL(fileURLWithPath: #filePath).deletingLastPathComponent().deletingLastPathComponent().deletingLastPathComponent()
        .appendingPathComponent("Sources/TalosDesktop/UpdateWindow.swift"), encoding: .utf8)
    #expect(win.contains("allow.allowFromWindow(clone: clone)") && !win.contains("allow.allow(clone:"))
    #expect(win.contains("allow.windowShows(controller.status.allowClone)") && win.contains(".onChange(of: controller.status.allowClone)"))
    let center = try String(
      contentsOf: URL(fileURLWithPath: #filePath).deletingLastPathComponent().deletingLastPathComponent().deletingLastPathComponent()
        .appendingPathComponent("Sources/TalosDesktop/CloneConfirmCenter.swift"), encoding: .utf8)
    #expect(center.contains("ProcessInfo.processInfo.systemUptime") && !center.contains("Date()"), "a monotonic clock")
  }
}
