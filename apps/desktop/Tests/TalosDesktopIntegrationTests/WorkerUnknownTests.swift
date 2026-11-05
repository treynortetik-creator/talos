import Foundation
import Testing
import TalosDesktopCore
import TalosSupervisor

/// "Uncertain state must never cause an action": every read that can fail, failing, through the real manager. Private tmux
/// (`talos-test-…`) and the fake claude only. `tick` is a real tick on a real clock unless a test injects one.
private let scenario = "review-worker.sh"

private final class Clocks: @unchecked Sendable {
  private let l = NSLock()
  private var wall = Date().timeIntervalSince1970
  private var up: Double = 0
  private let born = Date()
  /// Follows real time, plus whatever a test added.
  var now: Double { l.withLock { wall + Date().timeIntervalSince(born) } }
  var awake: Double { l.withLock { up + Date().timeIntervalSince(born) } }
  func jumpWall(_ s: Double) { l.withLock { wall += s } }
  func jumpAwake(_ s: Double) { l.withLock { up += s } }
}

private final class EventLog: @unchecked Sendable {
  private let l = NSLock()
  private var events: [WorkerManager.Event] = []
  var all: [WorkerManager.Event] { l.withLock { events } }
  func add(_ e: WorkerManager.Event) { l.withLock { events.append(e) } }
}

@Suite("Option C unknowns: pointer", .serialized, .enabled(if: Rig.hasTmux))
struct WorkerUnknownPointer {
  @Test func aFailedClientListNeverTypes() throws {
    let r = try WorkerRig(scenario: scenario)
    defer { r.teardown() }
    let shim = try r.faultShim()
    r.manager(tmux: shim)
    try r.fault("list-clients", "hold")
    r.mgr.startTicking()
    try r.wake("trip")
    #expect(r.wait(8) { r.up("trip") })
    usleep(800_000)
    #expect(r.typedLines.isEmpty, "typed with the typing guard unread")
    r.clearFault("list-clients")
    #expect(r.wait(5) { r.typedLines.count == 1 }, "control: it goes in once the guard can be read")
  }

  /// What the pane shows right now: the same screen the manager reads, from the real tmux.
  private func paneText(_ r: WorkerRig) -> String {
    r.tmuxCmd(["capture-pane", "-p", "-J", "-t", "=t-trip:"]).out
  }

  /// The text is in, the Enter failed, and a dialog comes up: the owed Enter must not answer it.
  @Test func anOwedEnterWaitsForTheScreenToo() throws {
    let r = try WorkerRig(scenario: scenario)
    defer { r.teardown() }
    let flag = r.root + "/dialog"
    r.env["FAKE_RV_DIALOG"] = flag
    let shim = try r.faultShim()
    r.manager(tmux: shim)
    try r.fault("Enter", "hold")
    r.mgr.startTicking()
    try r.wake("trip")
    #expect(r.wait(8) { r.up("trip") })
    // the text is typed (the pane echoes it) and the Enter is owed; a whole tick after that has retried the Enter and been refused
    #expect(r.wait(8) { paneText(r).contains(PointerTyper.text) }, "the pointer text was never typed")
    r.mgr.tickOnce()
    #expect(r.typedLines.isEmpty, "Enter went in while the fault was held")
    FileManager.default.createFile(atPath: flag, contents: nil)
    #expect(r.wait(8) { paneText(r).contains("Yes, I trust this folder") }, "the dialog never came up")
    r.mgr.tickOnce()  // barrier: this tick, and every later one, reads the dialog on screen
    r.clearFault("Enter")
    for _ in 0..<3 { r.mgr.tickOnce() }  // whole ticks with the Enter working and the dialog up
    #expect(r.typedLines.isEmpty, "Enter went into a dialog")
    // control: the owed Enter does go in once the dialog is gone (a reset blanks the screen; the typed text stays in the tty)
    #expect(r.tmuxCmd(["send-keys", "-R", "-t", "=t-trip:"]).ok)
    #expect(r.wait(8) { !paneText(r).contains("Yes, I trust this folder") }, "the dialog stayed on screen")
    #expect(r.wait(8) { r.mgr.tickOnce(); return r.typedLines.count == 1 }, "control: it goes in once the dialog is gone: \(r.typedLines)")
    #expect(r.typedLines.first == "trip \(PointerTyper.text)", "\(r.typedLines)")
  }

  /// The pointer goes in once, not twice, however long the Enter takes.
  @Test func aRetriedEnterDoesNotRepeatTheText() throws {
    let r = try WorkerRig(scenario: scenario)
    defer { r.teardown() }
    let shim = try r.faultShim()
    r.manager(tmux: shim)
    try r.fault("Enter", "hold")
    r.mgr.startTicking()
    try r.wake("trip")
    #expect(r.wait(8) { r.up("trip") })
    usleep(700_000)
    r.clearFault("Enter")
    #expect(r.wait(5) { r.typedLines.count == 1 })
    #expect(r.typedLines.first == "trip \(PointerTyper.text)", "\(r.typedLines)")
  }

  /// A message still waiting when a worker crashes isn't lost: the next run takes it, and is told to.
  @Test func aCrashWithAPointerWaitingResumes() throws {
    let r = try WorkerRig(scenario: scenario)
    defer { r.teardown() }
    let shim = try r.faultShim()
    r.manager(tmux: shim)
    r.mgr.startTicking()
    try r.wake("trip")
    #expect(r.wait(8) { r.typedLines.count == 1 })
    let pid = try #require(r.entry("trip")?.pane_pid)
    try r.fault("capture-pane", "hold")
    r.mgr.tickOnce()  // barrier: any tick already in flight has finished, so the wake below is read under the fault
    try r.wake("trip")
    for _ in 0..<3 { r.mgr.tickOnce() }
    try r.fault("list-clients", "hold")
    r.mgr.tickOnce()  // barrier: from here every tick sees list-clients held, so the pointer cannot be typed before the crash
    r.clearFault("capture-pane")  // cleared only after list-clients is held: no tick sees neither fault and types the pointer early
    kill(pid, SIGKILL)
    #expect(r.wait(6) { r.starts.count == 2 }, "\(String(describing: r.state("trip")))")
    r.clearFault("list-clients")
    #expect(r.wait(6) { r.typedLines.count == 2 })
  }
}

@Suite("Option C unknowns: is it gone", .serialized, .enabled(if: Rig.hasTmux))
struct WorkerUnknownGone {
  /// Real tmux output, not a shim: the wording `saysGone` depends on.
  @Test func aKilledSessionIsGone() throws {
    let r = try WorkerRig(scenario: scenario)
    defer { r.teardown() }
    r.manager()
    r.mgr.startTicking()
    try r.wake("trip")
    #expect(r.wait(8) { r.up("trip") })
    let pid = try #require(r.entry("trip")?.pane_pid)
    #expect(r.tmuxCmd(["kill-session", "-t", "=t-trip"]).ok)
    #expect(r.wait(5) { r.state("trip") == "parked" }, "\(String(describing: r.state("trip")))")
    #expect(r.entry("trip")?.restarts.count == 1)
    #expect(r.wait(5) { !ProcessInspect.groupAlive(pid) })
  }

  @Test func aKilledServerIsGone() throws {
    let r = try WorkerRig(scenario: scenario)
    defer { r.teardown() }
    r.manager()
    r.mgr.startTicking()
    try r.wake("trip")
    #expect(r.wait(8) { r.up("trip") })
    #expect(r.tmuxCmd(["kill-server"]).ok)
    #expect(r.wait(5) { r.state("trip") == "parked" }, "\(String(describing: r.state("trip")))")
  }

  /// tmux unreachable and the group empty: the kernel settles it, or a dead worker would read as live for ever.
  @Test func aDeadGroupIsGoneEvenWhenTmuxCantSay() throws {
    let r = try WorkerRig(scenario: scenario)
    defer { r.teardown() }
    let shim = try r.faultShim()
    r.manager(tmux: shim)
    r.mgr.startTicking()
    try r.wake("trip")
    #expect(r.wait(8) { r.up("trip") })
    let pid = try #require(r.entry("trip")?.pane_pid)
    try r.fault("has-session", "hold")
    try r.fault("display-message", "hold")
    kill(pid, SIGKILL)
    #expect(r.wait(5) { r.state("trip") == "parked" }, "\(String(describing: r.state("trip")))")
  }

  /// The resume error on a line of its own, in a worker that was up: a crash, whose way back keeps the conversation.
  /// `resume_missing` only ever comes from a start, and its way out is Start fresh.
  @Test func theResumeErrorOnALiveWorkersScreenIsACrash() throws {
    let r = try WorkerRig(scenario: scenario, extraEnv: ["FAKE_RV_BANNER": "No session found with ID 6f1c2a9e."])
    defer { r.teardown() }
    r.manager()
    r.mgr.startTicking()
    try r.wake("trip")
    #expect(r.wait(8) { r.up("trip") })
    let pid = try #require(r.entry("trip")?.pane_pid)
    kill(pid, SIGKILL)
    #expect(r.wait(5) { (r.entry("trip")?.restarts.count ?? 0) >= 1 }, "\(String(describing: r.entry("trip")?.error))")
    #expect(r.entry("trip")?.error?.code != "resume_missing")
  }

  /// `Process.run` throwing: status 127, every worker at once (a full process table, a moved binary).
  @Test func tmuxItselfMissingStopsNothing() throws {
    let r = try WorkerRig(scenario: scenario)
    defer { r.teardown() }
    let shim = try r.faultShim()
    r.manager(tmux: shim)
    r.mgr.startTicking()
    try r.wake("trip")
    #expect(r.wait(8) { r.up("trip") })
    let pid = try #require(r.entry("trip")?.pane_pid)
    try FileManager.default.moveItem(atPath: shim, toPath: shim + ".away")
    usleep(1_000_000)
    try FileManager.default.moveItem(atPath: shim + ".away", toPath: shim)
    #expect(ProcessInspect.groupAlive(pid))
    #expect(r.up("trip"), "\(String(describing: r.state("trip")))")
    #expect(r.entry("trip")?.restarts.isEmpty == true)
  }

  /// No screen, no decision: not the idle park, and not the ready timeout.
  @Test func aFailedScreenReadStopsNothing() throws {
    let r = try WorkerRig(scenario: scenario)
    defer { r.teardown() }
    let shim = try r.faultShim()
    r.manager(idle: 0.5, tmux: shim)
    r.mgr.startTicking()
    try r.fault("capture-pane", "hold")
    try r.wake("trip")
    usleep(1_500_000)
    let pid = try #require(r.entry("trip")?.pane_pid)
    #expect(r.state("trip") == "starting")
    r.clearFault("capture-pane")
    #expect(r.wait(5) { r.state("trip") == "parked" }, "control: idle parks once the screen can be read")
    #expect(!ProcessInspect.groupAlive(pid))
  }

  @Test func aStartNeverTimesOutOnAScreenItCantRead() throws {
    let r = try WorkerRig(scenario: scenario, extraEnv: ["FAKE_RV_NO_READY": "1"])
    defer { r.teardown() }
    let shim = try r.faultShim()
    r.manager(tmux: shim, readyTimeout: 0.4)
    try r.fault("capture-pane", "hold")
    r.mgr.startTicking()
    try r.wake("trip")
    usleep(1_200_000)
    #expect(r.state("trip") == "starting", "\(String(describing: r.entry("trip")?.error))")
    r.clearFault("capture-pane")
    #expect(r.wait(3) { r.state("trip") == "failed" }, "control: the timeout still works")
  }
}

@Suite("Option C unknowns: off mid-work", .serialized, .enabled(if: Rig.hasTmux))
struct WorkerUnknownOff {
  /// Switched off mid-turn with tmux unreadable: `stopping`, and no signal until a read shows the pane quiet.
  @Test func switchingOffDuringFailedReadsWaits() throws {
    let r = try WorkerRig(scenario: scenario, extraEnv: ["FAKE_RV_NOISE": "trip"])
    defer { r.teardown() }
    let sig = r.root + "/signals"
    let quiet = r.root + "/quiet"
    r.env["FAKE_RV_SIGLOG"] = sig
    r.env["FAKE_RV_QUIET"] = quiet
    let shim = try r.faultShim()
    r.manager(tmux: shim, busyWindow: 2.5)
    r.mgr.startTicking()
    try r.wake("trip")
    #expect(r.wait(8) { r.state("trip") == "busy" })
    try r.fault("display-message", "hold")
    try r.writeConfig(maxLive: 3, threads: [])
    #expect(r.wait(3) { r.state("trip") == "stopping" })
    usleep(800_000)
    #expect(r.lines(sig).isEmpty, "signalled on a failed read")
    r.clearFault("display-message")
    usleep(500_000)
    #expect(r.lines(sig).isEmpty, "signalled mid-turn")
    FileManager.default.createFile(atPath: quiet, contents: nil)
    #expect(r.wait(8) { r.state("trip") == "parked" }, "control: it parks after the turn")
  }

  /// A running worker and a config that says nothing readable: it stays, whatever it says.
  @Test(arguments: [#"{"dedicated":"yes"}"#, #"{"dedicated":{"enabled":"yes"}}"#, "{ half a file"])
  func anUnreadableConfigLeavesARunningWorker(_ text: String) throws {
    let r = try WorkerRig(scenario: scenario)
    defer { r.teardown() }
    r.manager()
    r.mgr.startTicking()
    try r.wake("trip")
    #expect(r.wait(8) { r.up("trip") })
    let pid = try #require(r.entry("trip")?.pane_pid)
    try text.write(toFile: r.talosHome + "/config.json", atomically: true, encoding: .utf8)
    usleep(800_000)
    #expect(ProcessInspect.groupAlive(pid))
    #expect(r.up("trip"), "\(String(describing: r.state("trip")))")
  }

  /// With no config read since launch there are no settings: no wake is taken and no start can happen.
  @Test func noConfigAtLaunchTakesNoWake() throws {
    let r = try WorkerRig(scenario: scenario)
    defer { r.teardown() }
    try "{ half a file".write(toFile: r.talosHome + "/config.json", atomically: true, encoding: .utf8)
    r.manager()
    try r.wake("trip")
    r.mgr.tickOnce()
    #expect(r.starts.isEmpty)
    #expect(FileManager.default.fileExists(atPath: r.talosHome + "/workers/trip/wake"), "the wake was thrown away")
    try r.writeConfig(maxLive: 3, threads: [("trip", nil)])
    r.mgr.startTicking()
    #expect(r.wait(8) { r.up("trip") }, "control: it runs once the config can be read")
  }
}

@Suite("Option C unknowns: adopt and start", .serialized, .enabled(if: Rig.hasTmux))
struct WorkerUnknownAdopt {
  /// A wake for a worker adopt can't read waits in its file: taken now, it would start a second run or get lost.
  @Test func aWakeWaitsForAdoptToFinish() throws {
    let r = try WorkerRig(scenario: scenario)
    defer { r.teardown() }
    let shim = try r.faultShim()
    let pid = try r.liveWorkerThenAppGone(tmux: shim)
    r.manager(tmux: shim)
    try r.fault("has-session", "hold")
    try r.wake("trip")
    r.mgr.tickOnce()
    r.mgr.tickOnce()
    #expect(r.up("trip"), "\(String(describing: r.state("trip")))")
    #expect(!r.mgr.ownedGroups.contains(pid))
    #expect(FileManager.default.fileExists(atPath: r.talosHome + "/workers/trip/wake"))
    r.clearFault("has-session")
    r.mgr.tickOnce()
    #expect(r.mgr.ownedGroups.contains(pid))
    r.mgr.tickOnce()
    #expect(r.wait(5) { r.mgr.tickOnce(); return r.typedLines.count == 2 }, "\(r.typedLines)")
    #expect(r.starts.count == 1, "no second run")
  }

  /// Quit with a worker still unread: signal nothing we can't prove is ours; the file keeps it for the next launch.
  @Test func quitLeavesAWorkerItCouldNotRead() throws {
    let r = try WorkerRig(scenario: scenario)
    defer { r.teardown() }
    let shim = try r.faultShim()
    let pid = try r.liveWorkerThenAppGone(tmux: shim)
    r.manager(tmux: shim)
    try r.fault("has-session", "hold")
    r.mgr.tickOnce()
    r.mgr.stopAll()
    #expect(ProcessInspect.groupAlive(pid))
    #expect(r.fileOnDisk?.threads["trip"]?.pane_pid == pid)
    #expect(r.fileOnDisk?.threads["trip"]?.state != "parked")
  }

  /// A state written by a newer build: it may be running, so it gets the same look as any other.
  @Test func anUnknownStateInTheFileIsAdopted() throws {
    let r = try WorkerRig(scenario: scenario)
    defer { r.teardown() }
    let pid = try r.liveWorkerThenAppGone()
    var f = try #require(r.fileOnDisk)
    f.threads["trip"]?.state = "draining"
    try f.encoded().write(to: URL(fileURLWithPath: r.talosHome + "/workers.json"))
    r.manager()
    r.firstTick()
    #expect(r.mgr.ownedGroups.contains(pid))
    #expect(r.up("trip"), "\(String(describing: r.state("trip")))")
  }

  /// tmux can't say whether the name is free: nothing is started, nothing written, nothing failed. It starts when it can.
  @Test func aStartWaitsWhenTheNameCantBeRead() throws {
    let r = try WorkerRig(scenario: scenario)
    defer { r.teardown() }
    let shim = try r.faultShim()
    r.manager(tmux: shim)
    try r.fault("has-session", "hold")
    r.mgr.startTicking()
    try r.wake("trip")
    usleep(700_000)
    #expect(r.starts.isEmpty)
    #expect(r.state("trip") != "failed", "\(String(describing: r.entry("trip")?.error))")
    #expect(!FileManager.default.fileExists(atPath: r.talosHome + "/workers/trip/launch.sh"))
    r.clearFault("has-session")
    #expect(r.wait(8) { r.up("trip") })
    #expect(r.starts.count == 1)
  }

  /// The hold still ends: it never becomes a start much later for a message main has long answered.
  @Test func aStartThatCanNeverReadTheNameIsDropped() throws {
    let r = try WorkerRig(scenario: scenario)
    defer { r.teardown() }
    let shim = try r.faultShim()
    r.manager(tmux: shim, capHold: 0.6)
    try r.fault("has-session", "hold")
    r.mgr.startTicking()
    try r.wake("trip")
    usleep(1_500_000)
    r.clearFault("has-session")
    usleep(800_000)
    #expect(r.starts.isEmpty, "\(r.starts)")
  }

  /// A failed read after `new-session`: the worker is ours once it can be read, and owned from then on.
  @Test func aStartWhoseReadFailedIsOwnedOnTheNextGoodRead() throws {
    let r = try WorkerRig(scenario: scenario)
    defer { r.teardown() }
    let shim = try r.faultShim()
    r.manager(tmux: shim)
    r.mgr.startTicking()
    try r.fault("display-message", "slow")
    try r.wake("trip")
    #expect(r.wait(8) { r.up("trip") }, "\(String(describing: r.state("trip")))")
    let pid = try #require(r.entry("trip")?.pane_pid)
    #expect(pid > 1)
    #expect(r.mgr.ownedGroups.contains(pid))
    #expect(r.starts.count == 1)
  }

  /// However long the read keeps failing: `starting`, running, nothing failed, no second run. It was never "exited at once".
  @Test func aStartStaysStartingWhileItsPaneCantBeRead() throws {
    let r = try WorkerRig(scenario: scenario)
    defer { r.teardown() }
    let shim = try r.faultShim()
    r.manager(tmux: shim)
    r.firstTick()
    try r.fault("display-message", "hold")
    try r.wake("trip")
    r.mgr.tickOnce()
    #expect(r.wait(3) { r.starts.count == 1 })
    for _ in 0..<3 {
      r.mgr.tickOnce()
      usleep(100_000)
    }
    #expect(r.state("trip") == "starting", "\(String(describing: r.entry("trip")?.error))")
    #expect(r.paneAlive())
    r.clearFault("display-message")
    r.mgr.startTicking()
    #expect(r.wait(8) { r.up("trip") })
    #expect(r.starts.count == 1)
  }

  /// Restart tapped before the pane could be read: the tap runs, once, and isn't left armed.
  @Test func aControlBeforeThePaneWasReadStillRuns() throws {
    let r = try WorkerRig(scenario: scenario)
    defer { r.teardown() }
    let shim = try r.faultShim()
    r.manager(tmux: shim)
    r.firstTick()
    try r.fault("display-message", "hold")
    try r.wake("trip")
    r.mgr.tickOnce()
    #expect(r.wait(3) { r.starts.count == 1 })
    try r.wakeFile("trip", action: "restart", reason: "control")
    r.mgr.tickOnce()
    r.clearFault("display-message")
    r.mgr.startTicking()
    #expect(r.wait(10) { r.starts.count == 2 }, "\(String(describing: r.state("trip")))")
    #expect(r.wait(8) { r.up("trip") })
    usleep(500_000)
    try r.wakeFile("trip", action: "park", reason: "control")
    #expect(r.wait(8) { r.state("trip") == "parked" })
    usleep(500_000)
    #expect(r.starts.count == 2, "the tap stayed armed")
  }

  /// Quit before the pane could be read: it still goes, by name, because this run made it.
  @Test func quitStopsAPaneThisRunStartedButCouldNotRead() throws {
    let r = try WorkerRig(scenario: scenario)
    defer { r.teardown() }
    let shim = try r.faultShim()
    r.manager(tmux: shim)
    r.firstTick()
    try r.fault("display-message", "hold")
    try r.wake("trip")
    r.mgr.tickOnce()
    #expect(r.wait(3) { r.starts.count == 1 })
    r.mgr.stopAll()
    #expect(r.wait(3) { !r.paneAlive() })
    #expect(r.state("trip") == "parked")
  }
}

@Suite("Option C unknowns: clock jumps", .serialized, .enabled(if: Rig.hasTmux))
struct WorkerUnknownClock {
  /// Waking from sleep: the wall clock jumps an hour, the turn that was printing is still printing. tmux's activity time is
  /// suddenly an hour old, so the wall clock alone says idle and past the limit.
  @Test func aForwardJumpNeverSignalsATurn() throws {
    let r = try WorkerRig(scenario: scenario, extraEnv: ["FAKE_RV_NOISE": "trip"])
    defer { r.teardown() }
    let sig = r.root + "/signals"
    r.env["FAKE_RV_SIGLOG"] = sig
    r.env["FAKE_RV_QUIET"] = r.root + "/quiet"
    let c = Clocks()
    r.manager(idle: 1, busyWindow: 2.5, now: { c.now }, awake: { c.awake })
    r.mgr.startTicking()
    try r.wake("trip")
    #expect(r.wait(8) { r.state("trip") == "busy" })
    usleep(1_200_000)
    c.jumpWall(3600)
    usleep(1_500_000)
    #expect(r.lines(sig).isEmpty, "SIGTERM mid-turn after a clock jump")
    FileManager.default.createFile(atPath: r.root + "/quiet", contents: nil)
    #expect(r.wait(8) { r.state("trip") == "parked" }, "control: quiet on the awake clock, it parks")
  }

  /// The Mac sleeps just after a start, before the pane's activity has ever changed: the first sighting has to count.
  @Test func aForwardJumpRightAfterAStartWaitsTheBusyWindow() throws {
    let r = try WorkerRig(scenario: scenario)
    defer { r.teardown() }
    let sig = r.root + "/signals"
    r.env["FAKE_RV_SIGLOG"] = sig
    let c = Clocks()
    r.manager(idle: 1, busyWindow: 2.5, now: { c.now }, awake: { c.awake })
    r.mgr.startTicking()
    try r.wake("trip", action: "resume", ids: [])
    #expect(r.wait(8) { r.up("trip") })
    c.jumpWall(3600)
    usleep(600_000)
    #expect(r.lines(sig).isEmpty, "SIGTERM with no quiet seen on the awake clock")
    #expect(r.wait(6) { r.state("trip") == "parked" }, "control: quiet for the window, it parks")
  }

  @Test func aForwardJumpNeverTimesOutAStart() throws {
    let r = try WorkerRig(scenario: scenario, extraEnv: ["FAKE_RV_NO_READY": "1"])
    defer { r.teardown() }
    let c = Clocks()
    r.manager(readyTimeout: 30, now: { c.now }, awake: { c.awake })
    r.mgr.startTicking()
    try r.wake("trip")
    #expect(r.wait(8) { r.state("trip") == "starting" })
    c.jumpWall(3600)
    usleep(600_000)
    #expect(r.state("trip") == "starting", "\(String(describing: r.entry("trip")?.error))")
    c.jumpAwake(60)
    #expect(r.wait(3) { r.state("trip") == "failed" }, "control: real waiting still times out")
  }

  @Test func aForwardJumpNeverCutsAParkShort() throws {
    let r = try WorkerRig(scenario: scenario, extraEnv: ["FAKE_RV_IGNORE_TERM": "1"])
    defer { r.teardown() }
    let c = Clocks()
    r.manager(parkGrace: 30, now: { c.now }, awake: { c.awake })
    r.mgr.startTicking()
    try r.wake("trip")
    #expect(r.wait(8) { r.up("trip") })
    let pid = try #require(r.entry("trip")?.pane_pid)
    usleep(1_200_000)
    try r.wakeFile("trip", action: "park", reason: "control")
    #expect(r.wait(5) { r.state("trip") == "parking" })
    c.jumpWall(3600)
    usleep(600_000)
    #expect(r.state("trip") == "parking")
    #expect(ProcessInspect.groupAlive(pid), "SIGKILL on a clock jump")
    c.jumpAwake(60)
    #expect(r.wait(3) { r.state("trip") == "parked" }, "control: the grace still ends")
    #expect(r.wait(3) { !ProcessInspect.groupAlive(pid) })
  }

  /// A clock set back must not stop the heartbeat until it catches up: the hub would call the supervisor dead.
  @Test func aBackwardJumpKeepsTheHeartbeat() throws {
    let r = try WorkerRig(scenario: scenario)
    defer { r.teardown() }
    let c = Clocks()
    r.manager(now: { c.now }, awake: { c.awake })
    r.mgr.startTicking()
    #expect(r.wait(3) { r.fileOnDisk != nil })
    c.jumpWall(-3600)
    usleep(700_000)
    let first = r.fileOnDisk?.supervisor.heartbeat_at
    #expect(r.wait(3) { r.fileOnDisk?.supervisor.heartbeat_at != first }, "no heartbeat after the clock went back")
  }

  /// And a worker through the same jump keeps running: an activity time in the future reads as busy, not as a crash.
  @Test func aBackwardJumpLeavesAWorkerAlone() throws {
    let r = try WorkerRig(scenario: scenario)
    defer { r.teardown() }
    let c = Clocks()
    r.manager(idle: 1, now: { c.now }, awake: { c.awake })
    r.mgr.startTicking()
    try r.wake("trip")
    #expect(r.wait(8) { r.state("trip") == "busy" || r.state("trip") == "live" })
    let pid = try #require(r.entry("trip")?.pane_pid)
    c.jumpWall(-3600)
    usleep(1_500_000)
    #expect(ProcessInspect.groupAlive(pid))
    #expect(r.up("trip"), "\(String(describing: r.state("trip")))")
  }
}

/// R11: a hung turn that keeps printing would otherwise hold `stopping` for ever. A tap gives up on it after `stopLimit`, on
/// the awake clock, SIGTERM then SIGKILL, then the queued action. The governor never does.
@Suite("Option C stop limit", .serialized, .enabled(if: Rig.hasTmux))
struct WorkerStopLimit {
  private func hungTurn(_ r: WorkerRig, _ c: Clocks, parkGrace: Double = 2, tmux: String? = nil) throws -> String {
    r.env["FAKE_RV_QUIET"] = r.root + "/quiet"
    r.manager(tmux: tmux, parkGrace: parkGrace, busyWindow: 2.5, now: { c.now }, awake: { c.awake })
    r.mgr.startTicking()
    try r.wake("trip")
    #expect(r.wait(8) { r.state("trip") == "busy" })
    return try #require(r.entry("trip")?.session_id)
  }

  private func noisy() throws -> WorkerRig {
    let r = try WorkerRig(scenario: scenario, extraEnv: ["FAKE_RV_NOISE": "trip"])
    r.env["FAKE_RV_SIGLOG"] = r.root + "/signals"
    return r
  }

  private func signals(_ r: WorkerRig) -> [String] { r.lines(r.root + "/signals") }

  @Test(arguments: ["park", "restart", "fresh"])
  func anOwnerTapEndsAHungTurnAtTheLimit(action: String) throws {
    let r = try noisy()
    defer { r.teardown() }
    let c = Clocks()
    let sid = try hungTurn(r, c)
    try r.wakeFile("trip", action: action, reason: "control")
    #expect(tapTaken(r, "trip"), "the tap was never taken")
    c.jumpAwake(890)
    r.mgr.tickOnce()  // a tick that sees 890 s
    #expect(r.state("trip") == "stopping", "ended before the limit")  // the real check: a SIGTERM would have moved it to parking
    #expect(signals(r).isEmpty, "signalled before the limit")  // the fake logs asynchronously, so this one alone could miss it
    c.jumpAwake(20)
    #expect(r.wait(10) { r.mgr.tickOnce(); return !signals(r).isEmpty }, "no SIGTERM at the limit")
    switch action {
    case "park":
      #expect(r.wait(5) { r.state("trip") == "parked" })
      #expect(r.entry("trip")?.session_id == sid, "the conversation is kept")
      #expect(r.starts.count == 1)
    case "restart":
      #expect(r.wait(8) { r.starts.count == 2 })
      #expect(r.starts.last?.contains("--resume \(sid)") == true)
    default:
      #expect(r.wait(8) { r.starts.count == 2 })
      #expect(r.entry("trip")?.previous_ids == [sid])
    }
  }

  @Test func aTurnThatIgnoresSIGTERMGetsSIGKILLThenTheQueuedAction() throws {
    let r = try WorkerRig(scenario: scenario, extraEnv: ["FAKE_RV_NOISE": "trip", "FAKE_RV_IGNORE_TERM": "1"])
    defer { r.teardown() }
    let c = Clocks()
    _ = try hungTurn(r, c, parkGrace: 0.5)
    let pid = try #require(r.entry("trip")?.pane_pid)
    try r.wakeFile("trip", action: "restart", reason: "control")
    #expect(r.wait(3) { r.state("trip") == "stopping" })
    c.jumpAwake(901)
    #expect(r.wait(3) { r.state("trip") == "parking" || r.starts.count == 2 })
    #expect(r.wait(8) { r.starts.count == 2 }, "\(String(describing: r.state("trip")))")
    #expect(!ProcessInspect.groupAlive(pid))
  }

  @Test func theGovernorNeverEndsATurn() throws {
    let r = try noisy()
    defer { r.teardown() }
    let c = Clocks()
    _ = try hungTurn(r, c)
    try r.wakeFile("trip", action: "park", reason: "governor")
    #expect(r.wait(3) { r.state("trip") == "stopping" })
    c.jumpAwake(100_000)
    usleep(800_000)
    #expect(signals(r).isEmpty, "the governor stopped a turn")
    #expect(r.state("trip") == "stopping")
  }

  /// A park wake with a reason we don't know isn't a tap: it waits, like the governor's.
  @Test func aParkWithAnUnknownReasonNeverEndsATurn() throws {
    let r = try noisy()
    defer { r.teardown() }
    let c = Clocks()
    _ = try hungTurn(r, c)
    try r.wakeFile("trip", action: "park", reason: "somebody-new")
    #expect(r.wait(3) { r.state("trip") == "stopping" })
    c.jumpAwake(100_000)
    usleep(800_000)
    #expect(signals(r).isEmpty)
  }

  /// Waits until the manager has taken the wake file. It renames the file and acts on it inside one tick, so the file can be gone
  /// while that tick is still running. The check comes first and `tickOnce` after it: it queues behind a tick already running, so
  /// when the file was gone the tap has armed its limit by the time this returns and the clock can move.
  private func tapTaken(_ r: WorkerRig, _ id: String) -> Bool {
    r.wait(10) {
      let gone = !FileManager.default.fileExists(atPath: r.talosHome + "/workers/" + id + "/wake")
      r.mgr.tickOnce()
      return gone
    }
  }

  @Test(arguments: ["park", "restart", "fresh"])
  func aTapRescuesAGovernorStop(action: String) throws {
    let r = try noisy()
    defer { r.teardown() }
    let c = Clocks()
    _ = try hungTurn(r, c)
    try r.wakeFile("trip", action: "park", reason: "governor")
    #expect(r.wait(3) { r.state("trip") == "stopping" })
    c.jumpAwake(100_000)
    r.mgr.tickOnce()  // a tick that sees the jump while only the governor has stopped it
    try r.wakeFile("trip", action: action, reason: "control")
    #expect(tapTaken(r, "trip"), "the tap was never taken")
    r.mgr.tickOnce()  // and one that sees the clock after the tap
    #expect(r.state("trip") == "stopping", "the limit runs from the tap, not from the governor's stop")
    #expect(signals(r).isEmpty, "the limit runs from the tap, not from the governor's stop")
    c.jumpAwake(901)
    #expect(r.wait(10) { r.mgr.tickOnce(); return !signals(r).isEmpty }, "no SIGTERM at the limit")
  }

  @Test func switchingOffCountsAsATapAndRescuesAGovernorStop() throws {
    let r = try noisy()
    defer { r.teardown() }
    let c = Clocks()
    _ = try hungTurn(r, c)
    try r.wakeFile("trip", action: "park", reason: "governor")
    #expect(r.wait(3) { r.state("trip") == "stopping" })
    try r.writeConfig(maxLive: 3, threads: [])
    r.mgr.tickOnce()  // reads the new config in this tick, which arms the limit
    #expect(r.state("trip") == "stopping")
    c.jumpAwake(890)
    r.mgr.tickOnce()  // a tick that sees 890 s: the limit runs from the switch-off
    #expect(r.state("trip") == "stopping", "ended before the limit")
    c.jumpAwake(11)
    #expect(r.wait(10) { r.mgr.tickOnce(); return !signals(r).isEmpty }, "switch-off never armed the limit")
  }

  @Test func switchingOffAHungTurnEndsItAtTheLimit() throws {
    let r = try noisy()
    defer { r.teardown() }
    let c = Clocks()
    _ = try hungTurn(r, c)
    try r.writeConfig(maxLive: 3, threads: [])
    #expect(r.wait(3) { r.state("trip") == "stopping" })
    c.jumpAwake(901)
    #expect(r.wait(3) { !signals(r).isEmpty })
    #expect(r.wait(5) { r.state("trip") == "parked" })
  }

  /// A second tap doesn't buy the turn another 15 minutes.
  @Test func theLimitRunsFromTheFirstTap() throws {
    let r = try noisy()
    defer { r.teardown() }
    let c = Clocks()
    _ = try hungTurn(r, c)
    try r.wakeFile("trip", action: "park", reason: "control")
    #expect(tapTaken(r, "trip"), "the first tap was never taken")
    c.jumpAwake(600)
    r.mgr.tickOnce()  // a tick that sees 600 s
    #expect(r.state("trip") == "stopping", "ended before the limit")
    try r.wakeFile("trip", action: "restart", reason: "control")
    #expect(tapTaken(r, "trip"), "the second tap was never taken")
    #expect(r.state("trip") == "stopping", "ended before the limit")
    #expect(signals(r).isEmpty, "signalled before the limit")
    c.jumpAwake(301)
    #expect(r.wait(10) { r.mgr.tickOnce(); return !signals(r).isEmpty }, "the limit ran from the second tap")
  }

  /// An unknown stays a no-op: no screen, no signal, at or past the limit.
  @Test func aFailedReadNeverEndsATurn() throws {
    let r = try noisy()
    defer { r.teardown() }
    let shim = try r.faultShim()
    let c = Clocks()
    _ = try hungTurn(r, c, tmux: shim)
    try r.wakeFile("trip", action: "park", reason: "control")
    #expect(r.wait(3) { r.state("trip") == "stopping" })
    // `tickOnce()` is a barrier: it queues behind the tick that may be in flight and then runs one more, so every tick
    // that follows a fault change started after it. Without it, a tick whose `display-message` ran before the new fault
    // and whose `capture-pane` ran after the old one was lifted read BOTH, saw the jumped clock, and SIGTERMed (correctly).
    try r.fault("capture-pane", "hold")
    r.mgr.tickOnce()
    c.jumpAwake(1000)
    for _ in 0..<3 { r.mgr.tickOnce() }
    #expect(r.state("trip") == "stopping", "still stopping, so the empty signal log means unread, not unsent")
    #expect(signals(r).isEmpty, "signalled on an unread screen")
    try r.fault("display-message", "hold")  // the screen stays unreadable until the pane is unreadable too
    r.mgr.tickOnce()
    r.clearFault("capture-pane")
    for _ in 0..<3 { r.mgr.tickOnce() }
    #expect(r.state("trip") == "stopping", "still stopping, so the empty signal log means unread, not unsent")
    #expect(signals(r).isEmpty, "signalled on an unread pane")
    r.clearFault("display-message")
    #expect(r.wait(3) { !signals(r).isEmpty }, "control: it ends once it can be read")
  }

  /// Sleep and clock changes aren't time spent waiting.
  @Test func aWallClockJumpNeverEndsATurn() throws {
    let r = try noisy()
    defer { r.teardown() }
    let c = Clocks()
    _ = try hungTurn(r, c)
    try r.wakeFile("trip", action: "park", reason: "control")
    #expect(r.wait(3) { r.state("trip") == "stopping" })
    c.jumpWall(100_000)
    usleep(800_000)
    #expect(signals(r).isEmpty)
  }

  /// After a relaunch a `stopping` worker might be the governor's, so nothing arms until the next tap.
  @Test func aRelaunchArmsNothingUntilTheNextTap() throws {
    let r = try noisy()
    defer { r.teardown() }
    let c = Clocks()
    _ = try hungTurn(r, c)
    try r.wakeFile("trip", action: "park", reason: "control")
    #expect(r.wait(3) { r.state("trip") == "stopping" })
    #expect(r.wait(3) { r.fileOnDisk?.threads["trip"]?.state == "stopping" })
    r.mgr.detach()
    r.manager(busyWindow: 2.5, now: { c.now }, awake: { c.awake })
    r.mgr.startTicking()
    #expect(r.wait(3) { r.state("trip") == "stopping" })
    c.jumpAwake(100_000)
    usleep(800_000)
    #expect(signals(r).isEmpty, "armed on adopt")
    try r.wakeFile("trip", action: "park", reason: "control")
    // The tap arms the limit from the awake clock AT THE MOMENT THE TICK READS IT, so the clock may only jump once it has.
    // A fixed sleep guessed that a loaded Mac reads it within 400 ms; when the tick came later, the limit was armed after
    // the jump, 900 s further on, and nothing was ever signalled. The wake file being taken is the real signal, and
    // `tickOnce()` queues behind the tick that took it, so the arming has run when it returns.
    #expect(r.wait(10) { !FileManager.default.fileExists(atPath: r.talosHome + "/workers/trip/wake") }, "the tap was taken")
    r.mgr.tickOnce()
    c.jumpAwake(901)
    #expect(r.wait(3) { !signals(r).isEmpty }, "control: a tap after the relaunch arms it")
  }

  /// A limit doesn't outlive the stop it was for: the next run's governor stop must not inherit it.
  @Test func aLimitDoesNotCarryIntoTheNextRun() throws {
    let r = try noisy()
    defer { r.teardown() }
    let c = Clocks()
    _ = try hungTurn(r, c)
    let quiet = r.root + "/quiet"
    try r.wakeFile("trip", action: "restart", reason: "control")
    #expect(r.wait(3) { r.state("trip") == "stopping" })
    FileManager.default.createFile(atPath: quiet, contents: nil)
    unlink(r.root + "/signals")
    #expect(r.wait(10) { r.starts.count == 2 }, "it parked on its own and restarted")
    unlink(quiet)  // the second run prints too
    #expect(r.wait(8) { r.state("trip") == "busy" })
    unlink(r.root + "/signals")
    try r.wakeFile("trip", action: "park", reason: "governor")
    #expect(r.wait(3) { r.state("trip") == "stopping" })
    c.jumpAwake(100_000)
    usleep(800_000)
    #expect(signals(r).isEmpty, "the governor's stop inherited an old limit")
  }

  /// The turn ended by itself: nothing to rescue, and the reason on the park is still the owner's.
  @Test func aTurnThatEndsInTimeIsAnOrdinaryPark() throws {
    let r = try noisy()
    defer { r.teardown() }
    let c = Clocks()
    _ = try hungTurn(r, c)
    let seen = EventLog()
    r.mgr.onEvent = { seen.add($0) }
    try r.wakeFile("trip", action: "park", reason: "control")
    #expect(r.wait(3) { r.state("trip") == "stopping" })
    FileManager.default.createFile(atPath: r.root + "/quiet", contents: nil)
    #expect(r.wait(8) { r.state("trip") == "parked" })
    #expect(seen.all == [.parked(thread: "trip", reason: "control")])
  }
}

@Suite("Option C unknowns: two copies", .serialized, .enabled(if: Rig.hasTmux))
struct WorkerUnknownCopies {
  /// Quit on the running copy: it keeps the lock until the process ends, so a passive copy can't start what it just stopped.
  @Test func aPassiveCopyStartsNothingDuringQuit() throws {
    let r = try WorkerRig(scenario: scenario)
    defer { r.teardown() }
    r.manager()
    let a = r.mgr!
    a.startTicking()
    try r.wake("trip")
    #expect(r.wait(8) { r.up("trip") })
    let b = r.manager(install: false)
    defer { b.detach() }
    b.startTicking()
    usleep(300_000)
    a.stopAll()
    try r.wake("trip")
    usleep(700_000)
    #expect(!b.isActive)
    #expect(r.starts.count == 1, "\(r.starts.count) starts")
  }

  /// One copy, two callers: a tick racing Quit can't run after it.
  @Test func aTickAfterStopAllDoesNothing() throws {
    let r = try WorkerRig(scenario: scenario)
    defer { r.teardown() }
    r.manager()
    r.firstTick()
    r.mgr.stopAll()
    try r.wake("trip")
    r.mgr.tickOnce()
    #expect(r.starts.isEmpty)
    #expect(FileManager.default.fileExists(atPath: r.talosHome + "/workers/trip/wake"))
  }
}
