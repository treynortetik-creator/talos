import Foundation
import Testing
import TalosDesktopCore
@testable import TalosSupervisor
import TalosTestSupport

/// What `thread_session status` reads from workers.json beyond the state (protocol WorkerEntry: `needs_you`, `stopped_why`,
/// `turn_started_at`), as the real manager writes them on a real private tmux server (`talos-test-…`, never `-L talos`) with the fake
/// claude. Each check reads the FILE (`rawEntry`), the bridge's view, not the manager's memory. The temp Talos home is the rig's own.
@Suite("workers.json: needs_you, stopped_why, turn_started_at", .serialized, .enabled(if: Rig.hasTmux))
struct WorkerStatusFieldsTests {
  @Test func aTurnHasItsStartWhileItRunsAndLastTurnAtIsItsEnd() throws {
    let r = try WorkerRig()
    defer { r.teardown() }
    r.mgr.startTicking()
    try r.wake("trip")
    #expect(r.wait(10) { r.typedLines.count == 1 }, "\(r.why("trip"))")
    let typedAt = Date().timeIntervalSince1970
    // the pointer starts a turn: its start is on file, and the end of a turn not yet finished is not
    #expect(r.wait(5) { r.rawEntry()?["turn_started_at"] is String }, "\(String(describing: r.rawEntry()))")
    let started = try #require(ISOTime.parse(r.rawEntry()?["turn_started_at"] as? String ?? ""))
    #expect(abs(started - typedAt) < 5)
    // the pane goes quiet: the turn is over, `last_turn_at` takes its end and the start goes
    #expect(r.wait(10) { r.rawEntry()?["turn_started_at"] == nil && r.rawEntry()?["last_turn_at"] is String }, "\(String(describing: r.rawEntry()))")
    let ended = try #require(ISOTime.parse(r.rawEntry()?["last_turn_at"] as? String ?? ""))
    #expect(ended >= started, "last_turn_at is the end of the turn, not when the pointer was typed")
    // the conversation still counts as having had a turn (a resume, never a fresh id)
    #expect(r.entry("trip")?.hadTurn == true)
  }

  @Test func anIdleParkSaysIdleAndTheNextStartClearsIt() throws {
    let r = try WorkerRig()
    defer { r.teardown() }
    r.makeManager(idle: 1.5)
    r.mgr.startTicking()
    try r.wake("trip")
    #expect(r.wait(10) { r.liveCount("trip") == 1 }, "\(r.why("trip"))")
    #expect(r.wait(10) { r.state("trip") == "parked" }, "\(r.why("trip"))")
    #expect(r.wait(3) { r.rawEntry()?["stopped_why"] as? String == "idle" }, "\(String(describing: r.rawEntry()))")
    try r.wake("trip")
    #expect(r.wait(10) { r.liveCount("trip") == 2 }, "\(r.why("trip"))")
    #expect(r.wait(3) { r.rawEntry()?["stopped_why"] == nil }, "a running session has no stop reason: \(String(describing: r.rawEntry()))")
  }

  @Test func anOwnersParkSaysOwnerAndACrashSaysCrash() throws {
    let r = try WorkerRig()
    defer { r.teardown() }
    r.mgr.startTicking()
    try r.wake("trip")
    #expect(r.wait(10) { r.liveCount("trip") == 1 }, "\(r.why("trip"))")
    try r.wake("trip", action: "park", ids: [])
    #expect(r.wait(15) { r.state("trip") == "parked" }, "\(r.why("trip"))")
    #expect(r.wait(3) { r.rawEntry()?["stopped_why"] as? String == "owner" }, "\(String(describing: r.rawEntry()))")
    // started again, then its process dies without anyone asking: a crash. It is killed only once the wake's pointer is in (typed,
    // Enter sent, nothing owed): a crash with a message still owed is started again at once to deliver it (the next test), which is
    // the manager's rule, not a park.
    try r.wake("trip")
    #expect(r.wait(10) { r.liveCount("trip") == 2 && (r.entry("trip")?.pane_pid ?? 0) > 1 }, "\(r.why("trip"))")
    #expect(r.wait(10) { r.typedLines.count == 2 && r.entry("trip")?.pointer_owed_until == nil }, "\(r.why("trip")) typed \(r.typedLines.count)")
    let pid = try #require(r.entry("trip")?.pane_pid)
    kill(-pid, SIGKILL)
    #expect(r.wait(10) { r.state("trip") == "parked" && r.rawEntry()?["stopped_why"] as? String == "crash" }, "\(r.why("trip")) \(String(describing: r.rawEntry()))")
    // the crash is on the record too, and a later start keeps it (only a fresh conversation clears it)
    #expect((r.rawEntry()?["restarts"] as? [String])?.count == 1, "\(String(describing: r.rawEntry()))")
    #expect(r.starts.count == 2, "a crash with nothing owed is parked, never started again: \(r.why("trip"))")
    try r.wake("trip")
    #expect(r.wait(10) { r.liveCount("trip") == 3 }, "\(r.why("trip"))")
    #expect(r.wait(3) { r.rawEntry()?["stopped_why"] == nil && (r.rawEntry()?["restarts"] as? [String])?.count == 1 }, "\(String(describing: r.rawEntry()))")
  }

  /// A crash while a message is still owed (here held back by copy mode) is started again at once, so the message is delivered.
  /// `stopped_why` is cleared by that start, so what says it crashed is the `restarts` entry (the bridge lists it as `by: "crash"`).
  @Test func aCrashWithAMessageOwedStartsAgainAndTheRestartsListSaysSo() throws {
    let r = try WorkerRig()
    defer { r.teardown() }
    r.mgr.startTicking()
    try r.wake("trip")
    #expect(r.wait(10) { r.liveCount("trip") == 1 && r.typedLines.count == 1 }, "\(r.why("trip"))")
    #expect(r.wait(10) { r.entry("trip")?.pointer_owed_until == nil && (r.entry("trip")?.pane_pid ?? 0) > 1 }, "\(r.why("trip"))")
    // the owner scrolls back: a second message is owed and held, never typed into the mode
    #expect(r.tmuxCmd(["copy-mode", "-t", "=t-trip:"]).ok)
    #expect(r.wait(5) { r.tmuxCmd(["display-message", "-p", "-t", "=t-trip:", "#{pane_in_mode}"]).out.hasPrefix("1") })
    try r.wake("trip", ids: ["m_01JBF3V7Q8K2M4N6P8R0S2T402"])
    #expect(r.wait(10) { r.entry("trip")?.pointer_owed_until != nil }, "\(r.why("trip"))")
    #expect(r.typedLines.count == 1 && r.starts.count == 1)
    #expect((r.rawEntry()?["restarts"] as? [String] ?? []).isEmpty)
    let pid = try #require(r.entry("trip")?.pane_pid)
    kill(-pid, SIGKILL)
    // started again for the owed message, which goes in; the crash is on file while it runs
    #expect(r.wait(15) { r.liveCount("trip") == 2 && r.typedLines.count == 2 }, "\(r.why("trip")) typed \(r.typedLines.count)")
    #expect(r.starts.count == 2, "\(r.why("trip"))")
    #expect(r.wait(3) { (r.rawEntry()?["restarts"] as? [String])?.count == 1 }, "\(String(describing: r.rawEntry()))")
    let at = try #require(ISOTime.parse((r.rawEntry()?["restarts"] as? [String])?.first ?? ""))
    #expect(abs(Date().timeIntervalSince1970 - at) < 60)
    #expect(r.rawEntry()?["stopped_why"] == nil, "a running session has no stop reason: \(String(describing: r.rawEntry()))")
  }

  @Test func theParkReasonsMapToTheProtocolsList() {
    #expect(WorkerManager.stoppedWhy(reason: "idle", afterPark: nil) == "idle")
    #expect(WorkerManager.stoppedWhy(reason: "cap", afterPark: nil) == "cap")
    #expect(WorkerManager.stoppedWhy(reason: "governor", afterPark: nil) == "governor")
    #expect(WorkerManager.stoppedWhy(reason: "exited", afterPark: nil) == "crash")
    #expect(WorkerManager.stoppedWhy(reason: "control", afterPark: nil) == "owner")
    #expect(WorkerManager.stoppedWhy(reason: "stop_limit", afterPark: nil) == "owner")
    #expect(WorkerManager.stoppedWhy(reason: "control", afterPark: "restart") == "restart")
    #expect(WorkerManager.stoppedWhy(reason: "control", afterPark: "fresh") == "restart")
    for reason in ["idle", "cap", "governor", "exited", "control", "stop_limit", "interrupted", "anything"] {
      #expect(WorkersFile.stoppedWhyValues.contains(WorkerManager.stoppedWhy(reason: reason, afterPark: nil)), "\(reason)")
    }
  }

  @Test func aDialogOnThePaneIsNeedsYouOnFileWithSinceAndGoesWithIt() throws {
    let keys = KeyLog()
    let r = try WorkerRig(scenario: "dialog-real.sh", extraEnv: ["FAKE_DLG": "trust", "FAKE_DLG_KEYLOG": keys.path])
    defer { r.teardown(); keys.remove() }
    r.trackNotices(NoticeLog())
    r.mgr.tune { $0.cardAckWait = 600 }
    r.mgr.startTicking()
    try r.wake("trip")
    #expect(r.wait(15) { r.mgr.needsYou()["trip"] != nil }, "\(r.why("trip"))")
    let flag = try #require(r.mgr.needsYou()["trip"])
    #expect(r.wait(3) { (r.rawEntry()?["needs_you"] as? [String: Any])?["kind"] as? String == flag }, "\(String(describing: r.rawEntry()))")
    let ny = try #require(r.rawEntry()?["needs_you"] as? [String: Any])
    let since = try #require(ISOTime.parse(ny["since"] as? String ?? ""))
    #expect(abs(Date().timeIntervalSince1970 - since) < 30)
    #expect(keys.presses.isEmpty, "raising needs_you presses nothing")
    // the owner answers in the pane: the flag and the field go
    #expect(r.tmuxCmd(["send-keys", "-t", "=t-trip:", "Down"]).ok)
    r.ownerPressesEnter("trip")
    #expect(r.wait(15) { r.rawEntry()?["needs_you"] == nil }, "\(String(describing: r.rawEntry()))")
  }

  @Test func theEntryReadsAnOlderFileAndDropsWhatItCannotRead() throws {
    let base = #"{"state":"parked","tmux":"t-trip","cwd":"/home/alex/x","restarts":[]"#
    let old = try #require(try? JSONDecoder().decode(WorkersFile.Entry.self, from: Data((base + "}").utf8)))
    #expect(old.needs_you == nil && old.stopped_why == nil && old.turn_started_at == nil)
    let bad = base + #","needs_you":{"kind":7},"stopped_why":false,"turn_started_at":"soon"}"#
    let e = try #require(try? JSONDecoder().decode(WorkersFile.Entry.self, from: Data(bad.utf8)), "an unreadable field must not make the entry unreadable")
    #expect(e.needs_you == nil && e.stopped_why == nil && e.turn_started_at == nil && e.state == "parked")
    var w = e
    w.needs_you = .init(kind: String(repeating: "x", count: 200), since: "2026-11-12T10:00:00.000Z")
    w.stopped_why = "idle"
    w.turn_started_at = "2026-11-12T10:00:00.000Z"
    let back = try JSONDecoder().decode(WorkersFile.Entry.self, from: JSONEncoder().encode(w))
    #expect(back == w && back.needs_you?.kind.utf16.count == WorkersFile.NeedsYou.kindUnits)
    // nothing new is written for an entry that has none of them: an older reader sees the file it always did
    let plain = String(decoding: try JSONEncoder().encode(old), as: UTF8.self)
    #expect(!plain.contains("needs_you") && !plain.contains("stopped_why") && !plain.contains("turn_started_at"))
  }

  @Test func mainsDialogIsNeedsYouInTheRestartCheckAndTheAlarmsAreNot() throws {
    #expect(Supervisor.mainNeedsYouKind(.dialog("folder trust")) == "folder trust")
    #expect(Supervisor.mainNeedsYouKind(.confirmColdStart) == MainRestartCheck.devWarningLabel)
    for n: Supervisor.NeedsYou? in [nil, .stuck, .startStalled, .bridgeNotLive(nil), .relayUnreachable(nil), .notReading] {
      #expect(Supervisor.mainNeedsYouKind(n) == nil, "\(String(describing: n)): a restart is what this is for")
    }
    let d = MainRestartCheck.encode(
      at: 1_700_000_000, verdict: .init(willReturn: true, reasons: []), last: nil, needsYou: ("folder trust", 1_700_000_000))
    let o = try #require(try JSONSerialization.jsonObject(with: d) as? [String: Any])
    let ny = try #require(o["needs_you"] as? [String: Any])
    #expect(ny["kind"] as? String == "folder trust" && ISOTime.parse(ny["since"] as? String ?? "") == 1_700_000_000)
    let none = try #require(try JSONSerialization.jsonObject(with: MainRestartCheck.encode(at: 1, verdict: .init(willReturn: true, reasons: []), last: nil)) as? [String: Any])
    #expect(none["needs_you"] == nil)
  }
}
