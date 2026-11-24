import Foundation
import Testing
import TalosDesktopCore
@testable import TalosSupervisor
import TalosTestSupport

/// The key guard (`KeyGuard`) through the real senders, on real panes (a private tmux server, never `-L talos`, and the app-owned pty), where
/// the guard is the only thing between the key and the screen: every other check the sender makes says yes.
@Suite("The key guard on real panes", .serialized)
struct KeyGuardIntegrationTests {
  /// Main's auto-accept: the warning's words sit in the scrollback above a frame rule, and the live select below it reads like the warning's
  /// options. `classify` on the whole pane names the warning and `AutoConfirmGuard` allows the Enter; the guard reads the live region alone,
  /// refuses, and the owner is asked (the cold start's Needs-you), with no key sent.
  @Test(arguments: bothHosts)
  func mainsAutoAcceptPressesNothingWhenOnlyTheScrollbackNamesTheWarning(kind: HostKind) throws {
    let r = try Rig(kind, scenario: "dev-dialog-scrollback.sh")
    defer { r.teardown() }
    r.start()
    let cap: Double = kind == .tmux ? 30 : 10
    #expect(r.wait(cap) { r.screenContains("Pick how this session pays") })
    if case .devChannels = DialogMatcher.classify(r.host.visibleRows() ?? []) {} else { Issue.record("control: the whole pane reads as the warning") }
    r.expectHeldAtNeedsYou("screenChanged")
    #expect(r.audit.contains("key_refused intent=dev_channels session=main why=not_dev_channels"), "audit: \(r.audit)")
  }

  /// THE LIVE CASE (2026-11-21/22, t-talos): the deaf pane is never quiet, a sub-agent's row ticks every second, so the pane always reads as
  /// "busy"; a pointer is owed and refused with row_under_box every second. The alarm must still come: the 60 s line, the 10 min Needs you
  /// (here 1.5 s and 4 s), and the Needs you must reach `workers.json` itself (what the bridge and the phone read), with the time the refusals
  /// began, not the time of the long wait.
  @Test(.enabled(if: Rig.hasTmux))
  func aRepaintingDeafPaneWithAnOwedPointerIsToldAndFlaggedInWorkersJson() throws {
    let r = try WorkerRig(scenario: "worker-real.sh", extraEnv: ["FAKE_REAL_START": "screen:unknown-menu-under-box", "FAKE_REAL_TICK": "1"])
    defer { r.teardown() }
    let log = NoticeLog()
    r.trackNotices(log)
    r.mgr.tune {
      $0.deafAfter = (1.5, 4, 1.5)
      $0.busyWindow = 5  // as in use (15 s): a pane drawn every second never reads as quiet
    }
    r.mgr.startTicking()
    try r.wake("trip")
    #expect(r.wait(10) { r.up("trip") }, "\(r.why("trip"))")
    let pane = { r.tmuxCmd(["capture-pane", "-p", "-J", "-t", "=t-trip:"]).out }
    #expect(r.wait(10) { pane().contains("sub-agent working") })
    #expect(r.wait(10) { r.entry("trip")?.state == "busy" }, "control: the repainting pane reads as busy: \(String(describing: r.entry("trip")?.state))")
    let first = pane()
    #expect(r.wait(5) { pane() != first }, "control: the pane repaints, so it never reads as quiet")
    let words = WorkerNotice.deafLine(name: r.mgr.displayName(ofThread: "trip"), id: "trip")
    #expect(r.wait(10) { log.all.count == 1 }, "a busy-looking pane is still told: \(log.all)")
    #expect(log.all.first?.text == words)
    #expect(r.wait(10) { r.mgr.needsYou()["trip"] == WorkerNotice.refusedKind }, "\(r.mgr.needsYou())")
    // the file, decoded: Needs you is there, from the time the refusals began
    #expect(r.wait(10) { r.entry("trip")?.needs_you?.kind == WorkerNotice.refusedKind }, "\(String(describing: r.entry("trip")))")
    let since = r.entry("trip")?.needs_you.flatMap { ISOTime.parse($0.since) }
    #expect(since != nil && Date().timeIntervalSince1970 - (since ?? 0) < 60, "since is a real time")
    // and on disk, as the bridge reads it
    let onDisk = { () -> String? in
      guard let d = FileManager.default.contents(atPath: r.talosHome + "/workers.json"),
        let o = try? JSONSerialization.jsonObject(with: d) as? [String: Any],
        let t = (o["threads"] as? [String: Any])?["trip"] as? [String: Any]
      else { return nil }
      return (t["needs_you"] as? [String: Any])?["kind"] as? String
    }
    #expect(r.wait(10) { onDisk() == WorkerNotice.refusedKind }, "workers.json carries needs_you")
    #expect(r.typedLines.isEmpty, "\(r.typedLines)")
    usleep(1_500_000)
    #expect(log.all.count == 1, "once: \(log.all)")
  }

  /// The owed pointer: an unknown menu drawn under Claude's empty input box (SYNTHETIC: Fixtures/synthetic/unknown-menu-under-box.txt). The
  /// screen reads as no dialog and no prompt, the box as empty, so the typing guard says yes; the key guard refuses (a row under the box that
  /// Claude Code never draws there), nothing is typed. The deaf-thread alarm (WorkerDeaf.swift) is what says so: after its wait one plain
  /// line in the thread, after the long wait Needs you, `deaf-threads.json` for the doctor and the Health page; when the screen clears, one
  /// line that typing works again and what Main handled meanwhile (the bridge's `main-handled.json`), and the flag goes. Real pane, real
  /// guard, real clock (the waits are short, as the other holds' are).
  @Test(.enabled(if: Rig.hasTmux))
  func anUnknownMenuUnderTheBoxIsToldThenFlaggedThenClearsWithWhatMainHandled() throws {
    let switchFile = TestTemp.base + "talos-deaf-switch-\(UUID().uuidString.prefix(6))"
    let r = try WorkerRig(scenario: "worker-real.sh", extraEnv: [
      "FAKE_REAL_START": "screen:unknown-menu-under-box", "FAKE_REAL_SWITCH": switchFile, "FAKE_REAL_THEN": "empty-input",
    ])
    defer {
      r.teardown()
      unlink(switchFile)
    }
    let log = NoticeLog()
    r.trackNotices(log)
    let audit = r.root + "/audit.log"
    r.mgr.tune {
      $0.deafAfter = (1.5, 4, 1.5)
      $0.auditLogPath = audit
    }
    r.mgr.startTicking()
    try r.wake("trip")
    #expect(r.wait(10) { r.up("trip") }, "\(r.why("trip"))")
    let pane = { r.tmuxCmd(["capture-pane", "-p", "-J", "-t", "=t-trip:"]).out }
    #expect(r.wait(10) { pane().contains("Buy $50 of extra usage") })
    let rows = TmuxCommands.parseCapture(pane())
    #expect(DialogMatcher.liveDialog(rows) == .none && PromptDetector.detect(rows) == nil, "control: nothing else stops the pointer")
    // the words, once, in this thread
    let words = WorkerNotice.deafLine(name: r.mgr.displayName(ofThread: "trip"), id: "trip")
    #expect(r.wait(10) { log.all.count == 1 }, "\(log.all)")
    #expect(log.all.first?.text == words && log.all.first?.thread == "trip")
    #expect(r.mgr.needsYou().isEmpty || r.mgr.needsYou()["trip"] == WorkerNotice.refusedKind, "Needs you only after the long wait")
    // the long wait: Needs you, and the file the doctor reads
    #expect(r.wait(10) { r.mgr.needsYou()["trip"] == WorkerNotice.refusedKind }, "\(r.mgr.needsYou())")
    let filePath = r.talosHome + "/deaf-threads.json"
    #expect(r.wait(10) { FileManager.default.contents(atPath: filePath).flatMap { String(data: $0, encoding: .utf8) }?.contains("\"trip\"") == true })
    let fileData = try #require(FileManager.default.contents(atPath: filePath))
    let listed = try #require(try JSONSerialization.jsonObject(with: fileData) as? [String: Any])
    #expect(listed["v"] as? Int == 1 && ((listed["threads"] as? [String: Any])?["trip"] as? [String: Int])?["refusals_1h"] != nil, "\(listed)")
    usleep(1_500_000)
    #expect(r.typedLines.isEmpty, "\(r.typedLines)")
    #expect(!pane().contains("\u{276F}\u{00A0}Talos"), "nothing typed into the box")
    #expect(log.all.count == 1, "once: \(log.all)")
    #expect(completeLines(audit).contains { $0.contains("key_refused thread=trip intent=box-empty why=row_under_box") }, "\(completeLines(audit))")
    #expect(completeLines(audit).contains { $0.contains("deaf_thread thread=trip step=notice") }, "\(completeLines(audit))")

    // Main handled two messages and a scheduled run for this thread meanwhile (the bridge's tally); another thread's do not count
    let nowMs = Int(Date().timeIntervalSince1970 * 1000)
    let tally: [String: Any] = ["v": 1, "threads": [
      "trip": [["at": nowMs, "kind": "message"], ["at": nowMs, "kind": "message"], ["at": nowMs, "kind": "run"]],
      "other": [["at": nowMs, "kind": "card"]],
    ]]
    try JSONSerialization.data(withJSONObject: tally).write(to: URL(fileURLWithPath: r.talosHome + "/main-handled.json"))
    // the screen clears
    FileManager.default.createFile(atPath: switchFile, contents: nil)
    let back = WorkerNotice.deafBackLine(name: r.mgr.displayName(ofThread: "trip"), id: "trip", handled: .init(messages: 2, runs: 1))
    #expect(r.wait(15) { log.all.count == 2 }, "\(log.all)")
    #expect(log.all.last?.text == back, "\(log.all)")
    #expect(r.wait(5) { r.mgr.needsYou().isEmpty }, "the flag clears by itself: \(r.mgr.needsYou())")
    #expect(r.wait(20) {
      FileManager.default.contents(atPath: filePath).flatMap { try? JSONSerialization.jsonObject(with: $0) as? [String: Any] }
        .map { ($0["threads"] as? [String: Any])?.isEmpty == true } == true
    }, "the file no longer lists the thread")
    usleep(1_500_000)
    #expect(log.all.count == 2, "the recovery is told once: \(log.all)")
    #expect(r.typedLines.count <= 1, "a held pointer is typed at most once: \(r.typedLines)")
  }
}
