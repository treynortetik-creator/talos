import AppKit
import Foundation
import SwiftUI
import Testing
import TalosDesktopCore
import TalosSupervisor

@testable import TalosDesktop

// The update banner and window, with the real AppKit pieces. Runs only with TALOS_GUI_TESTS=1. Nothing here activates the app.

@MainActor
@Suite("Update window and banner (real AppKit)", .serialized, .guiExclusive, .enabled(if: guiTestsEnabled))
struct UpdateWindowGuiTests {
  func buttons(_ v: NSView) -> [NSButton] { (v as? NSButton).map { [$0] } ?? [] + v.subviews.flatMap(buttons) }

  func host(_ c: UpdateController) -> (NSWindow, NSView) {
    let w = NSWindow(contentRect: NSRect(x: 0, y: 0, width: 440, height: 250), styleMask: [.titled], backing: .buffered, defer: true)
    let h = NSHostingView(rootView: UpdateWindow(controller: c))
    w.contentView = h
    h.layoutSubtreeIfNeeded()
    return (w, h)
  }

  func returnKey(_ w: NSWindow) -> NSEvent {
    NSEvent.keyEvent(
      with: .keyDown, location: .zero, modifierFlags: [], timestamp: 0, windowNumber: w.windowNumber, context: nil, characters: "\r",
      charactersIgnoringModifiers: "\r", isARepeat: false, keyCode: 36)!
  }

  @Test func theBannerNeverTakesFocusAndHasNoDefaultButton() {
    _ = NSApplication.shared
    let c = UpdateController()
    var shown: [NSPanel] = []
    c.orderFront = { shown.append($0) }  // nothing is put on the screen
    c.presentBanner("Talos 0.1.5 is ready to update.", offersUpdate: true)
    let p = try! #require(shown.first)
    #expect(!p.canBecomeKey && !p.canBecomeMain, "it can never be key: a key goes to what the owner is typing in")
    #expect(p.styleMask.contains(.nonactivatingPanel))
    #expect(p.defaultButtonCell == nil)
    #expect(!p.isKeyWindow)
    #expect(!p.performKeyEquivalent(with: returnKey(p)), "Return is not a key equivalent of anything on it")
    p.keyDown(with: returnKey(p))
    #expect(c.updateNowPresses == 0)
    for b in buttons(p.contentView!) { #expect(b.keyEquivalent.isEmpty, "\(b.title) has no key equivalent") }
  }

  @Test func returnOnTheWindowDoesNothingAndUpdateNowNeedsARealClick() {
    _ = NSApplication.shared
    let c = UpdateController()
    c.orderFront = { _ in }
    c.apply(.ready(version: "0.1.5"))  // the pending state: the window offers Update now
    let (w, root) = host(c)
    let all = buttons(root)
    let update = try! #require(all.first { $0.title == "Install" })
    #expect(update.keyEquivalent.isEmpty && w.defaultButtonCell == nil, "no default button on the window")
    #expect(all.allSatisfy { $0.keyEquivalent != "\r" })
    #expect(!w.performKeyEquivalent(with: returnKey(w)), "Return is not taken by anything")
    w.keyDown(with: returnKey(w))
    #expect(c.updateNowPresses == 0)
    // a press that is no mouse event (Accessibility, AppleScript, `performClick`) is not a click
    update.performClick(nil)
    #expect(c.updateNowPresses == 0, "a press with no real click behind it does nothing")
  }

  @Test func theWindowHasNoUpdateNowWhenNothingIsReady() {
    _ = NSApplication.shared
    let c = UpdateController()
    c.orderFront = { _ in }
    c.apply(.upToDate(version: "0.1.4"))
    let (_, root) = host(c)
    #expect(!buttons(root).contains { $0.title == "Install" })
  }

  @Test func theThreadWaitLineHasUpdateNowAnywayAndMainsTurnHasNoSuchButton() {
    _ = NSApplication.shared
    let c = UpdateController()
    c.orderFront = { _ in }
    c.apply(.waitingForTurn(version: "1.5.0", threads: UpdateStatus.ThreadWait(names: ["Trip"])))
    let (_, root) = host(c)
    let all = buttons(root)
    let skip = try! #require(all.first { $0.title == UpdateStatus.skipThreadWaitButton }, "the waiting line offers it")
    #expect(skip.keyEquivalent.isEmpty, "a real click only, like Install")
    #expect(!all.contains { $0.title == "Install" }, "Install is pressed already")
    // Main's own turn: the button is not shown at all (it would skip nothing it is allowed to skip)
    c.apply(.waitingForTurn(version: "1.5.0", why: ["main running"]))
    let (_, root2) = host(c)
    #expect(!buttons(root2).contains { $0.title == UpdateStatus.skipThreadWaitButton })
  }

  /// Old code: a failed update's window offered "Check again", so a failed update that needs repair had no Try again.
  @Test func aFailedUpdateOffersTryAgain() {
    _ = NSApplication.shared
    let c = UpdateController()
    c.orderFront = { _ in }
    c.apply(.failed(line: AutoUpdate.repairLine("1.5.0", old: "1.4.0"), logPath: "~/x"))
    let (_, root) = host(c)
    let titles = buttons(root).map(\.title)
    #expect(titles.contains("Try again") && !titles.contains("Check again"), "\(titles)")
  }

  /// Old code: Try again reached the repair from one button and only while the controller's own status was "failed". Here the status is
  /// something else, and the UPDATER (which holds the record) decides: Check again and About's button both retry the repair first, and
  /// no new check starts while it still fails.
  @Test func everyOwnerPressedCheckRetriesAWaitingRepairBeforeAnyCheck() async throws {
    _ = NSApplication.shared
    let home = NSTemporaryDirectory() + "talos-ua-\(UUID().uuidString.prefix(8))"
    try FileManager.default.createDirectory(atPath: home + "/auto-update", withIntermediateDirectories: true)
    defer { try? FileManager.default.removeItem(atPath: home) }
    var p = AutoUpdate.Pending(
      version: "1.5.0", old_version: "1.4.0", checkout: home + "/no-such-folder", old_ref: "main", old_head: String(repeating: "a", count: 40),
      helper_pid: 0, started_at: ISOTime.string(Date().timeIntervalSince1970))
    p.commit = String(repeating: "b", count: 40)
    p.repair = true
    try JSONEncoder().encode(p).write(to: URL(fileURLWithPath: home + "/auto-update/pending.json"))
    let o = AutoUpdater.Options(talosHome: home, appPath: home + "/Talos.app", appVersion: "1.4.0", keys: [])
    let c = UpdateController()
    var h = AutoUpdater.Hooks(settings: { (true, nil) }, checkout: { nil }, look: { [] }, post: { _ in }, env: { [:] })
    h.onStatus = { s in Task { @MainActor in c.apply(s) } }
    let u = AutoUpdater(options: o, hooks: h)
    #expect(u.needsRepair(), "the updater knows, whatever the controller shows")
    c.orderFront = { _ in }
    c.updater = u
    c.apply(.idle)  // not .failed
    c.probe = { .upToDate("1.4.0") }
    c.checkAgain()
    for _ in 0..<60 {
      if case .failed = c.status { break }
      try await Task.sleep(nanoseconds: 100_000_000)
    }
    #expect(c.checksStarted == 0, "the repair came first and it still fails, so no check started")
    guard case .failed(let line, _) = c.status else {
      Issue.record("expected the repair line, got \(c.status)")
      return
    }
    #expect(line == AutoUpdate.repairLine("1.5.0", old: "1.4.0"))
    c.apply(.idle)
    c.checkFromAbout()
    for _ in 0..<60 {
      if case .failed = c.status { break }
      try await Task.sleep(nanoseconds: 100_000_000)
    }
    #expect(c.checksStarted == 0, "About's button goes the same way")
    #expect(c.status.words.headline == "The update didn\u{2019}t work")
  }
}
