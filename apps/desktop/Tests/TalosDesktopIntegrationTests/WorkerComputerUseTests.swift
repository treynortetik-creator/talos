import Foundation
import Testing
import TalosDesktopCore
@testable import TalosSupervisor
import TalosTestSupport

/// The computer-use permission dialog on a thread session's pane: the manager presses Escape and nothing else, once per appearance and at
/// most three times an hour, says so in its log, tells the thread in one fixed line at most once an hour, and past the limit leaves the
/// dialog for the owner as needs-you. The pane is `dialog-real.sh` drawing the REAL 2.1.322 capture (Fixtures/real-2.1.322) when a trigger
/// file appears, and logging every key it gets. Real private tmux server (`talos-test-…`, never `-L talos`); the rig's own temp home.
@Suite("Computer-use dialog on a thread session", .serialized, .enabled(if: Rig.hasTmux))
struct WorkerComputerUseTests {
  private func make(sticky: Bool = false) throws -> (WorkerRig, KeyLog, NoticeLog, String, String) {
    let keys = KeyLog()
    let trigger = TestTemp.base + "cu-\(UUID().uuidString.prefix(8))"
    var env = ["FAKE_DLG": "cu", "FAKE_DLG_KEYLOG": keys.path, "FAKE_DLG_LATE": trigger]
    if sticky { env["FAKE_DLG_STICKY"] = "1" }
    let r = try WorkerRig(scenario: "dialog-real.sh", extraEnv: env)
    let log = NoticeLog()
    r.trackNotices(log)
    let audit = r.root + "/audit.log"
    r.mgr.tune { $0.auditLogPath = audit }
    r.mgr.startTicking()
    // started by a resume wake: no pointer is typed, so every key the pane logs is one sent for the dialog
    try r.wake("trip", action: "resume", ids: [])
    #expect(r.wait(10) { r.up("trip") }, "\(r.why("trip"))")
    return (r, keys, log, trigger, audit)
  }

  /// Every key the pane got: none is typed but for the dialog (no pointer here), so any key at all before the dialog shows is a failure too.
  private func dialogKeys(_ k: KeyLog) -> [String] { k.keys }
  private func auditLines(_ path: String) -> [String] { completeLines(path) }
  private func show(_ trigger: String) { FileManager.default.createFile(atPath: trigger, contents: Data()) }
  private func gone(_ r: WorkerRig) -> Bool {
    let s = r.tmuxCmd(["capture-pane", "-p", "-J", "-t", "=t-trip:"]).out
    return DialogMatcher.computerUseBlock(TmuxCommands.parseCapture(s)) == nil
  }

  @Test func escapeOnlyOnceAndTheSessionCarriesOnWithOneLineToTheThread() throws {
    let (r, keys, log, trigger, audit) = try make()
    defer { r.teardown(); keys.remove(); unlink(trigger) }
    show(trigger)
    #expect(r.wait(15) { dialogKeys(keys) == ["ESC"] }, "keys: \(keys.keys)")
    #expect(r.wait(5) { gone(r) }, "the dialog went after Escape")
    #expect(r.allEvents.contains(.needsYou(thread: "trip", prompt: "computer-use permissions")), "needs-you while it was up")
    #expect(r.wait(5) { auditLines(audit).contains { $0.hasSuffix("dialog_dismissed kind=computer_use_permissions thread=trip") } }, "\(auditLines(audit))")
    #expect(r.wait(5) { log.all.count == 1 }, "\(log.all)")
    #expect(log.all.first?.text == ComputerUseDismiss.ownerLine && log.all.first?.thread == "trip")
    // the flag and needs_you go with it, and nothing else was ever pressed
    #expect(r.wait(5) { r.mgr.needsYou()["trip"] == nil && r.rawEntry()?["needs_you"] == nil }, "\(r.mgr.needsYou()) \(String(describing: r.rawEntry()))")
    usleep(1_500_000)
    #expect(dialogKeys(keys) == ["ESC"], "no Enter, no arrow, no second Escape: \(keys.keys)")
    #expect(r.up("trip"), "the session was not stopped for it: \(r.why("trip"))")
  }

  @Test func threeAnHourThenItIsLeftAsNeedsYouAndTheOwnerIsToldOnce() throws {
    let (r, keys, log, trigger, audit) = try make()
    defer { r.teardown(); keys.remove(); unlink(trigger) }
    for n in 1...ComputerUseDismiss.perHour {
      show(trigger)
      #expect(r.wait(15) { dialogKeys(keys).count == n }, "press \(n): \(keys.keys)")
      #expect(r.wait(5) { gone(r) && r.mgr.needsYou()["trip"] == nil }, "appearance \(n) over")
      // the appearance is over for the Escape rule only once the looks have missed it for `goneAfter` (one torn frame is not it gone)
      usleep(UInt32((ComputerUseDismiss.goneAfter + 1.5) * 1_000_000))
    }
    show(trigger)
    // the fourth stays: needs-you on file, the usual "waiting on" line, and no key at all
    #expect(r.wait(15) { (r.rawEntry()?["needs_you"] as? [String: Any])?["kind"] as? String == "computer-use permissions" }, "\(String(describing: r.rawEntry()))")
    #expect(r.wait(5) { log.all.contains { $0.text.hasPrefix("This thread's session is showing the computer-use permissions dialog") } }, "\(log.all)")
    // the line as posted: Esc, and nothing that invites an answer (Enter on the dialog's first row opens System Settings)
    let left = try #require(log.all.first { $0.text.hasPrefix("This thread's session is showing the computer-use permissions dialog") })
    #expect(left.text.contains("press Esc in this thread's pane in Terminals"), "\(left.text)")
    for w in ["answer", "approve", "accept", "confirm", "grant"] { #expect(!left.text.lowercased().contains(w), "\(w): \(left.text)") }
    usleep(1_500_000)
    #expect(dialogKeys(keys) == Array(repeating: "ESC", count: ComputerUseDismiss.perHour), "\(keys.keys)")
    #expect(log.all.filter { $0.text == ComputerUseDismiss.ownerLine }.count == 1, "one dismissal line an hour: \(log.all)")
    #expect(auditLines(audit).filter { $0.contains("dialog_dismiss_limit kind=computer_use_permissions thread=trip") }.count == 1)
    #expect(!gone(r))
  }

  @Test func anEscapeThatDoesNotTakeIsNeverRepeated() throws {
    let (r, keys, _, trigger, _) = try make(sticky: true)
    defer { r.teardown(); keys.remove(); unlink(trigger) }
    show(trigger)
    #expect(r.wait(15) { dialogKeys(keys) == ["ESC"] }, "keys: \(keys.keys)")
    usleep(3_000_000)
    #expect(dialogKeys(keys) == ["ESC"], "one key for one appearance: \(keys.keys)")
    #expect(r.mgr.needsYou()["trip"] == "computer-use permissions")
    #expect((r.rawEntry()?["needs_you"] as? [String: Any])?["kind"] as? String == "computer-use permissions")
  }
}
