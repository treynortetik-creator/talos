import Foundation
import Testing
import TalosDesktopCore
@testable import TalosSupervisor

/// Idle parking follows what the session does, not what the pane repaints (docs/OPTION-C.md, "Idle"). The owner's Claude Code status line
/// ("Sonnet 5.5 | 20% | 7d: 38%", under the input box) repaints when usage changes, from any session, so tmux's `window_activity` moves
/// with no turn at all. The fake worker (`review-worker.sh`) repaints such a row on `FAKE_RV_STATUS`. Private tmux (`talos-test-…`,
/// never `-L talos`) and the fake claude only.
private let scenario = "review-worker.sh"

/// A tmux client on the thread's session with a tty (`script`), as the Terminals window is. Its activity time is its last key.
private final class AttachedClient: @unchecked Sendable {
  private let process = Process()
  private let input = Pipe()

  init(_ r: WorkerRig, session: String = "t-trip") throws {
    process.executableURL = URL(fileURLWithPath: "/usr/bin/script")
    process.arguments = ["-q", "/dev/null", Rig.tmuxPath!, "-L", r.socket, "-f", Rig.tmuxConf, "attach-session", "-t", "=\(session)"]
    process.environment = ["TERM": "xterm-256color", "PATH": "/usr/bin:/bin", "HOME": r.root + "/home"]
    process.standardInput = input
    signal(SIGPIPE, SIG_IGN)  // a key typed after the client has gone (its session was parked) is an error here, not the end of the run
    process.standardOutput = FileHandle.nullDevice
    process.standardError = FileHandle.nullDevice
    try process.run()
    #expect(r.wait(5) { !r.tmuxCmd(["list-clients", "-t", "=\(session)", "-F", "#{client_activity}"]).out.isEmpty }, "the client never attached")
  }

  /// A key from the client: it reaches the pane's tty (which does not echo it in `FAKE_RV_DEAF` mode) and moves `client_activity`.
  func type(_ s: String = "k") { try? input.fileHandleForWriting.write(contentsOf: Data(s.utf8)) }

  func stop() {
    if process.isRunning { process.terminate() }
    process.waitUntilExit()
  }
}

extension WorkerRig {
  /// tmux's own reading of the last output in the pane (`#{window_activity}`, whole seconds): what the old idle clock followed.
  func paneActivity(_ id: String = "trip") -> Double? {
    Double(tmuxCmd(["display-message", "-p", "-t", "=t-\(id):", "#{window_activity}"]).out.trimmingCharacters(in: .whitespacesAndNewlines))
  }

  /// True when, for `seconds`, the pane was repainted every second or so: the status line is the only thing moving.
  func paneKeepsRepainting(for seconds: Double) -> Bool {
    guard let first = paneActivity() else { return false }
    var seen = Set<Double>([first])
    let until = Date().addingTimeInterval(seconds)
    while Date() < until {
      if let a = paneActivity() { seen.insert(a) }
      usleep(250_000)
    }
    return seen.count >= Int(seconds) - 1
  }

  /// The screen as the pane shows it now, without the status row, which repaints on its own.
  func screenWithoutStatusRow(_ id: String = "trip") -> String {
    TmuxCommands.parseCapture(screen(id)).filter { !$0.contains("Sonnet 5.5") }.joined(separator: "\n")
  }

  /// One thread's entry in `workers.json`, as plain JSON: the keys are what the file holds, not what a type calls them.
  func rawEntry(_ id: String = "trip") -> [String: Any]? {
    guard let d = FileManager.default.contents(atPath: talosHome + "/workers.json"),
      let root = (try? JSONSerialization.jsonObject(with: d)) as? [String: Any]
    else { return nil }
    return (root["threads"] as? [String: Any])?[id] as? [String: Any]
  }

  /// `workers.json` with this entry changed, as it is when a new copy of the app finds it.
  func editEntry(_ id: String = "trip", _ edit: (inout [String: Any]) -> Void) throws {
    let url = URL(fileURLWithPath: talosHome + "/workers.json")
    var root = try #require(try JSONSerialization.jsonObject(with: Data(contentsOf: url)) as? [String: Any])
    var threads = try #require(root["threads"] as? [String: Any])
    var e = try #require(threads[id] as? [String: Any])
    edit(&e)
    threads[id] = e
    root["threads"] = threads
    try JSONSerialization.data(withJSONObject: root).write(to: url)
  }

  /// Stays up for `seconds`, checked every 100 ms. The message names the state if it does not.
  func staysUp(for seconds: Double, _ why: String) -> Bool {
    let until = Date().addingTimeInterval(seconds)
    while Date() < until {
      if !up("trip") {
        Issue.record("\(why): \(String(describing: state("trip"))) \(self.why("trip"))")
        return false
      }
      usleep(100_000)
    }
    return true
  }
}

@Suite("Idle parking follows real activity", .serialized, .enabled(if: Rig.hasTmux))
struct WorkerIdleActivity {
  /// The bug: a pane that repaints only its status row every second, with no turn and no key, never reached the idle limit.
  @Test func aPaneThatOnlyRepaintsItsStatusLineStillParksAfterTheIdleLimit() throws {
    let r = try WorkerRig(scenario: scenario, extraEnv: ["FAKE_RV_STATUS": "1"])
    defer { r.teardown() }
    r.makeManager(idle: 3)  // this one reports its events to the rig
    r.mgr.startTicking()
    try r.wake("trip")
    #expect(r.wait(8) { r.up("trip") }, "\(r.why("trip"))")
    #expect(r.wait(8) { r.typedLines.count == 1 }, "the pointer never went in: \(r.why("trip"))")
    #expect(r.paneKeepsRepainting(for: 2.5), "precondition: tmux sees the pane move every second, so the old clock would never run out")
    #expect(r.wait(15) { r.state("trip") == "parked" }, "never parked with only the status row moving: \(r.why("trip"))")
    #expect(r.wait(5) { r.allEvents.contains(.parked(thread: "trip", reason: "idle")) }, "\(r.allEvents)")  // emitted just after the state
  }

  /// Control: a turn is activity. It keeps the worker up while it runs (busy), and its end starts the idle time, so the worker is not
  /// parked the moment the turn stops even though the pointer that began it is older than the limit. With the status row repainting
  /// all along, the worker then parks one idle time after the turn.
  @Test(arguments: [false, true])
  func aRealTurnKeepsTheWorkerUpAndItsEndStartsTheIdleTime(statusLine: Bool) throws {
    let r = try WorkerRig(scenario: scenario, extraEnv: statusLine ? ["FAKE_RV_STATUS": "1"] : [:])
    defer { r.teardown() }
    let turn = r.root + "/turn"
    r.env["FAKE_RV_TURN"] = turn
    r.manager(idle: 4)
    r.mgr.startTicking()
    try r.wake("trip")
    #expect(r.wait(8) { r.up("trip") }, "\(r.why("trip"))")
    #expect(r.wait(8) { r.typedLines.count == 1 }, "the pointer never went in: \(r.why("trip"))")
    FileManager.default.createFile(atPath: turn, contents: nil)
    #expect(r.staysUp(for: 6.5, "parked in the middle of a turn"), "a turn longer than the idle limit")
    try FileManager.default.removeItem(atPath: turn)
    let ended = Date()
    // past the busy window, well inside one idle time after the turn: only the turn's own activity keeps it up
    #expect(r.staysUp(for: 2.5, "parked right after the turn ended"))
    #expect(Date().timeIntervalSince(ended) < 4)
    #expect(r.wait(12) { r.state("trip") == "parked" }, "control: it parks once a whole idle time has passed since the turn: \(r.why("trip"))")
  }

  /// Control: a busy worker is never parked, whatever the screen shows. The noise is the same line over and over (tmux sees output; the
  /// text does not change), and the idle limit is a fraction of the run.
  @Test func aBusyWorkerIsNeverParkedEvenWhenTheScreenTextStaysTheSame() throws {
    let r = try WorkerRig(scenario: scenario, extraEnv: ["FAKE_RV_NOISE": "trip"])
    defer { r.teardown() }
    r.env["FAKE_RV_QUIET"] = r.root + "/quiet"
    r.manager(idle: 1, busyWindow: 2.5)
    r.mgr.startTicking()
    try r.wake("trip")
    #expect(r.wait(8) { r.state("trip") == "busy" }, "\(r.why("trip"))")
    #expect(r.staysUp(for: 4, "parked while output was coming"))
    FileManager.default.createFile(atPath: r.root + "/quiet", contents: nil)
    #expect(r.wait(10) { r.state("trip") == "parked" }, "control: quiet, it parks: \(r.why("trip"))")
  }

  /// Control: a pointer still owed is never idle-parked, status line or not; once it is typed the idle limit applies.
  @Test func aPointerStillOwedBlocksTheParkEvenWithAStatusLineRepainting() throws {
    let r = try WorkerRig(scenario: scenario, extraEnv: ["FAKE_RV_STATUS": "1", "FAKE_RV_ECHO_BOX": "1"])
    defer { r.teardown() }
    let gate = r.root + "/gate"
    r.env["FAKE_RV_BOX_FILE"] = gate
    r.manager(idle: 3)
    r.mgr.startTicking()
    try r.wake("trip")
    #expect(r.wait(8) { r.up("trip") }, "\(r.why("trip"))")
    #expect(r.staysUp(for: 6.5, "parked with the pointer owed"), "twice the idle limit, no input box on the pane")
    FileManager.default.createFile(atPath: gate, contents: nil)
    #expect(r.wait(10) { r.typedLines.count == 1 }, "the line never went in: \(r.typedLines) \(r.why("trip"))")
    #expect(r.wait(10) { r.state("trip") == "parked" }, "control: nothing owed, only the status row moving, it parks: \(r.why("trip"))")
  }

  /// Control: a worker waiting on the owner (a dialog on screen) is never idle-parked; answered, it parks.
  @Test func aWorkerWaitingOnTheOwnerBlocksTheParkEvenWithAStatusLineRepainting() throws {
    let r = try WorkerRig(scenario: scenario, extraEnv: ["FAKE_RV_STATUS": "4"])
    defer { r.teardown() }
    let flag = r.root + "/dialog", gone = r.root + "/gone"
    r.env["FAKE_RV_DIALOG"] = flag
    r.env["FAKE_RV_DIALOG_GONE"] = gone
    // A status repaint changes the screen, and a dialog counts only once the screen has held still for `dialogSettle`, so the flag drops
    // for that long after each repaint. The busy window is what covers the gap (a repaint is output, so the worker is busy for it), as in
    // the app, where it is 15 s against a settle of 5: here the window is the longer of the two too, and shorter than the 4 s between repaints.
    r.manager(idle: 3, busyWindow: 2.5)
    r.mgr.tune { $0.dialogSettle = 0.5 }
    r.mgr.startTicking()
    try r.wake("trip")
    #expect(r.wait(8) { r.up("trip") }, "\(r.why("trip"))")
    #expect(r.wait(8) { r.typedLines.count == 1 }, "the pointer never went in: \(r.why("trip"))")
    FileManager.default.createFile(atPath: flag, contents: nil)
    #expect(r.wait(10) { r.mgr.needsYou()["trip"] != nil }, "the dialog was never flagged: \(r.mgr.needsYou())")
    #expect(r.staysUp(for: 5, "parked while waiting on the owner"), "more than the idle limit")
    FileManager.default.createFile(atPath: gone, contents: nil)
    #expect(r.wait(12) { r.state("trip") == "parked" }, "control: answered, it parks: \(r.why("trip"))")
  }

  /// The flag is held through repaints, whatever the busy window: the settle (2.5 s) is longer than the busy window and than the gap a
  /// repaint (every 4 s) leaves, so for ~1.5 s after each repaint the worker is not busy, the screen is unsettled and idle is past the limit.
  /// Dialog going away (a settled screen without it) ends the hold: it parks after the idle limit, no stuck flag.
  @Test(arguments: [false, true])
  func aDialogIsHeldThroughRepaintsEvenWhenRedetectionOutlastsTheBusyWindow(goesAway: Bool) throws {
    let r = try WorkerRig(scenario: scenario, extraEnv: ["FAKE_RV_STATUS": "4"])
    defer { r.teardown() }
    let flag = r.root + "/dialog", gone = r.root + "/gone"
    r.env["FAKE_RV_DIALOG"] = flag
    r.env["FAKE_RV_DIALOG_GONE"] = gone
    r.manager(idle: 3, busyWindow: 0.5)
    r.mgr.tune { $0.dialogSettle = 2.5 }
    r.mgr.startTicking()
    try r.wake("trip")
    #expect(r.wait(8) { r.up("trip") }, "\(r.why("trip"))")
    #expect(r.wait(8) { r.typedLines.count == 1 }, "the pointer never went in: \(r.why("trip"))")
    FileManager.default.createFile(atPath: flag, contents: nil)
    #expect(r.wait(15) { r.mgr.needsYou()["trip"] != nil }, "the dialog was never flagged: \(r.mgr.needsYou())")
    #expect(r.staysUp(for: 10, "parked while the dialog was on screen"), "more than twice the idle limit and two repaints")
    #expect(r.mgr.needsYou()["trip"] != nil, "the flag dropped with the dialog still on screen")
    guard goesAway else { return }
    FileManager.default.createFile(atPath: gone, contents: nil)
    #expect(r.wait(15) { r.state("trip") == "parked" }, "the dialog went away but the worker never parked: \(r.why("trip"))")
    #expect(r.mgr.needsYou()["trip"] == nil, "a stuck needs-you flag")
  }

  /// A prompt nobody named, on a pane whose status line repaints faster than the settle: the screen is never still, so only "no dialog
  /// shape for `dialogSettle` running" can end the hold once the question is answered.
  @Test func aPromptHoldEndsWhenItIsGoneEvenWithAStatusLineRepaintingFasterThanTheSettle() throws {
    let r = try WorkerRig(scenario: scenario, extraEnv: ["FAKE_RV_STATUS": "1"])
    defer { r.teardown() }
    let ask = r.root + "/ask", gone = r.root + "/askgone"
    r.env["FAKE_RV_QUESTION"] = ask
    r.env["FAKE_RV_QUESTION_GONE"] = gone
    r.manager(idle: 3, busyWindow: 0.5)
    r.mgr.tune { $0.dialogSettle = 2.5 }
    r.mgr.startTicking()
    try r.wake("trip")
    #expect(r.wait(8) { r.up("trip") }, "\(r.why("trip"))")
    #expect(r.wait(8) { r.typedLines.count == 1 }, "the pointer never went in: \(r.why("trip"))")
    FileManager.default.createFile(atPath: ask, contents: nil)
    #expect(r.wait(15) { r.mgr.needsYou()["trip"] != nil }, "the question was never flagged: \(r.mgr.needsYou())")
    #expect(r.staysUp(for: 6, "parked while a question was on screen"), "more than the idle limit")
    FileManager.default.createFile(atPath: gone, contents: nil)
    #expect(r.wait(15) { r.state("trip") == "parked" }, "answered, but it never parked: \(r.why("trip"))")
  }

  /// A relaunch: the new copy takes the worker over with what the file says (the saved last activity, the last pointer, the start) and
  /// nothing the pane says: its status row has repainted a moment ago whatever the file holds. The file's times are written here, a
  /// long time ago or a few seconds ago, so no wait and no clock decides it. The limit is ten minutes.
  @Test(arguments: [
    // started, last pointer, saved last activity (seconds ago; nil = the file has none): parks at the first look?
    (3600.0, 3600.0, nil, true),
    (3600.0, 3600.0, 3600.0, true),
    (3600.0, 3600.0, 5.0, false),  // a turn that ended 5 s before the relaunch, after a pointer an hour ago
    (3600.0, 5.0, 3600.0, false),  // the pointer is the newest thing
    (5.0, 3600.0, 3600.0, false),  // just started
  ] as [(Double, Double, Double?, Bool)])
  func anAdoptedWorkerIsSeededFromTheFileAndNotFromThePane(
    startedAgo: Double, pointerAgo: Double, savedAgo: Double?, parks: Bool
  ) throws {
    let r = try WorkerRig(scenario: scenario, extraEnv: ["FAKE_RV_STATUS": "1"])
    defer { r.teardown() }
    r.manager(idle: 600)
    r.mgr.startTicking()
    try r.wake("trip")
    #expect(r.wait(8) { r.up("trip") }, "\(r.why("trip"))")
    #expect(r.wait(8) { r.typedLines.count == 1 }, "the pointer never went in: \(r.why("trip"))")
    #expect(r.wait(3) { (r.entry("trip")?.pane_pid ?? 0) > 1 })
    r.mgr.detach()
    let now = Date().timeIntervalSince1970
    try r.editEntry {
      $0["started_at"] = ISOTime.string(now - startedAgo)
      $0["last_turn_at"] = ISOTime.string(now - pointerAgo)
      if let ago = savedAgo { $0["last_active_at"] = ISOTime.string(now - ago) } else { $0.removeValue(forKey: "last_active_at") }
    }
    #expect(r.paneKeepsRepainting(for: 2.5), "precondition: the pane is still repainting, so tmux's own activity time is a second old")
    r.manager(idle: 600)
    r.firstTick()
    r.mgr.startTicking()
    if parks {
      #expect(r.wait(10) { ["parking", "parked"].contains(r.state("trip") ?? "") }, "an adopted worker was kept by a repaint: \(r.why("trip"))")
    } else {
      #expect(r.staysUp(for: 4, "an adopted worker with recent activity in the file was parked"))
    }
  }

  /// What a relaunch will read: the last activity is in `workers.json` while the worker has a pane, follows the pointer and the screen
  /// (not the status row), and is gone from the entry once the worker is parked.
  @Test func theLastActivityIsSavedInWorkersJsonWhileThePaneIsUp() throws {
    let r = try WorkerRig(scenario: scenario, extraEnv: ["FAKE_RV_STATUS": "1"])
    defer { r.teardown() }
    r.makeManager(idle: 600)
    r.mgr.startTicking()
    try r.wake("trip")
    #expect(r.wait(8) { r.up("trip") }, "\(r.why("trip"))")
    #expect(r.wait(8) { r.typedLines.count == 1 }, "the pointer never went in: \(r.why("trip"))")
    let typed = Date().timeIntervalSince1970
    sleep(4)  // the status row repaints four times meanwhile
    var saved: Double?
    #expect(r.wait(5) { saved = (r.rawEntry()?["last_active_at"] as? String).flatMap(ISOTime.parse); return saved != nil }, "no last_active_at in workers.json: \(String(describing: r.rawEntry()))")
    let at = try #require(saved)
    #expect(at > typed - 3 && at < typed + 2, "saved \(at - typed) s from the pointer; the status row must not move it")
    try r.wakeFile("trip", action: "park", reason: "control")
    #expect(r.wait(10) { r.state("trip") == "parked" }, "\(r.why("trip"))")
    #expect(r.wait(3) { r.rawEntry()?["state"] as? String == "parked" })
    #expect(r.rawEntry()?["last_active_at"] == nil, "a parked worker has no activity to carry over")
  }

  /// A new start begins the watch of the screen again: what the last run's pane looked like is not what this one is compared with.
  @Test func aStartForgetsWhatTheLastPaneLookedLike() throws {
    let r = try WorkerRig(scenario: scenario)
    defer { r.teardown() }
    r.makeManager(idle: 600)
    try r.wake("trip")
    #expect(r.wait(10) { r.mgr.tickOnce(); return r.up("trip") && r.typedLines.count == 1 }, "\(r.why("trip"))")
    try r.wakeFile("trip", action: "park", reason: "control")
    #expect(r.wait(10) { r.mgr.tickOnce(); return r.state("trip") == "parked" }, "\(r.why("trip"))")
    r.mgr.rt["trip"]?.body = "the last pane"
    r.mgr.rt["trip"]?.screenText = "the last pane"
    r.mgr.rt["trip"]?.screenSameSince = 1
    try r.wake("trip")
    // the tick that starts the session ends before the first look at its pane (`advance` runs first in a tick)
    #expect(r.wait(10) { r.mgr.tickOnce(); return r.state("trip") == "starting" }, "\(r.why("trip"))")
    #expect(r.mgr.rt["trip"]?.body == nil, "the new pane is compared with the old one")
    #expect(r.mgr.rt["trip"]?.screenText == nil)
    #expect(r.mgr.rt["trip"]?.screenSameSince == 0, "a dialog on the new pane would count as settled at once")
  }

  /// An attached client typing is the owner at the keys. The pane's tty does not echo, so the screen does not change and the status row
  /// is all that moves: only the client's activity time says the owner is there. Past the idle limit it parks once the owner stops.
  @Test func anAttachedClientTypingKeepsTheWorkerUpAndWhenItStopsTheWorkerParks() throws {
    let r = try WorkerRig(scenario: scenario, extraEnv: ["FAKE_RV_STATUS": "1"])
    defer { r.teardown() }
    let deaf = r.root + "/deaf"
    r.env["FAKE_RV_DEAF"] = deaf
    r.manager(idle: 3)
    r.mgr.startTicking()
    try r.wake("trip")
    #expect(r.wait(8) { r.up("trip") }, "\(r.why("trip"))")
    #expect(r.wait(8) { r.typedLines.count == 1 }, "the pointer never went in: \(r.why("trip"))")
    FileManager.default.createFile(atPath: deaf, contents: nil)  // the pointer is in; from here a typed key is not drawn
    usleep(500_000)
    let client = try AttachedClient(r)
    defer { client.stop() }
    // precondition: a key from the client changes nothing on the screen (the status row aside), so only the client's activity time can
    // be what keeps the worker up below
    let before = r.screenWithoutStatusRow()
    client.type()
    usleep(700_000)
    let after = r.screenWithoutStatusRow()
    #expect(!before.isEmpty && before == after, "the key was drawn:\n\(before)\n--\n\(after)")
    let until = Date().addingTimeInterval(8)  // well past one idle time since the pointer
    while Date() < until {
      client.type()
      #expect(r.up("trip"), "parked while a client was typing: \(r.why("trip"))")
      usleep(500_000)
    }
    #expect(r.wait(15) { r.state("trip") == "parked" }, "the client stopped typing, it is still attached: \(r.why("trip"))")
  }

  /// The client list can't be read: that is not "nobody is typing". No park until it can.
  @Test func anUnreadableClientListHoldsTheIdlePark() throws {
    let r = try WorkerRig(scenario: scenario)
    defer { r.teardown() }
    let shim = try r.faultShim()
    r.manager(idle: 2, tmux: shim)
    r.mgr.startTicking()
    try r.wake("trip")
    #expect(r.wait(8) { r.up("trip") }, "\(r.why("trip"))")
    #expect(r.wait(8) { r.typedLines.count == 1 }, "the pointer never went in: \(r.why("trip"))")
    try r.fault("list-clients", "hold")
    #expect(r.staysUp(for: 5, "parked with the client list unreadable"), "more than twice the idle limit")
    r.clearFault("list-clients")
    #expect(r.wait(10) { r.state("trip") == "parked" }, "control: readable again, it parks: \(r.why("trip"))")
  }
}
