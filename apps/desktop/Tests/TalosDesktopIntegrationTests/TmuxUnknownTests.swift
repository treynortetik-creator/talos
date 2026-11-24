import Foundation
import Testing
import TalosDesktopCore
import TalosTestSupport

@testable import TalosSupervisor

/// tmux that does not answer is not an agent that is gone. Each case runs a real Main in a real private tmux server and puts a shim in front of
/// tmux that refuses the reads that say whether the agent's pane is there (display-message, has-session, list-panes, capture-pane) from the
/// moment a chosen command ran (`new-session` or `respawn-pane`) until the test heals it. The agent keeps running the whole time, as it does
/// when a real tmux is slow or refusing under load. Reproductions of the 2026-11-22 review: a restart whose respawn could not be read killed
/// the live agent with a second respawn-pane or started a second one ("another session holds its channels"), an attach at launch read as
/// "nothing running" and cold-started over a live Main, and a refused socket ("no server running on <path>") was trusted as a dead server.
@Suite("tmux that does not answer is not an agent that is gone", .serialized, .enabled(if: Rig.hasTmux))
struct TmuxUnknownTests {
  /// What the shim prints when it refuses a read.
  enum Refusal: String {
    case noServer = "no server running on /private/tmp/tmux-501/talos-test"
    case refused = "error connecting to /private/tmp/tmux-501/talos-test (Connection refused)"
  }

  final class Shim {
    let path: String
    let armed: String
    let healed: String
    let calls: String
    init(_ r: Rig, armOn: String, refusal: Refusal, slowOn: String = "never") throws {
      path = r.root + "/tmux-unknown-shim"
      armed = r.root + "/shim-armed"
      healed = r.root + "/shim-healed"
      calls = r.root + "/shim-calls"
      try """
      #!/bin/bash
      sub=""
      for a in "$@"; do
        case "$a" in new-session|respawn-pane|new-window|display-message|has-session|list-panes|capture-pane|kill-session|show-option|show-options|set-option) sub="$a"; break ;; esac
      done
      echo "$sub" >> '\(calls)'
      if [ -f '\(armed)' ] && [ ! -f '\(healed)' ]; then
        case "$sub" in
          display-message|has-session|list-panes|capture-pane|show-option|show-options|set-option) echo '\(refusal.rawValue)' >&2; exit 1 ;;
        esac
      fi
      '\(Rig.tmuxPath!)' "$@"
      rc=$?
      if [ "$sub" = '\(slowOn)' ] && [ ! -f '\(path)-slowed' ]; then : > '\(path)-slowed'; sleep 13; fi
      if [ "$sub" = '\(armOn)' ] && [ ! -f '\(healed)' ]; then : > '\(armed)'; fi
      exit $rc
      """.write(toFile: path, atomically: true, encoding: .utf8)
      chmod(path, 0o755)
    }
    func heal() { FileManager.default.createFile(atPath: healed, contents: Data()) }
    var isArmed: Bool { FileManager.default.fileExists(atPath: armed) }
    func count(_ word: String) -> Int {
      ((try? String(contentsOfFile: calls, encoding: .utf8)) ?? "").split(separator: "\n").filter { $0 == word }.count
    }
  }


  private func realPanePid(_ r: Rig) -> Int32? {
    let out = ProcessRunner.run([Rig.tmuxPath!, "-L", r.socket, "display-message", "-p", "-t", "=agent:", "#{pane_pid}"], env: ["PATH": "/usr/bin:/bin"]).out
    return Int32(out.trimmingCharacters(in: .whitespacesAndNewlines))
  }

  private func make(_ scenario: String = "main-usage-limit.sh", env: [String: String] = [:], timings: Supervisor.Timings? = nil, after: Double = 0) throws -> Rig {
    var t = timings ?? Rig.defaultTimings()
    t.promptSettle = 0.6
    t.unreachableAfter = after  // the owner's notice after this many seconds of unanswered looks: shortened for the tests (never the 60 of the app)
    let r = try Rig(.tmux, scenario: scenario, env: env, timings: t)
    r.boundedReadDeadline = 0.4  // a bounded read gives up sooner: the tests wait on ticks
    return r
  }

  // MARK: a cold start whose pane cannot be read (R1-3, R1-4)

  @Test(arguments: [Refusal.refused, Refusal.noServer])
  func aStartWhosePaneCannotBeReadKeepsTheOneAgentAndAdoptsItLater(refusal: Refusal) throws {
    let r = try make()
    defer { r.teardown() }
    let shim = try Shim(r, armOn: "new-session", refusal: refusal)
    r.tmuxBin = shim.path
    r.makeSupervisor()
    r.start()
    #expect(r.wait(20) { shim.isArmed && r.audit.contains("start_pane_unreadable") }, "\(r.phase()) audit: \(r.audit)")
    let pane = realPanePid(r)
    #expect(pane != nil && kill(pane!, 0) == 0, "control: the agent is running")
    // not a failed start, not a crash, not another launch
    for _ in 0..<3 { r.sup.tickNow() }
    #expect(r.phase() == .starting, "\(r.phase())")
    #expect(!r.audit.contains("start_failed") && !r.audit.contains("restart_failed"), Comment(rawValue: r.audit))
    #expect(shim.count("new-session") == 1 && shim.count("respawn-pane") == 0 && shim.count("new-window") == 0, "one launch only")
    #expect(r.starts.count == 1, "\(r.starts)")
    shim.heal()
    #expect(r.wait(20) { r.sup.tickNow(); return r.sup.status.childPid != nil }, "\(r.phase()) audit: \(r.audit)")
    #expect(r.sup.status.childPid == pane, "adopted the same agent")
    #expect(r.audit.contains("start_adopted"))
    #expect(r.starts.count == 1 && shim.count("new-session") == 1, "never two agents: \(r.starts)")
    #expect(pane != nil && kill(pane!, 0) == 0, "the agent is still the same live process")
  }

  /// Said only after several unanswered looks over a while, in plain words, once; cleared by the first answer.
  @Test func afterTheUnknownLimitTheOwnerIsToldOnce() throws {
    let r = try make()
    defer { r.teardown() }
    let shim = try Shim(r, armOn: "new-session", refusal: .refused)
    r.tmuxBin = shim.path
    r.makeSupervisor()
    r.start()
    #expect(r.wait(20) { r.audit.contains("start_pane_unreadable") }, "\(r.audit)")
    r.sup.tickNow()
    #expect(!r.sup.status.agentUnreachable, "one look is not enough")
    for _ in 0..<(Supervisor.unreachableReads + 1) { r.sup.tickNow() }
    #expect(r.sup.status.agentUnreachable, "told after \(Supervisor.unreachableReads) looks")
    #expect(r.audit.components(separatedBy: "agent_unreachable").count - 1 == 1, "once: \(r.audit)")
    #expect(r.phase() == .starting && r.starts.count == 1)
    shim.heal()
    #expect(r.wait(20) { r.sup.tickNow(); return r.sup.status.childPid != nil })
    #expect(!r.sup.status.agentUnreachable, "cleared by the first answer")
    #expect(r.audit.contains("agent_reachable"), Comment(rawValue: r.audit))
  }

  // MARK: a restart whose respawned pane cannot be read (R1-1)

  @Test(arguments: [Refusal.refused, Refusal.noServer])
  func aRestartWhosePaneCannotBeReadIsNotACrashAndNeverKillsOrDuplicatesTheAgent(refusal: Refusal) throws {
    var t = Supervisor.Timings()
    t.unreachableAfter = 0
    t.tick = 0.2
    t.agentsPoll = 0.5
    t.backoff = Backoff(steps: [0.3, 0.5, 0.5, 0.5, 0.5], jitter: 0)
    let r = try Rig(.tmux, scenario: "slow-notice.sh", env: ["FAKE_CRASH_ON_FILE": "1", "FAKE_NOTICE_DELAY": "0"], timings: t)
    r.boundedReadDeadline = 0.4
    defer { r.teardown() }
    let shim = try Shim(r, armOn: "respawn-pane", refusal: refusal)
    r.tmuxBin = shim.path
    r.makeSupervisor()
    try coldStartConfirmed(r)
    FileManager.default.createFile(atPath: r.stateDir + "/crash-now", contents: Data())  // the agent crashes, the restart respawns the pane
    #expect(r.wait(30) { r.audit.contains("start_pane_unreadable") }, "\(r.phase()) audit: \(r.audit)")
    let pane = realPanePid(r)
    #expect(pane != nil && kill(pane!, 0) == 0, "control: the respawned agent is running")
    for _ in 0..<3 { r.sup.tickNow() }
    #expect(shim.count("respawn-pane") == 1, "the live agent was killed or duplicated by a second respawn: \(shim.count("respawn-pane"))")
    #expect(!r.audit.contains("restart_failed"), "counted as a crash: \(r.audit)")
    #expect(r.phase() == .starting, "\(r.phase())")
    shim.heal()
    #expect(r.wait(20) { r.sup.tickNow(); return r.sup.status.childPid == pane }, "\(r.phase()) audit: \(r.audit)")
    #expect(shim.count("respawn-pane") == 1 && r.starts.count == 2, "one restart, one agent: \(r.starts)")
    #expect(pane != nil && kill(pane!, 0) == 0)
  }

  // MARK: an attach at launch that tmux did not answer (R1-2)

  @Test func anAttachThatTmuxDidNotAnswerIsNeverAColdStartOverALiveMain() throws {
    let r = try make()
    defer { r.teardown() }
    r.start()
    #expect(r.wait(20) { isRunning(r.phase()) }, "\(r.phase()) audit: \(r.audit)")
    let live = try #require(r.sup.status.childPid)
    r.sup.detach()  // the app quits; Main keeps running in tmux
    let shim = try Shim(r, armOn: "never", refusal: .noServer)
    FileManager.default.createFile(atPath: shim.armed, contents: Data())  // refuses from the first call
    r.tmuxBin = shim.path
    let s2 = r.makeSupervisor()
    s2.startTicking()
    s2.attachOrStart(allowColdStart: true)
    #expect(r.wait(10) { r.audit.contains("attach_unanswered") }, Comment(rawValue: r.audit))
    for _ in 0..<3 { s2.tickNow() }
    #expect(s2.status.phase == .idle, "\(s2.status.phase)")
    #expect(r.starts.count == 1 && shim.count("new-session") == 0 && shim.count("respawn-pane") == 0, "a second Main was started: \(r.starts)")
    #expect(kill(live, 0) == 0, "control: the first Main is still alive")
    shim.heal()
    #expect(r.wait(20) { s2.tickNow(); return s2.status.startKind == .attached }, "\(s2.status.phase) audit: \(r.audit)")
    #expect(s2.status.childPid == live && r.starts.count == 1, "attached to the same Main")
  }

  /// And the other way: a server that really is gone still ends as gone, and the cold start the owner allowed goes ahead.
  @Test func aServerThatReallyIsGoneStillStartsCold() throws {
    let r = try make()
    defer { r.teardown() }
    r.start()
    #expect(r.wait(20) { isRunning(r.phase()) }, "\(r.phase())")
    r.sup.detach()
    _ = ProcessRunner.run([Rig.tmuxPath!, "-L", r.socket, "kill-server"], env: ["PATH": "/usr/bin:/bin"])
    let s2 = r.makeSupervisor()
    s2.startTicking()
    s2.attachOrStart(allowColdStart: true)
    #expect(r.wait(25) { s2.tickNow(); return r.starts.count == 2 }, "\(s2.status.phase) audit: \(r.audit)")
  }

  /// What tmux prints for a socket file nobody listens on is "no server running on <path>" too: with no tmux process for the socket it is a
  /// dead server, and the cold start the owner allowed goes ahead (the same words with a live server are the cases above).
  @Test func aStaleSocketFileWithNoServerStillStartsCold() throws {
    let r = try make()
    defer { r.teardown() }
    let dir = "/tmp/tmux-\(getuid())"
    mkdir(dir, 0o700)
    let path = dir + "/" + r.socket
    let fd = socket(AF_UNIX, SOCK_STREAM, 0)
    var addr = sockaddr_un()
    addr.sun_family = sa_family_t(AF_UNIX)
    withUnsafeMutableBytes(of: &addr.sun_path) { buf in _ = path.withCString { strncpy(buf.baseAddress!.assumingMemoryBound(to: CChar.self), $0, buf.count - 1) } }
    let bound = withUnsafePointer(to: &addr) { $0.withMemoryRebound(to: sockaddr.self, capacity: 1) { bind(fd, $0, socklen_t(MemoryLayout<sockaddr_un>.size)) } }
    close(fd)  // the file stays, nobody listens
    defer { unlink(path) }
    #expect(bound == 0, "control: a stale socket file was made")
    let plain = ProcessRunner.run([Rig.tmuxPath!, "-L", r.socket, "has-session", "-t", "=agent"], env: ["PATH": "/usr/bin:/bin"])
    #expect(plain.err.contains("no server running"), "control: tmux says it with a stale socket: \(plain.err)")
    let s2 = r.makeSupervisor()
    s2.startTicking()
    s2.attachOrStart(allowColdStart: true)
    #expect(r.wait(30) { s2.tickNow(); return r.starts.count == 1 }, "\(s2.status.phase) audit: \(r.audit)")
  }

  // MARK: the host itself (R1-4, the poll)

  /// A refused socket is not proof of a dead server while the agent's own process group is alive: the poll never reports the agent lost.
  @Test func unansweredTmuxReadsNeverKillOrStart() throws {
    let r = try make()
    defer { r.teardown() }
    let shim = try Shim(r, armOn: "never", refusal: .noServer)
    r.tmuxBin = shim.path
    r.makeSupervisor()
    r.start()
    #expect(r.wait(20) { isRunning(r.phase()) }, "\(r.phase()) audit: \(r.audit)")
    let live = try #require(r.sup.status.childPid)
    FileManager.default.createFile(atPath: shim.armed, contents: Data())  // the socket now refuses everything
    // several polls (1 s each by default) with the agent alive: never an exit
    #expect(!r.wait(4) { r.audit.contains(" exit ") || !isRunning(r.phase()) }, "reported lost: \(r.phase()) \(r.audit)")
    #expect(kill(live, 0) == 0)
    #expect(shim.count("kill-session") == 0 && shim.count("respawn-pane") == 0 && shim.count("new-window") == 0 && shim.count("new-session") == 1,
      "something was killed or started")
    #expect(r.starts.count == 1, "\(r.starts)")
  }

  // MARK: the reviewer's second round (R1-1 ... R1-7), against a real Main

  /// R1-1: a respawn that ran but did not answer in time is "launched, unknown": nothing is sent again, the live agent is adopted.
  @Test func aTimedOutRespawnIsLaunchedUnknownAndTheAgentIsAdoptedNotRespawnedAgain() throws {
    var t = Supervisor.Timings()
    t.unreachableAfter = 0
    t.tick = 0.2
    t.agentsPoll = 0.5
    t.backoff = Backoff(steps: [0.3, 0.5, 0.5, 0.5, 0.5], jitter: 0)
    let r = try Rig(.tmux, scenario: "slow-notice.sh", env: ["FAKE_CRASH_ON_FILE": "1", "FAKE_NOTICE_DELAY": "0"], timings: t)
    r.boundedReadDeadline = 0.4
    defer { r.teardown() }
    let shim = try Shim(r, armOn: "never", refusal: .refused, slowOn: "respawn-pane")
    r.tmuxBin = shim.path
    r.makeSupervisor()
    try coldStartConfirmed(r)
    FileManager.default.createFile(atPath: r.stateDir + "/crash-now", contents: Data())
    #expect(r.wait(40) { r.audit.contains("start_pane_unreadable") }, "\(r.phase()) audit: \(r.audit)")
    #expect(r.audit.contains("launched=yes"), Comment(rawValue: r.audit))
    #expect(!r.audit.contains("restart_failed") && !r.audit.contains("start_failed"), Comment(rawValue: r.audit))
    let pane = realPanePid(r)
    #expect(r.wait(30) { r.sup.tickNow(); return r.sup.status.childPid == pane && pane != nil }, "\(r.phase()) audit: \(r.audit)")
    #expect(shim.count("respawn-pane") == 1 && r.starts.count == 2, "respawned again: \(shim.count("respawn-pane")) \(r.starts)")
  }

  /// R1-2: a start whose tmux did not answer BEFORE anything was launched is decided again on ticks: nothing runs, so it launches once.
  @Test func aNotLaunchedStartThatTmuxDidNotAnswerLaunchesOnceWhenNothingRuns() throws {
    let r = try make()
    defer { r.teardown() }
    let shim = try Shim(r, armOn: "never", refusal: .refused)
    FileManager.default.createFile(atPath: shim.armed, contents: Data())  // refuses from the first call
    r.tmuxBin = shim.path
    r.makeSupervisor()
    r.start()
    #expect(r.wait(20) { r.audit.contains("start_pane_unreadable") }, "\(r.phase()) audit: \(r.audit)")
    #expect(r.audit.contains("launched=no"), Comment(rawValue: r.audit))
    for _ in 0..<2 { r.sup.tickNow() }
    #expect(shim.count("new-session") == 0 && r.starts.isEmpty, "something was launched on an unknown")
    shim.heal()
    #expect(r.wait(25) { r.sup.tickNow(); return r.sup.status.childPid != nil }, "\(r.phase()) audit: \(r.audit)")
    #expect(shim.count("new-session") == 1 && r.starts.count == 1, "\(r.starts)")
    #expect(r.audit.contains("start_relaunch"), Comment(rawValue: r.audit))
  }

  /// R1-4: Start while an attach that tmux did not answer stands looks first, keeps the retry and says so; a start over a live Main attaches.
  @Test func startWhileAnAttachRetryStandsKeepsItAndAttachesWhenTmuxAnswers() throws {
    let r = try make()
    defer { r.teardown() }
    r.start()
    #expect(r.wait(20) { isRunning(r.phase()) }, "\(r.phase())")
    let live = try #require(r.sup.status.childPid)
    r.sup.detach()
    let shim = try Shim(r, armOn: "never", refusal: .refused)
    FileManager.default.createFile(atPath: shim.armed, contents: Data())
    r.tmuxBin = shim.path
    let s2 = r.makeSupervisor()
    s2.startTicking()
    s2.attachOrStart(allowColdStart: true)
    #expect(r.wait(10) { r.audit.contains("attach_unanswered") }, Comment(rawValue: r.audit))
    s2.start()  // the owner presses Start
    #expect(r.wait(10) { s2.status.agentUnreachable }, "the owner was not told")
    #expect(r.starts.count == 1 && shim.count("new-session") == 0)
    shim.heal()
    #expect(r.wait(20) { s2.tickNow(); return s2.status.startKind == .attached }, "\(s2.status.phase) audit: \(r.audit)")
    #expect(s2.status.childPid == live && r.starts.count == 1)
    // and a Start over a live Main (tmux answering) attaches instead of failing
    s2.stop()
    #expect(r.wait(20) { s2.status.phase == .stopped(.user) }, "\(s2.status.phase)")
  }

  /// R1-6: a Stop while tmux does not answer stays stopping and asks again; it ends the session once tmux answers.
  @Test func aStopWhileTmuxDoesNotAnswerStaysStoppingUntilItCanKillTheSession() throws {
    let r = try make()
    defer { r.teardown() }
    r.start()
    #expect(r.wait(20) { isRunning(r.phase()) }, "\(r.phase())")
    let live = try #require(r.sup.status.childPid)
    r.sup.detach()
    let shim = try Shim(r, armOn: "never", refusal: .refused)
    FileManager.default.createFile(atPath: shim.armed, contents: Data())
    r.tmuxBin = shim.path
    let s2 = r.makeSupervisor()
    s2.startTicking()
    s2.attachOrStart(allowColdStart: true)
    #expect(r.wait(10) { r.audit.contains("attach_unanswered") }, Comment(rawValue: r.audit))
    s2.stop()
    #expect(r.wait(10) { r.audit.contains("stop_waiting_unanswered") }, Comment(rawValue: r.audit))
    #expect(s2.status.phase == .stopping, "published stopped over an agent nobody could reach: \(s2.status.phase)")
    #expect(kill(live, 0) == 0, "control: the agent is alive")
    shim.heal()
    #expect(r.wait(30) { s2.tickNow(); return s2.status.phase == .stopped(.user) }, "\(s2.status.phase) audit: \(r.audit)")
    #expect(r.wait(10) { kill(live, 0) != 0 }, "the agent was not stopped")
  }

  /// R1-7: unanswered reads of a RUNNING agent count toward the same line (60 s, here shortened to 1 s, never 0).
  @Test func unansweredReadsOfARunningAgentCountTowardTheLine() throws {
    let r = try make(after: 1)
    defer { r.teardown() }
    let shim = try Shim(r, armOn: "never", refusal: .refused)
    r.tmuxBin = shim.path
    r.makeSupervisor()
    r.start()
    #expect(r.wait(20) { isRunning(r.phase()) }, "\(r.phase()) audit: \(r.audit)")
    FileManager.default.createFile(atPath: shim.armed, contents: Data())
    r.sup.tickNow()
    #expect(!r.sup.status.agentUnreachable, "told at once")
    #expect(r.wait(30) { r.sup.tickNow(); return r.sup.status.agentUnreachable }, "never told: \(r.audit)")
    #expect(r.phase() == .running, "\(r.phase())")
    shim.heal()
    #expect(r.wait(20) { r.sup.tickNow(); return !r.sup.status.agentUnreachable }, "never cleared")
  }

  /// R2-2: a pending start that was never launched sees tmux answer "running", and then tmux stops answering between the two looks. The start keeps
  /// waiting (never "the agent exited immediately"), and attaches to the live Main once tmux answers.
  @Test func aFlapBetweenTheTwoLooksOfAPendingStartKeepsWaitingAndAttaches() throws {
    let r = try make()
    defer { r.teardown() }
    let shim = r.root + "/flap-shim", on = r.root + "/flap-on", flap = r.root + "/flap-go", seen = r.root + "/flap-seen"
    try """
    #!/bin/bash
    sub=""; for a in "$@"; do case "$a" in has-session|display-message) sub="$a";; esac; done
    if [ -f '\(on)' ] && [ -n "$sub" ]; then
      if [ -f '\(flap)' ] && [ ! -f '\(seen)'-$sub ]; then : > '\(seen)'-$sub; exec '\(Rig.tmuxPath!)' "$@"; fi
      echo 'error connecting to /x (Connection refused)' >&2; exit 1
    fi
    exec '\(Rig.tmuxPath!)' "$@"
    """.write(toFile: shim, atomically: true, encoding: .utf8)
    chmod(shim, 0o755)
    r.makeSupervisor()
    r.start()
    #expect(r.wait(20) { isRunning(r.phase()) }, "\(r.phase())")
    let live = try #require(r.sup.status.childPid)
    r.sup.detach()
    r.tmuxBin = shim
    FileManager.default.createFile(atPath: on, contents: Data())
    r.tuneOptions = { $0.takeoverCheck = false }  // the live Main would otherwise be a takeover blocker before the host is reached
    let s2 = r.makeSupervisor()
    s2.start()
    #expect(r.wait(15) { r.audit.contains("start_pane_unreadable") }, Comment(rawValue: r.audit))
    FileManager.default.createFile(atPath: flap, contents: Data())  // one answer each for has-session and display-message, then refusals
    s2.tickNow()
    #expect(!r.audit.contains("start_failed"), "failed on the flap: \(r.audit)")
    #expect(s2.status.phase == .starting, "\(s2.status.phase)")
    unlink(on)  // tmux healthy again
    #expect(r.wait(20) { s2.tickNow(); return s2.status.childPid == live }, "\(s2.status.phase) audit: \(r.audit)")
    #expect(r.starts.count == 1 && kill(live, 0) == 0, "\(r.starts)")
  }

  /// Row 12 says a start that stalls is a line in the thread; a start tmux cannot be asked about has not stalled. While tmux does not answer, the
  /// stall clock stands still (no "stalled" notice, no line), the owner hears "can't check" once, and when tmux answers again the start gets its
  /// whole wait before it can be called stalled.
  @Test func aStartThatTmuxCannotBeAskedAboutIsNotStalledAndItsClockStandsStill() throws {
    var t = Supervisor.Timings()
    t.tick = 0.2
    t.agentsPoll = 0.5
    t.dialogStall = 0
    t.stopGrace = 3
    t.unreachableAfter = 0
    let r = try Rig(.tmux, scenario: "silent-then-login.sh", timings: t)
    r.boundedReadDeadline = 0.3
    defer { r.teardown() }
    let shim = try Shim(r, armOn: "never", refusal: .refused)
    r.tmuxBin = shim.path
    r.makeSupervisor()
    r.start()
    #expect(r.wait(20) { r.sup.tickNow(); return r.sup.status.childPid != nil && r.phase() == .starting }, "\(r.phase()) audit: \(r.audit)")
    let startedAtBefore = try #require(r.sup.launch?.startedAt)
    FileManager.default.createFile(atPath: shim.armed, contents: Data())  // tmux stops answering; the agent runs on
    #expect(r.wait(10) { (r.host?.unansweredStreak ?? 0) > 0 }, "the host's poll never noticed")
    for _ in 0..<8 {
      r.clock.advance(60)
      r.sup.tickNow()
    }
    r.sup.drain()
    #expect(r.sup.launch?.startedAt == startedAtBefore, "the pause moved the launch's start time")
    #expect((r.sup.launch?.stallPausedTotal ?? 0) > 0, "nothing was held back")
    #expect(r.sup.status.needsYou != .startStalled, "called stalled while nobody could look at it")
    #expect(!r.phonePosts.contains { $0.contains("hasn't finished starting") }, "a stalled line went to the phone: \(r.phonePosts)")
    #expect(r.phonePosts.filter { $0.contains("can't check on") }.count == 1, "the can't-check line is said once: \(r.phonePosts)")
    #expect(r.audit.contains("agent_unreachable"), "the owner was not told it cannot be checked: \(r.audit)")
    shim.heal()
    r.sup.tickNow()
    #expect(r.sup.status.needsYou != .startStalled, "stalled the moment tmux answered: the wait stood still while it was away")
    #expect(r.wait(60) { r.clock.advance(60); r.sup.tickNow(); return r.sup.status.needsYou == .startStalled }, "never stalled after its whole wait: \(r.audit)")
  }

  // MARK: the stall clock's pause lives and dies with its launch

  /// The pause began while tmux refused; the owner stopped Main; tmux healed; a day later Main is started: its stall clock is its own (nothing of
  /// the old pause moved its start into the future).
  @Test func aStalePauseDoesNotHideTheNextStartsStall() throws {
    var t = Supervisor.Timings()
    t.tick = 0.2
    t.agentsPoll = 0.5
    t.dialogStall = 0
    t.stopGrace = 3
    t.unreachableAfter = 0
    let r = try Rig(.tmux, scenario: "silent-then-login.sh", timings: t)
    r.boundedReadDeadline = 0.3
    defer { r.teardown() }
    let shim = try Shim(r, armOn: "never", refusal: .refused)
    r.tmuxBin = shim.path
    r.makeSupervisor()
    r.start()
    #expect(r.wait(20) { r.sup.tickNow(); return r.sup.status.childPid != nil && r.phase() == .starting }, "\(r.phase()) audit: \(r.audit)")
    FileManager.default.createFile(atPath: shim.armed, contents: Data())
    #expect(r.wait(10) { (r.host?.unansweredStreak ?? 0) > 0 }, "the host's poll never noticed")
    for _ in 0..<3 {
      r.clock.advance(30)
      r.sup.tickNow()
    }
    shim.heal()
    r.sup.stop()
    #expect(r.wait(30) { r.sup.tickNow(); return r.phase() == .stopped(.user) }, "\(r.phase())")
    r.clock.advance(86_400)
    r.sup.start()
    #expect(r.wait(20) { r.sup.tickNow(); return r.sup.status.childPid != nil }, "\(r.phase()) audit: \(r.audit)")
    let l = try #require(r.sup.launch)
    #expect(l.startedAt <= r.clock.now() + 1, "the new start's clock is \(l.startedAt - r.clock.now()) s in the future")
  }

  /// Three hours of unanswered reads while Main RUNS do not pause anything (only a start is paused), and the restart after them has its own clock.
  @Test func threeHoursUnansweredWhileRunningThenARestartLeavesTheNewStartsClockAlone() throws {
    let r = try make(after: 1)
    defer { r.teardown() }
    let shim = try Shim(r, armOn: "never", refusal: .refused)
    r.tmuxBin = shim.path
    r.makeSupervisor()
    r.start()
    #expect(r.wait(20) { isRunning(r.phase()) }, "\(r.phase()) audit: \(r.audit)")
    FileManager.default.createFile(atPath: shim.armed, contents: Data())
    #expect(r.wait(10) { (r.host?.unansweredStreak ?? 0) > 0 }, "the host's poll never noticed")
    for _ in 0..<18 {
      r.clock.advance(600)
      r.sup.tickNow()
    }
    #expect((r.sup.launch?.stallPausedTotal ?? 0) == 0, "a running agent's clock was paused")
    shim.heal()
    r.sup.restartCold()
    #expect(r.wait(30) { r.sup.tickNow(); return r.sup.launch.map { $0.kind == .cold && $0.startedAt > 0 } == true && r.starts.count == 2 }, "\(r.phase()) audit: \(r.audit)")
    let l = try #require(r.sup.launch)
    #expect(l.startedAt <= r.clock.now() + 1 && l.stallPausedTotal == 0, "the restart's clock is \(l.startedAt - r.clock.now()) s in the future")
  }

  private func awayForGood(unreachableAfter: Double) throws -> (Rig, Shim) {
    var t = Supervisor.Timings()
    t.tick = 0.2
    t.agentsPoll = 0.5
    t.dialogStall = 0
    t.stopGrace = 3
    t.unreachableAfter = unreachableAfter
    let r = try Rig(.tmux, scenario: "silent-then-login.sh", timings: t)
    r.boundedReadDeadline = 0.3
    let shim = try Shim(r, armOn: "never", refusal: .refused)
    r.tmuxBin = shim.path
    r.makeSupervisor()
    r.start()
    #expect(r.wait(20) { r.sup.tickNow(); return r.sup.status.childPid != nil && r.phase() == .starting }, "\(r.phase()) audit: \(r.audit)")
    FileManager.default.createFile(atPath: shim.armed, contents: Data())
    #expect(r.wait(10) { (r.host?.unansweredStreak ?? 0) > 0 }, "the host's poll never noticed")
    return (r, shim)
  }

  /// The pause is capped (10 minutes in all). A tmux that stays away for good, with the owner not yet told "can't check", gets the stall line, and the
  /// line says the real wait (12 minutes or more), not the configured 2.
  @Test func theStallClockPauseIsCappedAndTheLineSaysTheRealWait() throws {
    let (r, _) = try awayForGood(unreachableAfter: 1e9)  // the "can't check" line never goes: only the stall can be said
    defer { r.teardown() }
    #expect(
      r.wait(60) {
        r.clock.advance(60)
        r.sup.tickNow()
        return r.sup.status.needsYou == .startStalled
      }, "never called stalled after the cap: paused \(r.sup.launch?.stallPausedTotal ?? -1) s")
    #expect((r.sup.launch?.stallPausedTotal ?? 0) <= Supervisor.stallPauseCap)
    #expect(r.wait(10) { r.sup.drain(); return r.phonePosts.contains { $0.contains("hasn't finished starting") } }, "posts: \(r.phonePosts)")
    let line = try #require(r.phonePosts.first { $0.contains("hasn't finished starting") })
    #expect(!line.contains("after 2 minutes") && !line.contains("after 1 minute "), "the line says the configured wait: \(line)")
  }

  /// After the cap, an owner who already has the truthful "can't check" line is not also told "stalled".
  @Test func afterTheCapAnOwnerWhoWasToldCantCheckIsNotAlsoToldStalled() throws {
    let (r, _) = try awayForGood(unreachableAfter: 0)
    defer { r.teardown() }
    for _ in 0..<30 {
      r.clock.advance(60)
      r.sup.tickNow()
    }
    r.sup.drain()
    #expect((r.sup.launch?.stallPausedTotal ?? 0) >= Supervisor.stallPauseCap, "the cap was not reached")
    #expect(r.sup.status.needsYou != .startStalled, "told stalled as well as can't-check")
    #expect(!r.phonePosts.contains { $0.contains("hasn't finished starting") }, "\(r.phonePosts)")
    #expect(r.phonePosts.filter { $0.contains("can't check on") }.count == 1, "\(r.phonePosts)")
  }

  // MARK: the socket file vanishing under a live server

  /// A /tmp cleanup (or another TMUX_TMPDIR) removes the socket file while the server and its agent live on: every read then says "error
  /// connecting to <path> (No such file or directory)". One agent, the same pid, nothing started beside it, nothing killed; the owner is
  /// told after the limit; the server recreates its socket on SIGUSR1 and the agent is looked after again.
  @Test func deletingTheTmuxSocketUnderALiveSessionNeverStartsASecondOne() throws {
    let r = try make()
    defer { r.teardown() }
    r.start()
    #expect(r.wait(20) { isRunning(r.phase()) }, "\(r.phase()) audit: \(r.audit)")
    let live = try #require(r.sup.status.childPid)
    let serverPid = Int32(ProcessRunner.run([Rig.tmuxPath!, "-L", r.socket, "display-message", "-p", "#{pid}"], env: ["PATH": "/usr/bin:/bin"]).out
      .trimmingCharacters(in: .whitespacesAndNewlines))
    let socketPath = "/tmp/tmux-\(getuid())/\(r.socket)"
    #expect(FileManager.default.fileExists(atPath: socketPath), "control: the socket file is there")
    #expect(serverPid != nil)
    unlink(socketPath)
    defer { if let p = serverPid { kill(p, SIGUSR1) } }  // (Rig.teardown ends any server kill-server cannot reach)
    // the running supervisor: its polls and ticks read "gone" and must not act on it
    #expect(!r.wait(4) { r.sup.tickNow(); return r.audit.contains(" exit ") || !isRunning(r.phase()) }, "reported lost: \(r.phase()) \(r.audit)")
    // a second copy of the app launching now: it attaches to nothing it can see, and starts nothing
    r.sup.detach()
    let s2 = r.makeSupervisor()
    s2.startTicking()
    s2.attachOrStart(allowColdStart: true)
    #expect(r.wait(10) { r.audit.contains("attach_unanswered") }, Comment(rawValue: r.audit))
    for _ in 0..<(Supervisor.unreachableReads + 1) { s2.tickNow() }
    #expect(r.starts.count == 1, "a second agent was started: \(r.starts)")
    #expect(kill(live, 0) == 0, "control: the agent is alive")
    #expect(s2.status.agentUnreachable, "told after the limit")
    if let p = serverPid { kill(p, SIGUSR1) }  // the server makes its socket again
    #expect(r.wait(20) { s2.tickNow(); return s2.status.startKind == .attached }, "\(s2.status.phase) audit: \(r.audit)")
    #expect(s2.status.childPid == live && r.starts.count == 1, "the same agent, adopted")
    #expect(!s2.status.agentUnreachable)
  }
}

/// The host's own judgments, with a scripted tmux.
@Suite("tmux host: what counts as gone", .serialized)
struct TmuxHostGoneTests {
  private func host(_ script: @escaping @Sendable ([String]) -> RunResult) -> TmuxPtyHost {
    let dir = NSTemporaryDirectory() + "talos-hostgone-\(UUID().uuidString.prefix(6))"
    return TmuxPtyHost(
      commands: TmuxCommands(tmux: "/usr/bin/true", socket: "talos-test-\(getpid())-gone\(UInt32.random(in: 0..<UInt32.max))", configPath: "/dev/null"), launchDir: dir,
      baseEnv: [:], pollInterval: 1,
      runner: { argv, _, _ in argv.first == "/bin/ps" ? ProcessRunner.run(argv, env: ["PATH": "/usr/bin:/bin"]) : script(argv) },
      sendSignal: { _, _ in })
  }

  private func err(_ text: String) -> RunResult { RunResult(status: 1, stdout: Data(), stderr: Data(text.utf8), timedOut: false) }
  private static let noFile = "error connecting to /tmp/tmux-501/x (No such file or directory)"

  /// A process that has ended: its pid is not alive.
  private func deadPid() throws -> Int32 {
    let p = Process()
    p.executableURL = URL(fileURLWithPath: "/usr/bin/true")
    try p.run()
    p.waitUntilExit()
    return p.processIdentifier
  }

  @Test func goneButTheAgentPidIsAliveIsUnknownNotGone() throws {
    let h = host { _ in RunResult(status: 0, stdout: Data(), stderr: Data(), timedOut: false) }
    h.recordChild(getpid())  // this process: alive, and the same one
    for text in [Self.noFile, "no server running on /tmp/tmux-501/x"] {
      #expect(!h.trustsGone(err(text)), "\(text)")
    }
    // control: tmux answering "no such session" is an answer, whoever is alive
    #expect(h.trustsGone(err("can't find session: agent")))
    // control: the recorded agent gone is proof
    h.recordChild(try deadPid())
    #expect(h.trustsGone(err(Self.noFile)))
  }

  @Test func aReusedPidIsNotTheSameAgent() {
    let h = host { _ in RunResult(status: 0, stdout: Data(), stderr: Data(), timedOut: false) }
    h.recordChild(getpid(), start: 1)  // the pid is alive, but it started at another time than the agent did
    #expect(h.trustsGone(err(Self.noFile)), "a reused pid kept us on unknown")
    h.recordChild(getpid())  // its own start time: the same process
    #expect(!h.trustsGone(err(Self.noFile)))
  }

  @Test func twoPanesInTheSessionAreNotNone() {
    let h = host { argv in
      if argv.contains("show-option") { return self.err("invalid option") }
      if argv.contains("list-panes") { return RunResult(status: 0, stdout: Data("%1\n%2\n".utf8), stderr: Data(), timedOut: false) }
      return self.err("unexpected \(argv)")
    }
    h.loadPane()
    if case .unknown = h.readPane() {} else { Issue.record("two panes and none recorded read as none: a new window would open beside the agent") }
    // control: one pane is ours, and a session with no pane is none
    let one = host { argv in
      if argv.contains("show-option") { return self.err("invalid option") }
      if argv.contains("list-panes") { return RunResult(status: 0, stdout: Data("%7\n".utf8), stderr: Data(), timedOut: false) }
      return RunResult(status: 0, stdout: Data(), stderr: Data(), timedOut: false)
    }
    one.loadPane()
    #expect(one.supervisedPaneId == "%7")
    let none = host { argv in
      if argv.contains("list-panes") { return RunResult(status: 0, stdout: Data(), stderr: Data(), timedOut: false) }
      return self.err("invalid option")
    }
    none.loadPane()
    if case .gone = none.readPane() {} else { Issue.record("a session with no panes is none") }
  }


  /// The thread sessions' side (`WorkerManager.goneForSure`): the same rule.
  @Test(.enabled(if: Rig.hasTmux)) func aThreadsRefusedSocketWithItsAgentAliveIsNotGone() throws {
    let r = try WorkerRig()
    defer { r.teardown() }
    func err(_ t: String) -> RunResult { RunResult(status: 1, stdout: Data(), stderr: Data(t.utf8), timedOut: false) }
    for text in ["no server running on /tmp/tmux-501/x", "error connecting to /tmp/tmux-501/x (No such file or directory)"] {
      #expect(!r.mgr.goneForSure(err(text), group: getpgrp()), "\(text): the thread's agent group is alive")
    }
    #expect(r.mgr.goneForSure(err("can't find session: t-trip"), group: getpgrp()), "tmux answered")
  }
}
