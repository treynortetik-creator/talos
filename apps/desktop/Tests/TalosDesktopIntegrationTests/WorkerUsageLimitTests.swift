import Foundation
import Testing
import TalosDesktopCore
@testable import TalosSupervisor
import TalosTestSupport

/// Claude Code's usage-limit screen on a thread session's pane: needs-you while it is up (`needs_you.kind` "usage limit" in workers.json),
/// one line to the thread naming the model, the reset and the way on, at most one an hour, and NO key of any kind, whoever asks: a message's
/// pointer owed to the session, a click on the Needs-you popup. The pane is `dialog-real.sh` drawing the SYNTHETIC screen
/// (Fixtures/synthetic/usage-limit.txt) when a trigger file appears, and logging every key it gets. Real private tmux server (`talos-test-…`,
/// never `-L talos`); the rig's own temp home.
@Suite("Usage-limit screen on a thread session", .serialized, .enabled(if: Rig.hasTmux))
struct WorkerUsageLimitTests {
  @Test func noKeyEverOneLineAnHourAndNeedsYouWhileItIsUp() throws {
    let keys = KeyLog()
    let trigger = TestTemp.base + "ul-\(UUID().uuidString.prefix(8))"
    let end = TestTemp.base + "ul-end-\(UUID().uuidString.prefix(8))"
    let r = try WorkerRig(
      scenario: "dialog-real.sh", extraEnv: ["FAKE_DLG": "ul", "FAKE_DLG_KEYLOG": keys.path, "FAKE_DLG_LATE": trigger, "FAKE_DLG_UL_END": end])
    defer { r.teardown(); keys.remove(); unlink(trigger); unlink(end) }
    let log = NoticeLog()
    r.trackNotices(log)
    let audit = r.root + "/audit.log"
    r.mgr.tune { $0.auditLogPath = audit }
    r.mgr.startTicking()
    try r.wake("trip", action: "resume", ids: [])
    #expect(r.wait(10) { r.up("trip") }, "\(r.why("trip"))")
    // keys the pane got while the screen was up (before it, and after it went, the fake logs them as PRE:)
    let onScreen = { keys.keys.filter { !$0.hasPrefix("PRE:") } }
    let kind = { (r.rawEntry()?["needs_you"] as? [String: Any])?["kind"] as? String }
    let resetsAt = { (r.rawEntry()?["needs_you"] as? [String: Any])?["resets_at"] as? String }

    let shownAt = Date()
    FileManager.default.createFile(atPath: trigger, contents: Data())
    #expect(r.wait(15) { kind() == "usage limit" }, "\(String(describing: r.rawEntry()))")
    // the reset as an instant, beside the kind: the next 4pm in the zone the screen names
    expectParisFourPm(resetsAt(), readAfter: shownAt, readBy: Date())
    #expect(r.allEvents.contains(.needsYou(thread: "trip", prompt: "usage limit")))
    #expect(r.wait(5) { log.all.count == 1 }, "\(log.all)")
    let line = try #require(log.all.first)
    #expect(line.thread == "trip")
    #expect(
      line.text
        == "This thread's session hit the usage limit for Fable. It resets 4pm (Europe/Paris). Talos pressed nothing on that screen. Its choices come as a card when Talos can read them."
    )
    // a message for the thread: its pointer is owed, and is never typed onto this screen
    try r.wake("trip")
    // the card's two buttons are offered (row 7); a click for a dialog id that is not the offer's, or on a row that spends credits, presses nothing
    #expect(r.wait(10) { r.mgr.popupOffers().first?.dialog.options == ["Stop and wait", "Switch model"] }, "\(r.mgr.popupOffers())")
    let clicked = Locked<PopupAnswerResult?>(nil)
    r.mgr.popupAnswer(thread: "trip", dialogId: "d_forged", action: .choose(2, label: "Switch to usage credits")) { clicked.set($0) }
    #expect(r.wait(5) { clicked.get() != nil })
    #expect(clicked.get() == .nothing(.notOffered))
    Thread.sleep(forTimeInterval: 4)
    #expect(onScreen().isEmpty, "no Enter, no digit, no arrow, no Escape, no pointer text: \(keys.keys)")
    #expect(r.typedLines.isEmpty)
    #expect(kind() == "usage limit", "still waiting on the owner")
    #expect(auditLines(audit).contains { $0.contains("usage_limit_seen thread=trip model=\"Fable\" line=yes") }, "\(auditLines(audit))")

    // the owner pressed Esc at the Mac: the screen goes, and with it needs-you
    FileManager.default.createFile(atPath: end, contents: Data())
    #expect(r.wait(15) { kind() == nil && r.mgr.needsYou()["trip"] == nil }, "\(String(describing: r.rawEntry()))")
    usleep(UInt32((UsageLimitWatch.goneAfter + 1.5) * 1_000_000))
    // the owed pointer goes into the idle box now (the fake logs it as PRE:): let it finish, so no key of it is still in flight when the
    // screen comes back (a key typed onto the idle box and read after the redraw would be logged as one sent to the screen)
    var seen = -1
    #expect(r.wait(15) { let n = keys.keys.count; defer { seen = n }; usleep(1_500_000); return n == seen && keys.keys.count == n })
    // a second appearance inside the hour: needs-you again, no second line
    let before = keys.keys.count
    FileManager.default.createFile(atPath: trigger, contents: Data())
    #expect(r.wait(15) { kind() == "usage limit" }, "\(String(describing: r.rawEntry()))")
    #expect(r.wait(5) { auditLines(audit).contains { $0.contains("usage_limit_seen thread=trip model=\"Fable\" line=held_hourly") } })
    Thread.sleep(forTimeInterval: 3)
    #expect(log.all.count == 1, "one line an hour: \(log.all)")
    #expect(keys.keys.dropFirst(before).filter { !$0.hasPrefix("PRE:") }.isEmpty, "\(keys.keys)")
  }

  private func auditLines(_ path: String) -> [String] { completeLines(path) }

  /// A session that STARTS onto the usage-limit screen (it never connects to Talos while the screen is up) is not stopped as `needs_mac`
  /// with an "answer it there" line once `dialogLimit` passes: it waits on the owner's answer, the thread has the usage-limit line, and no key.
  @Test func aStartOntoItIsNotStoppedAndItHasItsLine() throws {
    let keys = KeyLog()
    let r = try WorkerRig(scenario: "dialog-real.sh", extraEnv: ["FAKE_DLG": "ul", "FAKE_DLG_KEYLOG": keys.path])
    defer { r.teardown(); keys.remove() }
    let log = NoticeLog()
    r.trackNotices(log, dialogLimit: 1.5)
    r.mgr.startTicking()
    try r.wake("trip", action: "resume", ids: [])
    #expect(r.wait(15) { (r.rawEntry()?["needs_you"] as? [String: Any])?["kind"] as? String == "usage limit" }, "\(r.why("trip"))")
    Thread.sleep(forTimeInterval: 5)  // well past dialogLimit
    #expect(r.state("trip") == "starting", "not stopped for it: \(r.why("trip"))")
    #expect(r.entry("trip")?.error == nil)
    #expect(
      log.all.map(\.text) == [
        "This thread's session hit the usage limit for Fable. It resets 4pm (Europe/Paris). Talos pressed nothing on that screen. Its choices come as a card when Talos can read them."
      ], "\(log.all)")
    for t in log.all.map(\.text) { #expect(!t.lowercased().contains("answer"), "\(t)") }
    #expect(keys.keys.isEmpty, "\(keys.keys)")
  }

  /// The same for a start onto the computer-use dialog whose Escape did not take: not stopped, and the line says Esc.
  @Test func aStartOntoAStuckComputerUseDialogIsNotStoppedAndItsLineSaysEsc() throws {
    let keys = KeyLog()
    let r = try WorkerRig(scenario: "dialog-real.sh", extraEnv: ["FAKE_DLG": "cu", "FAKE_DLG_STICKY": "1", "FAKE_DLG_KEYLOG": keys.path])
    defer { r.teardown(); keys.remove() }
    let log = NoticeLog()
    r.trackNotices(log, dialogLimit: 1.5)
    r.mgr.startTicking()
    try r.wake("trip", action: "resume", ids: [])
    #expect(r.wait(15) { keys.keys == ["ESC"] }, "\(keys.keys) \(r.why("trip"))")
    // the dismissal's own line at the Escape, then, once it did not take, the line left for the owner
    #expect(r.wait(ComputerUseDismiss.stuckAfter + 10) { log.all.count == 2 }, "\(log.all) \(r.why("trip"))")
    Thread.sleep(forTimeInterval: 2)
    #expect(r.state("trip") == "starting", "not stopped for it: \(r.why("trip"))")
    #expect(r.entry("trip")?.error == nil)
    #expect(
      log.all.map(\.text) == [
        ComputerUseDismiss.ownerLine,
        "This thread's session is showing the computer-use permissions dialog, and Talos has left it on screen. To close it, press Esc in this thread's pane in Terminals; Esc is the only key to press there (Enter opens System Settings). The session carries on without screen control."
      ], "\(log.all)")
    for t in log.all.map(\.text) { #expect(!t.lowercased().contains("answer"), "\(t)") }
    #expect(keys.keys == ["ESC"], "one Escape, nothing else: \(keys.keys)")
  }
}

/// A value set on one thread and read on another.
final class Locked<T>: @unchecked Sendable {
  private let lock = NSLock()
  private var value: T
  init(_ v: T) { value = v }
  func set(_ v: T) { lock.withLock { value = v } }
  func get() -> T { lock.withLock { value } }
}
