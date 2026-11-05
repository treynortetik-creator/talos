import AppKit
import Foundation
import SwiftTerm
import Testing
import TalosDesktopCore
import TalosSupervisor
@testable import TalosDesktop

/// ITEM 1 in the real window: one Terminals window, a sidebar with Main and the thread sessions, a click that attaches the
/// terminal to the picked session. Real tmux on a private socket (the shim `ReviewD2TerminalTests` uses), real SwiftTerm
/// viewers; `-L talos` and the owner's workers are never reached.
extension GuiSerial {
@MainActor
@Suite("Session switcher window", .serialized, .enabled(if: guiTestsEnabled && FileManager.default.isExecutableFile(atPath: TmuxWorld.realTmux)))
struct SessionSwitcherGuiTests {
  func file(_ states: [String: String], errors: [String: String] = [:]) -> WorkersFile {
    var f = WorkersFile(supervisor: .init(pid: 1, heartbeat_at: "2026-11-05T00:00:00Z", workers_supported: true, main_pane_pid: 2))
    for (id, st) in states {
      var e = WorkersFile.Entry(threadId: id, cwd: "/home/alex/proj-\(id)")
      e.state = st
      if let c = errors[id] { e.error = .init(code: c, detail: "it exited at once", at: "2026-11-05T00:00:00Z") }
      f.threads[id] = e
    }
    return f
  }

  /// A thread session in the private tmux server whose pane prints its own name and records keys.
  func threadSession(_ w: TmuxWorld, _ id: String) {
    let script = w.dir + "/\(id).sh"
    writeScript(script, "#!/bin/bash\nstty raw -echo\nprintf 'THREAD \(id) READY\\r\\n'\nexec cat >> '\(w.dir)/\(id).keys'\n")
    _ = w.tmux("new-session", "-d", "-s", "t-\(id)", "-x", "120", "-y", "40", "--", "/bin/bash", script)
  }

  /// Which tmux session the one attached client is looking at.
  func attachedSession(_ w: TmuxWorld) -> String {
    w.tmux("list-clients", "-F", "#{client_session}").trimmingCharacters(in: .whitespacesAndNewlines)
  }

  func source(_ w: TmuxWorld, workers: @escaping () -> WorkersFile, needsYou: [String: String] = [:], spy: SpyBox? = nil) -> TerminalWindowController.SwitcherSource {
    TerminalWindowController.SwitcherSource(
      workers: workers, needsYou: { needsYou }, names: { ["trip": "OC Test", "garden": "Garden", "p": "Parked one", "f": "Broken one"] },
      attach: { e in
        SessionSwitcher.attachArgv(for: e, tmux: TmuxWorld.root + "/bin/tmux", socket: "talos", configPath: TmuxWorld.conf)
      },
      resume: { id in
        spy?.resumed.append(id)
        return (spy?.ok ?? true) ? .asked : .failed
      })
  }

  @Test func theSidebarListsMainAndEveryThreadWithItsBadge() async throws {
    TerminalWindowController.shared.resetSelectionForTest()
    let w = try TmuxWorld()
    defer { w.close(); TerminalWindowController.shared.switcherSourceOverride = nil }
    let f = file(["trip": "live", "garden": "busy", "p": "parked", "f": "failed"], errors: ["f": "start_failed"])
    TerminalWindowController.shared.switcherSourceOverride = source(w, workers: { f }, needsYou: ["trip": "trust this folder"])
    TerminalWindowController.shared.show()
    await w.run(0.3)
    #expect(
      TerminalWindowController.shared.sidebarRowsForTest == [
        "Main|Not started|selected", "Broken one|Failed|", "Garden|Working|", "OC Test|Needs you|", "Parked one|Parked|",
      ])
  }

  @Test func clickingAThreadAttachesThatSessionAndClickingMainGoesBack() async throws {
    TerminalWindowController.shared.resetSelectionForTest()
    let w = try TmuxWorld()
    defer { w.close(); TerminalWindowController.shared.switcherSourceOverride = nil }
    threadSession(w, "trip")
    threadSession(w, "garden")
    let f = file(["trip": "live", "garden": "live"])
    TerminalWindowController.shared.switcherSourceOverride = source(w, workers: { f })
    let c = TerminalWindowController.shared
    c.show()
    #expect(await w.until(5) { w.clients == 1 && attachedSession(w) == "agent" })
    c.select("trip", takeKeyboard: true)
    #expect(await w.until(5) { w.clients == 1 && attachedSession(w) == "t-trip" }, "attached to \(attachedSession(w)), clients \(w.clients)")
    #expect(c.viewerSessionForTest == "t-trip")
    // the terminal really shows that thread's screen, and a key typed at it reaches that thread only
    let inWindow = try #require(w.window?.contentView)
    func screen() -> String {
      allTerminalViews().filter { $0.process.running && $0.isDescendant(of: inWindow) }
        .map { String(decoding: $0.getBufferAsData(), as: UTF8.self) }.joined()
    }
    #expect(await w.until(5) { screen().contains("THREAD trip READY") }, "screen: \(screen().debugDescription)")
    c.select("garden", takeKeyboard: true)
    #expect(await w.until(5) { w.clients == 1 && attachedSession(w) == "t-garden" })
    c.select("main", takeKeyboard: true)
    #expect(await w.until(5) { w.clients == 1 && attachedSession(w) == "agent" })
    // all three sessions are still running: switching ended only our own clients
    let live = w.tmux("list-sessions", "-F", "#{session_name}").split(separator: "\n").sorted()
    #expect(live == ["agent", "t-garden", "t-trip"])
  }

  @Test func theRowButtonsReallySwitch() async throws {
    TerminalWindowController.shared.resetSelectionForTest()
    let w = try TmuxWorld()
    defer { w.close(); TerminalWindowController.shared.switcherSourceOverride = nil }
    threadSession(w, "trip")
    let f = file(["trip": "live"])
    TerminalWindowController.shared.switcherSourceOverride = source(w, workers: { f })
    TerminalWindowController.shared.show()
    await w.run(0.4)
    let window = try #require(w.window)
    func buttons(_ v: NSView) -> [SessionRow] { (v as? SessionRow).map { [$0] } ?? v.subviews.flatMap(buttons) }
    let rows = buttons(window.contentView!)
    let row = try #require(rows.first { $0.entryId == "trip" })
    #expect(row.acceptsFirstResponder)
    #expect(row.accessibilityLabel() == "OC Test, Idle")
    row.performClick(nil)
    #expect(await w.until(5) { attachedSession(w) == "t-trip" })
  }

  @Test func aParkedThreadShowsResumeNotATerminalAndFailedShowsItsError() async throws {
    TerminalWindowController.shared.resetSelectionForTest()
    let w = try TmuxWorld()
    defer { w.close(); TerminalWindowController.shared.switcherSourceOverride = nil }
    let box = SpyBox()
    var f = file(["p": "parked", "f": "failed"], errors: ["f": "start_failed"])
    TerminalWindowController.shared.switcherSourceOverride = source(w, workers: { f }, spy: box)
    let c = TerminalWindowController.shared
    c.show()
    #expect(await w.until(5) { w.clients == 1 })
    c.select("p", takeKeyboard: true)
    #expect(await w.until(3) { w.clients == 0 }, "the agent's viewer ended; nothing is attached to a parked thread")
    #expect(c.resumeVisibleForTest)
    #expect(c.infoTextForTest?.contains("Parked one") == true)
    #expect(c.viewerSessionForTest == nil)
    c.tapResumeForTest()
    #expect(box.resumed == ["p"])
    #expect(c.infoTextForTest?.contains("Asked to resume") == true)
    // the tap's answer is not carried to another entry
    c.select("f", takeKeyboard: true)
    #expect(!c.resumeVisibleForTest)
    let text = try #require(c.infoTextForTest)
    #expect(text.contains("Broken one failed") && text.contains("start_failed") && text.contains("it exited at once"), "\(text)")
    #expect(!text.contains("Asked to"))
    // a resume that can't be asked for says so
    box.ok = false
    c.select("p", takeKeyboard: true)
    c.tapResumeForTest()
    #expect(c.infoTextForTest?.contains("Couldn't ask to resume") == true)
    // it comes up: the screen turns into the terminal by itself
    threadSession(w, "p")
    f = file(["p": "live", "f": "failed"], errors: ["f": "start_failed"])
    #expect(await w.until(6) { attachedSession(w) == "t-p" }, "live update: \(attachedSession(w))")
    #expect(!c.resumeVisibleForTest)
  }

  @Test func commandDigitsPickEntriesAndAMissingOneDoesNothing() async throws {
    TerminalWindowController.shared.resetSelectionForTest()
    let w = try TmuxWorld()
    defer { w.close(); TerminalWindowController.shared.switcherSourceOverride = nil }
    threadSession(w, "trip")
    let f = file(["trip": "live", "p": "parked"])
    TerminalWindowController.shared.switcherSourceOverride = source(w, workers: { f })
    let c = TerminalWindowController.shared
    c.show()
    #expect(await w.until(5) { attachedSession(w) == "agent" })
    let window = try #require(w.window)
    func cmd(_ ch: String) -> Bool {
      let e = NSEvent.keyEvent(
        with: .keyDown, location: .zero, modifierFlags: [.command], timestamp: 0, windowNumber: window.windowNumber, context: nil,
        characters: ch, charactersIgnoringModifiers: ch, isARepeat: false, keyCode: 18)!
      return window.performKeyEquivalent(with: e)
    }
    // entries: Main, OC Test, Parked one
    #expect(cmd("2"))
    #expect(c.selectedId == "trip")
    #expect(await w.until(5) { attachedSession(w) == "t-trip" })
    #expect(cmd("3"))
    #expect(c.selectedId == "p")
    #expect(!cmd("9"), "no ninth entry: the key goes on")
    #expect(c.selectedId == "p")
    #expect(cmd("1"))
    #expect(c.selectedId == "main")
    // a plain digit, or Cmd+Shift+digit, is not a shortcut
    let plain = NSEvent.keyEvent(
      with: .keyDown, location: .zero, modifierFlags: [], timestamp: 0, windowNumber: window.windowNumber, context: nil,
      characters: "2", charactersIgnoringModifiers: "2", isARepeat: false, keyCode: 19)!
    _ = window.performKeyEquivalent(with: plain)
    #expect(c.selectedId == "main")
  }

  @Test func aThreadThatLeavesTheListFallsBackToMain() async throws {
    TerminalWindowController.shared.resetSelectionForTest()
    let w = try TmuxWorld()
    defer { w.close(); TerminalWindowController.shared.switcherSourceOverride = nil }
    threadSession(w, "trip")
    var f = file(["trip": "live"])
    TerminalWindowController.shared.switcherSourceOverride = source(w, workers: { f })
    let c = TerminalWindowController.shared
    c.show()
    c.select("trip", takeKeyboard: true)
    #expect(await w.until(5) { attachedSession(w) == "t-trip" })
    f = file([:])
    #expect(await w.until(6) { c.selectedId == "main" && attachedSession(w) == "agent" }, "selected \(c.selectedId)")
  }

  /// Not an assertion suite: renders the window, light and dark, for a person to look at. TALOS_SWITCHER_SNAPSHOT_OUT=<folder>.
  @Test(.enabled(if: ProcessInfo.processInfo.environment["TALOS_SWITCHER_SNAPSHOT_OUT"] != nil))
  func rendersTheSwitcherLightAndDark() async throws {
    let out = ProcessInfo.processInfo.environment["TALOS_SWITCHER_SNAPSHOT_OUT"]!
    TerminalWindowController.shared.resetSelectionForTest()
    let w = try TmuxWorld()
    defer { w.close(); TerminalWindowController.shared.switcherSourceOverride = nil }
    threadSession(w, "trip")
    let f = file(["trip": "live", "garden": "busy", "p": "parked", "f": "failed"], errors: ["f": "start_failed"])
    TerminalWindowController.shared.switcherSourceOverride = source(w, workers: { f }, needsYou: ["trip": "trust this folder"])
    let c = TerminalWindowController.shared
    c.show()
    c.select("trip", takeKeyboard: false)
    await w.run(1.5)
    let window = try #require(w.window)
    window.contentView?.layoutSubtreeIfNeeded()
    for (name, appearance) in [("light", NSAppearance.Name.aqua), ("dark", NSAppearance.Name.darkAqua)] {
      window.appearance = NSAppearance(named: appearance)
      await w.run(0.5)
      let view = try #require(window.contentView)
      let rep = try #require(view.bitmapImageRepForCachingDisplay(in: view.bounds))
      view.cacheDisplay(in: view.bounds, to: rep)
      try #require(rep.representation(using: .png, properties: [:])).write(to: URL(fileURLWithPath: out + "/switcher-\(name).png"))
    }
    c.select("p", takeKeyboard: false)
    await w.run(0.5)
    let view = try #require(window.contentView)
    let rep = try #require(view.bitmapImageRepForCachingDisplay(in: view.bounds))
    view.cacheDisplay(in: view.bounds, to: rep)
    try #require(rep.representation(using: .png, properties: [:])).write(to: URL(fileURLWithPath: out + "/switcher-parked-dark.png"))
  }
}
}

@MainActor final class SpyBox {
  var resumed: [String] = []
  var ok = true
}
