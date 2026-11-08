import Foundation
import Testing
import TalosDesktopCore
import TalosSupervisor

/// Smoke O15: `--resume` of a conversation that is gone prints one of two wordings (2.1.318: `No session found with ID`; 2.1.314:
/// `No conversation found with session ID`). Every place that reads it takes both.
let resumeWordings = ["No session found with ID", "No conversation found with session ID:"]

@Suite("Both resume-missing wordings, in every matcher")
struct ResumeWordingCoreTests {
  @Test(arguments: resumeWordings)
  func everyMatcherTakesBothWordings(wording: String) {
    let line = "\(wording) 6f1c2a9e-4b3d-4c5e-8f70-123456789abc"
    #expect(DialogMatcher.resumeMissing([line]), "the exit check")
    #expect(DialogMatcher.classify([line]) == .resumeMissing, "the screen classifier")
    #expect(DialogMatcher.workerScreen([line]) == .resumeMissing, "a worker's screen")
    #expect(DialogMatcher.workerScreen(["  the log says: \(wording) here"]) == .none, "a sentence that mentions it is a conversation")
    #expect(!DialogMatcher.resumeMissing(["  the log says: \(wording) here"]))
    #expect(!DialogMatcher.liveDialog([line]).isDialog, "never a dialog")
  }
}

private final class PhaseLog: @unchecked Sendable {
  private let l = NSLock()
  private var phases: [Supervisor.Phase] = []
  var all: [Supervisor.Phase] { l.withLock { phases } }
  func add(_ p: Supervisor.Phase) { l.withLock { phases.append(p) } }
}

@Suite("Both resume-missing wordings, in the running app", .serialized, .enabled(if: Rig.hasTmux))
struct ResumeWordingIntegrationTests {
  @Test(arguments: resumeWordings)
  func mainStopsOnEitherWording(wording: String) throws {
    let r = try Rig(.tmux, scenario: "resume-missing.sh", env: ["FAKE_RESUME_LINE": wording], session: confirmedSession)
    defer { r.teardown() }
    r.start()
    #expect(r.wait(10) { stopReason(r.phase()) == .resumeMissing(Rig.sessionId) }, "\(r.phase())")
    usleep(500_000)
    #expect(r.starts.count == 1, "never restarted")
  }

  @Test(arguments: resumeWordings)
  func aWorkerFailsAsResumeMissingOnEitherWording(wording: String) throws {
    let r = try WorkerRig(extraEnv: ["FAKE_RESUME_MISSING": "1", "FAKE_RESUME_LINE": wording])
    defer { r.teardown() }
    r.makeManager(idle: 1)
    r.mgr.startTicking()
    try r.wake("trip")
    #expect(r.wait(10) { r.liveCount("trip") == 1 }, "\(r.why("trip"))")
    #expect(r.wait(10) { r.state("trip") == "parked" }, "\(r.why("trip"))")
    try r.wake("trip")
    #expect(r.wait(10) { r.state("trip") == "failed" }, "\(r.why("trip"))")
    #expect(r.entry("trip")?.error?.code == "resume_missing")
  }

  // MARK: the agent is gone before the host can read its pid

  /// A tmux that sleeps `seconds` before running any command whose argv has one of `commands`: the agent has exited, and
  /// printed its line, by the time the host asks. On a loaded runner that is how the flake happened; the shim does it every time.
  private func slowTmux(_ r: Rig, commands: [String], seconds: Double = 2) throws {
    let shim = r.root + "/tmux-slow"
    let tests = commands.map { "[ \"$a\" = \($0) ]" }.joined(separator: " || ")
    try """
    #!/bin/bash
    for a in "$@"; do
      if \(tests); then sleep \(seconds); break; fi
    done
    exec '\(Rig.tmuxPath!)' "$@"
    """.write(toFile: shim, atomically: true, encoding: .utf8)
    chmod(shim, 0o755)
    r.tmuxBin = shim
    r.makeSupervisor()
  }

  private func resumeFailedCount(_ r: Rig) -> Int { r.allEvents.filter { $0 == .resumeFailed(sessionId: Rig.sessionId) }.count }

  @Test(arguments: resumeWordings, bothHosts)
  func mainStopsOnEitherWordingWhenTheAgentExitsAtOnce(wording: String, kind: HostKind) throws {
    let r = try Rig(
      kind, scenario: "resume-missing.sh", env: ["FAKE_RESUME_LINE": wording, "FAKE_RESUME_EXIT_NOW": "1"],
      session: confirmedSession)
    defer { r.teardown() }
    r.start()
    #expect(r.wait(10) { stopReason(r.phase()) == .resumeMissing(Rig.sessionId) }, "\(r.phase())")
    usleep(500_000)
    #expect(r.starts.count == 1, "never restarted")
    #expect(resumeFailedCount(r) == 1)
    #expect(r.audit.contains(" resume_missing "), "\(r.audit)")
  }

  @Test(arguments: resumeWordings)
  func mainStopsOnEitherWordingWhenTheAgentWasGoneBeforeItsPidWasRead(wording: String) throws {
    let r = try Rig(
      .tmux, scenario: "resume-missing.sh", env: ["FAKE_RESUME_LINE": wording, "FAKE_RESUME_EXIT_NOW": "1"],
      session: confirmedSession)
    defer { r.teardown() }
    try slowTmux(r, commands: ["display-message"])
    r.start()
    #expect(r.wait(15) { stopReason(r.phase()) == .resumeMissing(Rig.sessionId) }, "\(r.phase())")
    usleep(500_000)
    #expect(r.starts.count == 1, "never restarted")
    #expect(resumeFailedCount(r) == 1)
    #expect(r.audit.contains(" resume_missing "), "\(r.audit)")
    #expect(!r.audit.contains(" start_failed"), "\(r.audit)")  // `fail()` audits no fields: the line ends at the name
  }

  /// Records `status.phase` at the moment each `resumeFailed` goes out.
  private func watchResumeFailed(_ r: Rig) -> PhaseLog {
    let seen = PhaseLog()
    let record = r.sup.onEvent
    let sup: Supervisor = r.sup
    r.sup.onEvent = { e in
      if case .resumeFailed = e { seen.add(sup.status.phase) }
      record?(e)
    }
    return seen
  }

  private let stoppedMissing = Supervisor.Phase.stopped(.resumeMissing(Rig.sessionId))

  /// The menu reads `supervisor.status` when the event reaches it, so the status must already say stopped when `resumeFailed`
  /// goes out: else the owner is told the conversation can't be resumed while the status line still says starting. The exit seen
  /// after the start (the group is cleared first).
  @Test(arguments: resumeWordings)
  func theStatusSaysStoppedWhenResumeFailedIsAnnounced(wording: String) throws {
    let r = try Rig(
      .tmux, scenario: "resume-missing.sh", env: ["FAKE_RESUME_LINE": wording, "FAKE_RESUME_EXIT_NOW": "1"],
      session: confirmedSession)
    defer { r.teardown() }
    try slowTmux(r, commands: ["clear-history"])
    let seen = watchResumeFailed(r)
    r.start()
    #expect(r.wait(15) { stopReason(r.phase()) != nil }, "\(r.phase())")
    r.sup.start()
    #expect(r.wait(15) { r.starts.count == 2 && resumeFailedCount(r) == 2 }, "\(r.phase()) starts \(r.starts.count) \(r.audit)")
    #expect(seen.all == [stoppedMissing, stoppedMissing], "the status when resumeFailed went out: \(seen.all)")
  }

  /// The same, for the agent that was gone before its pid could be read (`resumeMissingAtStart`).
  @Test(arguments: resumeWordings)
  func theStatusSaysStoppedWhenResumeFailedIsAnnouncedAtStart(wording: String) throws {
    let r = try Rig(
      .tmux, scenario: "resume-missing.sh", env: ["FAKE_RESUME_LINE": wording, "FAKE_RESUME_EXIT_NOW": "1"],
      session: confirmedSession)
    defer { r.teardown() }
    try slowTmux(r, commands: ["display-message"])
    let seen = watchResumeFailed(r)
    r.start()
    #expect(r.wait(15) { stopReason(r.phase()) == .resumeMissing(Rig.sessionId) }, "\(r.phase())")
    #expect(r.wait(5) { resumeFailedCount(r) == 1 }, "\(r.allEvents)")
    #expect(seen.all == [stoppedMissing], "the status when resumeFailed went out: \(seen.all)")
  }

  @Test(arguments: resumeWordings)
  func aDeadPaneRespawnedByTheNextStartKeepsTheLineAFastExitPrinted(wording: String) throws {
    let r = try Rig(
      .tmux, scenario: "resume-missing.sh", env: ["FAKE_RESUME_LINE": wording, "FAKE_RESUME_EXIT_NOW": "1"],
      session: confirmedSession)
    defer { r.teardown() }
    try slowTmux(r, commands: ["clear-history"])
    r.start()
    #expect(r.wait(15) { stopReason(r.phase()) != nil }, "\(r.phase())")
    // the pane is dead and stays: this start respawns it
    r.sup.start()
    #expect(r.wait(15) { r.starts.count == 2 && resumeFailedCount(r) == 2 }, "\(r.phase()) starts \(r.starts.count) \(r.audit)")
    #expect(stopReason(r.phase()) == .resumeMissing(Rig.sessionId), "\(r.phase())")
    usleep(500_000)
    #expect(r.starts.count == 2, "never restarted")
  }

  /// 1ef7184d: a restart whose `--resume` agent is gone before its pid can be read is `.resumeMissing` too, not a crash. Before,
  /// it went to `crashedWithoutChild`, retried the missing id to the crash cap and told the phone the agent kept crashing.
  @Test
  func aSupervisorRestartWhoseResumeAgentIsGoneBeforeItsPidWasReadStopsAsResumeMissing() throws {
    let r = try Rig(
      .tmux, scenario: "restart-resume-missing.sh", env: ["FAKE_CRASH_AFTER": "6", "FAKE_RESUME_EXIT_NOW": "1"])
    defer { r.teardown() }
    try slowTmux(r, commands: ["display-message"])
    try coldStartConfirmed(r)  // start 1 is a new conversation; it crashes 6 s after the notice and the restart is `--resume <id>`
    let id = r.config.session.id ?? "-"
    #expect(id != "-", "the id start 1 made")
    #expect(r.wait(40) { stopReason(r.phase()) == .resumeMissing(id) }, "\(r.phase()) \(r.audit)")
    usleep(3_000_000)  // the restart backoff (0.3 to 0.5 s) plus the slowed display-message (2 s): a retry would show by now
    #expect(r.starts.count == 2, "never restarted again: \(r.starts)")
    #expect(r.starts[1].hasSuffix("--resume \(id)"), "\(r.starts)")
    // the second start is the supervisor's own restart (its `start` line never comes: no pid was read)
    #expect(r.audit.contains(" restart attempt=0 kind=supervisorRestart"), "\(r.audit)")
    #expect(r.allEvents.filter { $0 == .resumeFailed(sessionId: id) }.count == 1)
    #expect(r.audit.contains(" resume_missing "), "\(r.audit)")
    // `fail()` and `crashedWithoutChild` audit no fields: the line ends at the name
    for name in [" restart_failed", " start_failed", " crash_loop"] { #expect(!r.audit.contains(name), "\(name): \(r.audit)") }
    #expect(!r.allEvents.contains(.stoppedRestarting))
    #expect(r.phonePosts.isEmpty, "no crash message to the phone: \(r.phonePosts)")
  }

  @Test(arguments: resumeWordings)
  func aWorkerFailsAsResumeMissingWhenTheAgentExitsAtOnce(wording: String) throws {
    let r = try WorkerRig(extraEnv: ["FAKE_RESUME_MISSING": "1", "FAKE_RESUME_LINE": wording, "FAKE_RESUME_EXIT_NOW": "1"])
    defer { r.teardown() }
    r.makeManager(idle: 1)
    r.mgr.startTicking()
    try r.wake("trip")
    #expect(r.wait(10) { r.liveCount("trip") == 1 }, "\(r.why("trip"))")
    #expect(r.wait(10) { r.state("trip") == "parked" }, "\(r.why("trip"))")
    try r.wake("trip")
    #expect(r.wait(10) { r.state("trip") == "failed" }, "\(r.why("trip"))")
    #expect(r.entry("trip")?.error?.code == "resume_missing", "\(r.why("trip"))")
    #expect(r.starts.count == 2, "never restarted: \(r.starts.count)")
  }
}
