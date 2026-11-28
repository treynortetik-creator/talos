import Foundation
import Testing
import TalosDesktopCore
@testable import TalosSupervisor
import TalosTestSupport

/// Wave 0, 0.26 on the Mac: a thread session that dies in the middle of a turn is started again with the turn resumed, once, within 30
/// minutes. Real manager, real private tmux server (`talos-test-…`, never `-L talos`), a fake claude (`worker-turn.sh`) whose turn lasts
/// until the test says and that starts a tool of its own in a session of its own, as Claude Code does: the SIGKILL of the session's
/// group leaves it running, which is the very thing the reap is for. Every file here is in the rig's own mkdtemp folder.
@Suite("Cut turn: the Mac's worker manager", .serialized, .enabled(if: Rig.hasTmux))
struct CutTurnWorkerTests {
  /// A copy of /bin/sleep signed ad hoc, so its environment can be read like any developer tool's (see worker-turn.sh).
  static func unrestrictedSleep(in dir: String) throws -> String {
    let path = dir + "/xsleep"
    try FileManager.default.copyItem(atPath: "/bin/sleep", toPath: path)
    let r = ProcessRunner.run(["/usr/bin/codesign", "-f", "-s", "-", path], env: ["PATH": "/usr/bin:/bin"], timeout: 30)
    #expect(r.ok, "codesign: \(r.err)")
    return path
  }

  final class Rig2 {
    let r: WorkerRig
    var tools: String { r.root + "/tools" }
    var dumps: String { r.root + "/dump" }
    var audit: String { r.root + "/audit.log" }
    var cutPath: String { CutTurn.path(talosHome: r.talosHome, threadId: "trip") }

    init(plan: Bool = false, shape: String = "zsh") throws {
      r = try WorkerRig(scenario: "worker-turn.sh")
      try FileManager.default.createDirectory(atPath: tools, withIntermediateDirectories: true)
      try FileManager.default.createDirectory(atPath: dumps, withIntermediateDirectories: true)
      r.env["FAKE_TOOL_DIR"] = tools
      r.env["FAKE_STATE_DIR"] = r.root + "/state"
      r.env["FAKE_ENV_DUMP"] = dumps + "/env"
      r.env["FAKE_ARGV_DUMP"] = dumps + "/argv"
      if plan { r.env["FAKE_PLAN"] = "1" }
      r.env["FAKE_TOOL_SHAPE"] = shape
      r.env["FAKE_TOOL_BIN"] = try CutTurnWorkerTests.unrestrictedSleep(in: tools)
      r.makeManager()
      // tmux keeps a pane's last output to the second, so the rig's half-second busy window reads continuous output as busy only half the
      // time; 3 s holds a pane that prints every tenth of a second busy throughout (the real window is 15 s)
      r.mgr.tune {
        $0.auditLogPath = self.audit
        $0.busyWindow = 3
      }
    }

    func pid(_ name: String) -> Int32? {
      (try? String(contentsOfFile: tools + "/" + name, encoding: .utf8)).flatMap { Int32($0.trimmingCharacters(in: .whitespacesAndNewlines)) }
    }
    func alive(_ pid: Int32) -> Bool { kill(pid, 0) == 0 }
    /// Every live process of one process group, read from the process table (a zombie is gone).
    func members(of pgid: Int32) -> [Int32] {
      let r = ProcessRunner.run(["/bin/ps", "-axo", "pid=,pgid=,stat="], env: ["PATH": "/usr/bin:/bin"], timeout: 20)
      return r.out.split(separator: "\n").compactMap { line -> Int32? in
        let f = line.split(separator: " ").map(String.init)
        guard f.count >= 3, Int32(f[1]) == pgid, !f[2].hasPrefix("Z") else { return nil }
        return Int32(f[0])
      }
    }
    /// The owner's tap on Park now: a wake whose reason is `control` (a wake without one is the governor's, which has no stop limit).
    func ownerPark() throws {
      let d = r.talosHome + "/workers/trip"
      try "{\"v\":1,\"thread_id\":\"trip\",\"message_ids\":[],\"at\":\"\(ISOTime.string(Date().timeIntervalSince1970))\",\"action\":\"park\",\"reason\":\"control\"}"
        .write(toFile: d + "/wake", atomically: true, encoding: .utf8)
    }
    func endTurns() { FileManager.default.createFile(atPath: tools + "/turn-done", contents: Data()) }
    var dumpText: (Int) -> String { { n in (try? String(contentsOfFile: self.dumps + "/env.\(n)", encoding: .utf8)) ?? "" } }
    func argv(_ n: Int) -> [String] {
      ((try? String(contentsOfFile: dumps + "/argv.\(n)", encoding: .utf8)) ?? "").split(separator: "\n").map(String.init)
    }
    func file() -> CutTurnFile { CutTurn.load(cutPath).file }
    var auditText: String { (try? String(contentsOfFile: audit, encoding: .utf8)) ?? "" }
    /// A fixed clock for the file: the record's cut time moved back by `minutes`, as if the owner came back later.
    func ageCut(minutes: Double) throws {
      var f = file()
      var cut = try #require(f.pending)
      let at = try #require(ISOTime.parse(cut.cut_at))
      cut.cut_at = ISOTime.string(at - minutes * 60)
      f.pending = cut
      try CutTurn.save(f, to: cutPath)
    }
    func teardown() {
      // the tools the fake started live in sessions of their own, so tmux's kill-server does not reach them
      if let names = try? FileManager.default.contentsOfDirectory(atPath: tools) {
        for n in names where n.hasSuffix(".pid") { if let p = pid(n), p > 1 { kill(-p, SIGKILL); kill(p, SIGKILL) } }
      }
      r.teardown()
    }

    /// Starts the thread, waits for the pointer to be typed and the tool to exist: a turn in progress, on file.
    func startTurn(_ n: Int) throws -> Int32 {
      try r.wake("trip")
      #expect(r.wait(15) { r.liveCount("trip") == n && r.typedLines.count >= 1 }, "\(r.why("trip"))")
      #expect(r.wait(10) { self.pid("tool.\(n).pid") != nil && r.rawEntry()?["turn_started_at"] is String }, "\(r.why("trip"))")
      return try #require(r.entry("trip")?.pane_pid)
    }
  }

  @Test func aCrashMidTurnIsRecordedThenTheNextStartResumesItAndReapsTheLeftoverTool() throws {
    let t = try Rig2()
    defer { t.teardown() }
    t.r.mgr.startTicking()
    let pane = try t.startTurn(1)
    let early = try #require(t.pid("early.1.pid")), tool = try #require(t.pid("tool.1.pid"))
    let nonce = try String(contentsOfFile: t.r.talosHome + "/workers/trip/nonce", encoding: .utf8)
    kill(-pane, SIGKILL)  // a crash: nobody asked, the turn was running
    #expect(t.r.wait(15) { t.r.state("trip") == "parked" && t.r.rawEntry()?["stopped_why"] as? String == "crash" }, "\(t.r.why("trip"))")
    let cut = try #require(t.file().pending, "the cut turn is on disk")
    #expect(cut.why == "crash" && cut.nonce == nonce && cut.from_rerun == false)
    #expect(cut.session_id == t.r.entry("trip")?.session_id)
    // the SIGKILL left both processes of the dead launch running: the real hazard
    #expect(t.members(of: tool).count >= 2 && t.alive(early), "setup: the group kill did not reach the tool's own group (a shell and its child)")
    t.endTurns()
    try t.r.wake("trip")
    #expect(t.r.wait(20) { t.r.liveCount("trip") == 2 }, "\(t.r.why("trip"))")
    // the second start is a resume that asks Claude Code to resume the turn: exactly the two names, with the two values
    #expect(t.r.wait(5) { !t.argv(2).isEmpty })
    #expect(t.argv(2).contains("[--resume]"), "\(t.argv(2))")
    let env2 = t.dumpText(2)
    #expect(env2.contains("CLAUDE_CODE_RESUME_INTERRUPTED_TURN=1\n") && env2.contains("CLAUDE_CODE_RESUME_REASON=user_resume\n"))
    #expect(!t.dumpText(1).contains("CLAUDE_CODE_RESUME"), "the first start was an ordinary one")
    #expect(FileManager.default.fileExists(atPath: t.tools + "/rerun.2"), "the session itself saw the names")
    // the tool the cut turn started is gone (reaped by nonce), the one an earlier turn left is not
    #expect(t.r.wait(5) { t.members(of: tool).isEmpty }, "every process of the cut turn's tool group is gone, the shell and its children: \(t.auditText)")
    #expect(t.alive(early), "a process started before the turn is not the turn's work")
    // used up: no record to use again, the launch is remembered as a re-run
    #expect(t.file().pending == nil, "used up")
    #expect(t.auditText.contains("cut_turn_rerun") && !t.auditText.contains("reaped=0"), "\(t.auditText)")
  }

  @Test func aRerunThatIsCutAgainIsNotRunAgain() throws {
    let t = try Rig2()
    defer { t.teardown() }
    t.r.mgr.startTicking()
    let first = try t.startTurn(1)
    kill(-first, SIGKILL)
    #expect(t.r.wait(15) { t.r.state("trip") == "parked" })
    try t.r.wake("trip", action: "resume", ids: [])
    #expect(t.r.wait(20) { t.r.liveCount("trip") == 2 }, "\(t.r.why("trip"))")
    #expect(t.r.wait(5) { FileManager.default.fileExists(atPath: t.tools + "/rerun.2") })
    // the resumed turn is a turn in progress, on file, until it ends
    #expect(t.r.wait(5) { t.r.rawEntry()?["turn_started_at"] is String }, "\(String(describing: t.r.rawEntry()))")
    let second = try #require(t.r.entry("trip")?.pane_pid)
    kill(-second, SIGKILL)  // the re-run is cut too
    #expect(t.r.wait(15) { t.r.state("trip") == "parked" })
    #expect(t.file().pending?.from_rerun == true, "\(t.file())")
    try t.r.wake("trip", action: "resume", ids: [])
    #expect(t.r.wait(20) { t.r.liveCount("trip") == 3 }, "\(t.r.why("trip"))")
    #expect(t.r.wait(5) { !t.argv(3).isEmpty })
    #expect(t.argv(3).contains("[--resume]"), "still a resume of the conversation")
    #expect(!t.dumpText(3).contains("CLAUDE_CODE_RESUME"), "a re-run that was cut again is not run again")
    #expect(!FileManager.default.fileExists(atPath: t.tools + "/rerun.3"))
    #expect(t.file() == CutTurnFile(), "the refusal is final: nothing left to ask at the next start")
    #expect(t.auditText.contains("cut_turn_skipped") && t.auditText.contains("not run again"), "\(t.auditText)")
  }

  @Test func aCrashWithNoTurnInProgressRecordsNothing() throws {
    let t = try Rig2()
    defer { t.teardown() }
    t.r.mgr.startTicking()
    let pane = try t.startTurn(1)
    t.endTurns()
    #expect(t.r.wait(15) { t.r.rawEntry()?["turn_started_at"] == nil && t.r.rawEntry()?["last_turn_at"] is String }, "\(String(describing: t.r.rawEntry()))")
    kill(-pane, SIGKILL)
    #expect(t.r.wait(15) { t.r.state("trip") == "parked" && t.r.rawEntry()?["stopped_why"] as? String == "crash" })
    #expect(t.file() == CutTurnFile())
    try t.r.wake("trip", action: "resume", ids: [])
    #expect(t.r.wait(20) { t.r.liveCount("trip") == 2 }, "\(t.r.why("trip"))")
    #expect(t.r.wait(5) { !t.argv(2).isEmpty })
    #expect(!t.dumpText(2).contains("CLAUDE_CODE_RESUME"))
  }

  @Test func anOwnersStopMidTurnRecordsNothing() throws {
    let t = try Rig2()
    defer { t.teardown() }
    t.r.mgr.tune { $0.stopLimit = 1.5 }
    t.r.mgr.startTicking()
    _ = try t.startTurn(1)
    try t.ownerPark()  // the owner's Park now; the turn does not end, so the stop limit cuts it
    #expect(t.r.wait(20) { t.r.state("trip") == "parked" }, "\(t.r.why("trip"))")
    #expect(t.r.rawEntry()?["stopped_why"] as? String == "owner")
    #expect(t.file() == CutTurnFile(), "an owner's stop is not a cut anyone wants undone")
    try t.r.wake("trip", action: "resume", ids: [])
    #expect(t.r.wait(20) { t.r.liveCount("trip") == 2 }, "\(t.r.why("trip"))")
    #expect(t.r.wait(5) { !t.argv(2).isEmpty })
    #expect(!t.dumpText(2).contains("CLAUDE_CODE_RESUME"))
  }

  @Test func aRestartThatTheStopLimitForcedMidTurnIsRecordedAndResumed() throws {
    let t = try Rig2()
    defer { t.teardown() }
    t.r.mgr.tune { $0.stopLimit = 1.5 }
    t.r.mgr.startTicking()
    _ = try t.startTurn(1)
    let tool = try #require(t.pid("tool.1.pid"))
    // the owner taps Restart; the turn never ends, so the stop limit gives up on it and the restart goes ahead
    try t.r.wake("trip", action: "restart", ids: [])
    #expect(t.r.wait(10) { t.r.state("trip") == "stopping" || t.r.state("trip") == "parking" }, "\(t.r.why("trip"))")
    // the limit runs out: the turn is cut by the restart, recorded before the new start
    #expect(t.r.wait(30) { t.r.liveCount("trip") == 2 }, "\(t.r.why("trip"))")
    #expect(t.r.wait(5) { !t.argv(2).isEmpty })
    #expect(t.argv(2).contains("[--resume]"))
    #expect(t.dumpText(2).contains("CLAUDE_CODE_RESUME_INTERRUPTED_TURN=1"), "a stop_limit restart mid-turn resumes the turn")
    #expect(t.auditText.contains("cut_turn_recorded") && t.auditText.contains("why=stop_limit_restart"), "\(t.auditText)")
    #expect(t.r.wait(5) { t.members(of: tool).isEmpty }, "the tool the cut turn started does not outlive the restart")
  }

  @Test func aRecordOlderThanThirtyMinutesIsNotUsedAndSaysSo() throws {
    let t = try Rig2()
    defer { t.teardown() }
    t.r.mgr.startTicking()
    let pane = try t.startTurn(1)
    let tool = try #require(t.pid("tool.1.pid"))
    kill(-pane, SIGKILL)
    #expect(t.r.wait(15) { t.r.state("trip") == "parked" && t.file().pending != nil })
    try t.ageCut(minutes: 31)
    try t.r.wake("trip", action: "resume", ids: [])
    #expect(t.r.wait(20) { t.r.liveCount("trip") == 2 }, "\(t.r.why("trip"))")
    #expect(t.r.wait(5) { !t.argv(2).isEmpty })
    #expect(!t.dumpText(2).contains("CLAUDE_CODE_RESUME"))
    #expect(t.file() == CutTurnFile(), "a stale record does not wait for the next start")
    #expect(t.auditText.contains("cut_turn_skipped") && t.auditText.contains("30 minutes"), "\(t.auditText)")
    #expect(!t.members(of: tool).isEmpty, "nothing is reaped for a turn that is not resumed (the owner's own tools are not ours to kill)")
  }

  /// The shape that the nonce cannot find: every process of the tool's group is an Apple binary, whose environment macOS never shows.
  @Test func aToolGroupOfOnlyAppleBinariesIsFoundByTheGroupRecord() throws {
    let t = try Rig2(shape: "apple")
    defer { t.teardown() }
    t.r.mgr.startTicking()
    let pane = try t.startTurn(1)
    let tool = try #require(t.pid("tool.1.pid")), early = try #require(t.pid("early.1.pid"))
    // setup: the nonce really is invisible on this group (the whole reason for the record)
    #expect(t.r.wait(10) { (CutTurnProcs.table(env: true) ?? []).filter { $0.pgid == tool }.count >= 2 }, "setup: the shell has started its child")
    let seen = (CutTurnProcs.table(env: true) ?? []).filter { $0.pgid == tool }
    #expect(seen.allSatisfy { $0.env == .unreadable }, "setup: Apple binaries show no environment: \(seen)")
    #expect(t.r.wait(5) { CutTurnGroups.load(CutTurnGroups.path(talosHome: t.r.talosHome, threadId: "trip"))?.groups.contains { $0.pgid == tool } == true }, "the group is recorded while the session lives")
    kill(-pane, SIGKILL)
    #expect(t.r.wait(15) { t.r.state("trip") == "parked" && t.file().pending != nil })
    #expect(t.members(of: tool).count >= 2, "setup: the kill of the session's group left the tool's group running")
    t.endTurns()
    let snapBefore = CutTurnGroups.load(CutTurnGroups.path(talosHome: t.r.talosHome, threadId: "trip"))
    let rowsBefore = (CutTurnProcs.table(env: true) ?? []).filter { $0.pgid == tool }
    try t.r.wake("trip")
    #expect(t.r.wait(20) { t.r.liveCount("trip") == 2 }, "\(t.r.why("trip"))")
    #expect(t.r.wait(8) { t.members(of: tool).isEmpty }, "every process of the all-Apple tool group is gone: \(t.auditText) snap \(String(describing: snapBefore)) rows \(rowsBefore)")
    #expect(t.alive(early), "the earlier server is not touched")
    #expect(t.dumpText(2).contains("CLAUDE_CODE_RESUME_INTERRUPTED_TURN=1"))
  }

  /// R1-4: the app was not running when the session died (a relaunch finds it gone): the cut is recorded then, and the reap follows.
  @Test func aSessionThatDiedWhileTheAppWasAwayStillGetsItsCutAndItsReap() throws {
    let t = try Rig2()
    defer { t.teardown() }
    t.r.mgr.startTicking()
    let pane = try t.startTurn(1)
    let tool = try #require(t.pid("tool.1.pid"))
    #expect(t.r.wait(5) { CutTurnGroups.load(CutTurnGroups.path(talosHome: t.r.talosHome, threadId: "trip"))?.groups.contains { $0.pgid == tool } == true })
    t.r.mgr.detach()  // the app goes away
    kill(-pane, SIGKILL)
    #expect(t.r.wait(5) { t.alive(pane) == false })
    t.r.makeManager()
    t.r.mgr.tune {
      $0.auditLogPath = t.audit
      $0.busyWindow = 3
    }
    t.r.mgr.startTicking()  // the new copy finds the entry busy and the pane gone
    #expect(t.r.wait(15) { t.r.state("trip") == "parked" && t.file().pending != nil }, "\(t.r.why("trip")) \(t.auditText)")
    #expect(t.file().pending?.why == "crash")
    t.endTurns()
    try t.r.wake("trip", action: "resume", ids: [])
    #expect(t.r.wait(20) { t.r.liveCount("trip") >= 1 && FileManager.default.fileExists(atPath: t.tools + "/rerun.2") }, "\(t.r.why("trip")) \(t.auditText)")
    #expect(t.r.wait(8) { t.members(of: tool).isEmpty }, "the tool of the turn cut while the app was away is gone too")
  }

  /// R1-6: a re-run that the last copy of the app started is still guarded after a relaunch, so when its turn ends the guard ends.
  @Test func aRerunAdoptedAfterARelaunchStillEndsItsGuardWhenItsTurnEnds() throws {
    let t = try Rig2()
    defer { t.teardown() }
    t.r.mgr.startTicking()
    let first = try t.startTurn(1)
    kill(-first, SIGKILL)
    #expect(t.r.wait(15) { t.r.state("trip") == "parked" && t.file().pending != nil })
    try t.r.wake("trip", action: "resume", ids: [])
    #expect(t.r.wait(20) { FileManager.default.fileExists(atPath: t.tools + "/rerun.2") }, "\(t.auditText)")
    #expect(t.file().rerun != nil)
    t.r.mgr.detach()
    t.r.makeManager()
    t.r.mgr.tune {
      $0.auditLogPath = t.audit
      $0.busyWindow = 3
    }
    t.r.mgr.startTicking()
    #expect(t.r.wait(10) { t.r.state("trip") == "busy" || t.r.state("trip") == "live" })
    #expect(t.r.wait(5) { t.r.mgr.queue.sync { t.r.mgr.rt["trip"]?.cut.rerunActive } == true }, "the adopted launch is the re-run")
    t.endTurns()  // the resumed turn ends
    #expect(t.r.wait(20) { t.file().rerun == nil }, "the guard ends with the re-run's turn: \(t.file())")
  }

  /// R1-3: where the running turn began is kept from the quiet-to-busy edge and held across an approval prompt (a pane that waits on the
  /// owner is quiet for as long as the owner takes), so the tools started before a prompt are still this turn's.
  @Test func theTurnsStartIsHeldAcrossAnApprovalPromptAndEndsWithTheTurn() throws {
    final class Clock: @unchecked Sendable { var awake = 1000.0 }
    let clock = Clock()
    let r = try WorkerRig()
    defer { r.teardown() }
    let m = r.makeManager(awake: { clock.awake })
    let e = try JSONDecoder().decode(WorkersFile.Entry.self, from: Data(#"{"state":"live","tmux":"t-trip","cwd":"/home/alex/x","restarts":[]}"#.utf8))
    m.queue.sync {
      m.rt["trip"] = WorkerManager.Runtime(entry: e)
      m.noteTurnBound("trip", busy: false, now: 100)
      #expect(m.rt["trip"]?.cut.bound == nil)
      m.noteTurnBound("trip", busy: true, now: 105)
      #expect(m.rt["trip"]?.cut.bound == 100, "the last quiet look before the pane went busy")
      m.noteTurnBound("trip", busy: true, now: 160)
      #expect(m.rt["trip"]?.cut.bound == 100, "a turn that runs on keeps its start")
      // an approval prompt: quiet for a long time, waiting on the owner
      m.rt["trip"]?.needsYouPrompt = "Bash command"
      m.noteTurnBound("trip", busy: false, now: 170)
      clock.awake += 600
      m.noteTurnBound("trip", busy: false, now: 770)
      #expect(m.rt["trip"]?.cut.bound == 100, "ten minutes at a prompt do not move the start past the tools started before it")
      // answered, busy again, then really over
      m.rt["trip"]?.needsYouPrompt = nil
      m.noteTurnBound("trip", busy: true, now: 780)
      #expect(m.rt["trip"]?.cut.bound == 100)
      m.noteTurnBound("trip", busy: false, now: 790)
      clock.awake += 60
      m.noteTurnBound("trip", busy: false, now: 850)
      #expect(m.rt["trip"]?.cut.bound == nil, "quiet and waiting on nobody: the turn is over")
      // an Esc ends it at once
      m.noteTurnBound("trip", busy: true, now: 900)
      #expect(m.rt["trip"]?.cut.bound == 850)
      m.rt["trip"]?.cut.escaped = true
      m.noteTurnBound("trip", busy: false, now: 901)
      #expect(m.rt["trip"]?.cut.bound == nil)
    }
  }

  @Test func aCrashInPlanModeRecordsNothing() throws {
    let t = try Rig2(plan: true)
    defer { t.teardown() }
    t.r.mgr.startTicking()
    let pane = try t.startTurn(1)
    kill(-pane, SIGKILL)
    #expect(t.r.wait(15) { t.r.state("trip") == "parked" && t.r.rawEntry()?["stopped_why"] as? String == "crash" })
    #expect(t.file() == CutTurnFile(), "plan mode: nothing was being changed, a re-run would only repeat a plan")
  }

  @Test func aRecordThatCannotBeReadIsNoRerunAndTheOwnerCanSeeWhy() throws {
    let t = try Rig2()
    defer { t.teardown() }
    t.r.mgr.startTicking()
    let pane = try t.startTurn(1)
    kill(-pane, SIGKILL)
    #expect(t.r.wait(15) { t.r.state("trip") == "parked" && t.file().pending != nil })
    try Data("{broken".utf8).write(to: URL(fileURLWithPath: t.cutPath))
    t.endTurns()
    try t.r.wake("trip", action: "resume", ids: [])
    #expect(t.r.wait(20) { t.r.liveCount("trip") == 2 }, "\(t.r.why("trip"))")
    #expect(t.r.wait(5) { !t.argv(2).isEmpty })
    #expect(!t.dumpText(2).contains("CLAUDE_CODE_RESUME"))
    #expect(t.auditText.contains("cut_turn_unreadable"), "an unreadable record is said, never read as nothing happened: \(t.auditText)")
  }
}

/// The reap on real processes (no tmux): TERM to everything at once, found by the record or by the nonce, stopped only while it is still
/// the process that was recorded.
@Suite("Cut turn: the reaper on real processes", .serialized)
struct CutTurnReaperTests {
  static let nonce = String(repeating: "5a", count: 16)
  static let other = String(repeating: "a5", count: 16)

  func spawn(_ bin: String, env: [String: String]) throws -> Process {
    let p = Process()
    p.executableURL = URL(fileURLWithPath: bin)
    p.arguments = ["60"]
    p.environment = ["PATH": "/usr/bin:/bin"].merging(env) { _, b in b }
    p.standardOutput = FileHandle.nullDevice
    p.standardError = FileHandle.nullDevice
    try p.run()
    return p
  }

  @Test func stopsOnlyTheLaunchsProcessesThatStartedAfterTheTurnBegan() throws {
    let dir = try CutTurnSandbox.make()
    var procs: [Process] = []
    defer {
      for p in procs where p.isRunning { kill(p.processIdentifier, SIGKILL) }
      CutTurnSandbox.remove(dir)
    }
    let bin = try CutTurnWorkerTests.unrestrictedSleep(in: dir)
    let early = try spawn(bin, env: ["TALOS_APP_WORKER_NONCE": Self.nonce])  // a server an earlier turn left on purpose
    procs.append(early)
    usleep(UInt32(2_300_000 * waitScale))  // past the clock's one second of grain
    let bound = Date().timeIntervalSince1970
    let tool1 = try spawn(bin, env: ["TALOS_APP_WORKER_NONCE": Self.nonce])
    let tool2 = try spawn(bin, env: ["TALOS_APP_WORKER_NONCE": Self.nonce])
    let otherLaunch = try spawn(bin, env: ["TALOS_APP_WORKER_NONCE": Self.other])
    let noNonce = try spawn(bin, env: [:])
    procs += [tool1, tool2, otherLaunch, noNonce]
    // the table is read from the real kernel: the nonce has to be readable on these for the test to mean anything
    let seen = CutTurnProcs.table(env: true) ?? []
    #expect(seen.contains { $0.pid == tool1.processIdentifier && $0.env == .readable(Self.nonce) }, "setup: the environment of a plain process is readable")
    let r = CutTurnReaper.reap(nonce: Self.nonce, startedAfter: bound, snapshot: nil)
    #expect(Set(r.killed) == [tool1.processIdentifier, tool2.processIdentifier], "\(r)")
    #expect(r.notKilled.isEmpty && !r.listingFailed)
    for p in [tool1, tool2] { p.waitUntilExit() }
    #expect(early.isRunning && otherLaunch.isRunning && noNonce.isRunning, "nothing else is touched")
  }

  @Test func aTableThatCannotBeReadStopsNothingAndSaysSo() {
    let r = CutTurnReaper.reap(nonce: Self.nonce, startedAfter: 0, snapshot: nil, table: { nil })
    #expect(r.listingFailed && r.killed.isEmpty)
  }

  @Test func aRecordedLeaderWhosePidIsNowAnotherProcessIsNotSignalled() throws {
    let dir = try CutTurnSandbox.make()
    defer { CutTurnSandbox.remove(dir) }
    let bin = try CutTurnWorkerTests.unrestrictedSleep(in: dir)
    let p = try spawn(bin, env: [:])
    defer { kill(p.processIdentifier, SIGKILL) }
    usleep(UInt32(200_000 * waitScale))
    let pid = p.processIdentifier
    let real = try #require(CutTurnProcs.start(pid))
    // the record says pid was a leader that started at another time: this process only has the same number
    let snap = GroupSnapshot(nonce: Self.nonce, pane_pid: 1, groups: [.init(pgid: pid, sid: pid, leader_start_us: real - 5_000_000, members: [.init(pid: pid, start_us: real - 5_000_000)])])
    let r = CutTurnReaper.reap(nonce: Self.nonce, startedAfter: 0, snapshot: snap)
    #expect(r.killed.isEmpty && p.isRunning, "a reused pid is someone else's")
  }
}

/// A fresh folder of the test's own under the temp base; the one thing it ever deletes is that folder.
enum CutTurnSandbox {
  static func make() throws -> String {
    let p = (TestTemp.base as NSString).appendingPathComponent("talos-cutreap-\(UUID().uuidString.prefix(8))")
    try FileManager.default.createDirectory(atPath: p, withIntermediateDirectories: true)
    return try TestTemp.real(p)
  }
  static func remove(_ p: String) {
    guard p.contains("/talos-cutreap-") else { return }
    try? FileManager.default.removeItem(atPath: p)
  }
}
