import Foundation
import Testing
import TalosDesktopCore
import TalosTestSupport

@testable import TalosSupervisor

/// The host's judgments against a scripted tmux: nothing here starts a real tmux or an agent, so each case is fast and exact. What tmux
/// answers, and how long the host was willing to wait for it, is what is recorded.
@Suite("tmux host against a scripted tmux", .serialized)
struct TmuxUnknownUnitTests {
  final class Script: @unchecked Sendable {
    private let lock = NSLock()
    private var _calls: [(argv: [String], timeout: Double)] = []
    var reply: @Sendable ([String]) -> RunResult = { _ in Script.ok("") }
    var calls: [(argv: [String], timeout: Double)] { lock.withLock { _calls } }
    func record(_ argv: [String], _ timeout: Double) { lock.withLock { _calls.append((argv, timeout)) } }
    func count(_ word: String) -> Int { calls.filter { $0.argv.contains(word) }.count }
    static func ok(_ out: String) -> RunResult { RunResult(status: 0, stdout: Data(out.utf8), stderr: Data(), timedOut: false) }
    static func fail(_ err: String) -> RunResult { RunResult(status: 1, stdout: Data(), stderr: Data(err.utf8), timedOut: false) }
    static var timeout: RunResult { RunResult(status: 15, stdout: Data(), stderr: Data(), timedOut: true) }
  }

  private func host(_ script: Script) -> (TmuxPtyHost, String) {
    let dir = NSTemporaryDirectory() + "talos-unit-\(UUID().uuidString.prefix(8))"
    try? FileManager.default.createDirectory(atPath: dir, withIntermediateDirectories: true, attributes: [.posixPermissions: 0o700])
    let h = TmuxPtyHost(
      commands: TmuxCommands(tmux: "/usr/bin/true", socket: "talos-test-\(getpid())-unit\(UInt32.random(in: 0..<UInt32.max))", configPath: "/dev/null"),
      launchDir: dir, baseEnv: [:], pollInterval: 60,
      runner: { argv, _, timeout in
        script.record(argv, timeout)
        return argv.first == "/bin/ps" ? ProcessRunner.run(argv, env: ["PATH": "/usr/bin:/bin"]) : script.reply(argv)
      },
      sendSignal: { _, _ in })
    h.boundedReadDeadline = 0.3  // per host: a bounded read gives up soon
    return (h, dir)
  }

  private func row(pid: Int32, dead: Bool = false) -> String { "\(dead ? 0 : pid)|\(dead ? 1 : 0)|||1700000000|1700000000|%1" }

  /// tmux with a live agent in pane %1.
  private func live(_ pid: Int32 = getpid()) -> Script {
    let s = Script()
    s.reply = { argv in
      if argv.contains("show-option") || argv.contains("show-options") { return Script.ok("%1") }
      if argv.contains("display-message") { return Script.ok(self.row(pid: pid)) }
      return Script.ok("")
    }
    return s
  }

  private func launchFiles(_ dir: String) -> Int { ((try? FileManager.default.contentsOfDirectory(atPath: dir)) ?? []).count }

  // MARK: R1-1 the launch commands are three-valued

  @Test func restartNeverRespawnsALivePane() {
    let s = live()
    let (h, _) = host(s)
    h.recordChild(getpid())  // the live agent in %1 is the recorded one
    #expect(throws: PtyHostError.alreadyRunning) { try h.restart(executable: "/bin/true", args: [], env: [:], cwd: "/") }
    #expect(s.count("respawn-pane") == 0 && s.count("new-window") == 0 && s.count("new-session") == 0, "a launch was sent over a live pane")
  }

  @Test func aTimedOutLaunchCommandIsLaunchedUnknownNotAFailedStartAndKeepsItsFile() {
    for answer in [Script.timeout, Script.fail("no server running on /tmp/tmux-501/x")] {
      let s = Script()
      s.reply = { argv in
        if argv.contains("has-session") { return Script.fail("can't find session: agent") }
        if argv.contains("new-session") { return answer }
        return Script.ok("")
      }
      let (h, dir) = host(s)
      #expect(throws: PtyHostError.paneUnreadable(launched: true)) { try h.start(executable: "/bin/true", args: [], env: [:], cwd: "/") }
      #expect(launchFiles(dir) == 1, "the launch file was removed although the pane may not have read it")
    }
  }

  @Test func aFailureTmuxReportedItselfIsAFailedStartAndRemovesItsFile() {
    let s = Script()
    s.reply = { argv in
      if argv.contains("has-session") { return Script.fail("can't find session: agent") }
      if argv.contains("new-session") { return Script.fail("duplicate session: agent") }
      return Script.ok("")
    }
    let (h, dir) = host(s)
    #expect(throws: PtyHostError.startFailed("duplicate session: agent")) { try h.start(executable: "/bin/true", args: [], env: [:], cwd: "/") }
    #expect(launchFiles(dir) == 0)
  }

  // MARK: R1-2 not launched is not launched

  @Test func anUnansweredSessionBeforeAnyLaunchIsNotLaunchedAndSendsNothing() {
    let s = Script()
    s.reply = { _ in Script.timeout }
    let (h, dir) = host(s)
    #expect(throws: PtyHostError.paneUnreadable(launched: false)) { try h.start(executable: "/bin/true", args: [], env: [:], cwd: "/") }
    #expect(throws: PtyHostError.paneUnreadable(launched: false)) { try h.restart(executable: "/bin/true", args: [], env: [:], cwd: "/") }
    #expect(s.count("new-session") == 0 && s.count("respawn-pane") == 0 && s.count("new-window") == 0)
    #expect(launchFiles(dir) == 0)
    // the owner's Start anyway lets exactly one start through
    h.allowStartOverUnknown()
    _ = try? h.start(executable: "/bin/true", args: [], env: [:], cwd: "/")
    #expect(s.count("new-session") == 1, "Start anyway did not start")
    #expect(throws: PtyHostError.paneUnreadable(launched: false)) { try h.start(executable: "/bin/true", args: [], env: [:], cwd: "/") }
  }

  @Test func adoptPendingWithNoPaneIdFindsItBySessionAndNeverSaysGoneOnAnUnansweredLookup() {
    // the session cannot be asked about
    let a = Script()
    a.reply = { _ in Script.timeout }
    #expect(host(a).0.adoptPending() == .unknown)
    // the session is there but no pane can be told: unknown, never gone
    let b = Script()
    b.reply = { argv in argv.contains("has-session") ? Script.ok("") : Script.timeout }
    #expect(host(b).0.adoptPending() == .unknown)
    // tmux says there is no such session
    let c = Script()
    c.reply = { _ in Script.fail("can't find session: agent") }
    if case .gone = host(c).0.adoptPending() {} else { Issue.record("a session tmux says is not there is gone") }
    // one pane, found by session, alive
    let pid = getpid()
    let d = Script()
    d.reply = { argv in
      if argv.contains("show-option") || argv.contains("show-options") { return Script.fail("invalid option") }
      if argv.contains("list-panes") { return Script.ok("%1\n") }
      if argv.contains("display-message") { return Script.ok(self.row(pid: pid)) }
      return Script.ok("")
    }
    let (hd, _) = host(d)
    #expect(hd.adoptPending() == .adopted(pid: pid))
    // an agent that started before this launch is not this launch's
    let (he, _) = host(d)
    he.lastLaunchAt = Date().addingTimeInterval(3600)
    #expect(he.adoptPending() == .olderAgent(pid: pid))
  }

  @Test func aSessionThatIsThereWithAnUnreadPaneIsUnknownNotNotRunning() {
    let s = Script()
    s.reply = { argv in
      if argv.contains("has-session") { return Script.ok("") }
      if argv.contains("show-option") || argv.contains("show-options") { return Script.ok("%1") }
      return Script.timeout
    }
    #expect(host(s).0.attachState() == .unknown)
  }

  // MARK: R1-3 the leader decides

  @Test func aDeadLeaderWithALiveGroupIsGone() throws {
    // a group leader that exits, leaving a member that ignores the hangup in its group
    let p = Process()
    p.executableURL = URL(fileURLWithPath: "/usr/bin/perl")
    p.arguments = ["-e", "setpgrp(0,0); system('sleep 60 &'); exit 0;"]
    try p.run()
    p.waitUntilExit()
    let leader = p.processIdentifier
    defer { killpg(leader, SIGKILL) }
    #expect(ProcessInspect.groupAlive(leader), "control: the group still has a member")
    let (h, _) = host(Script())
    h.recordChild(leader, start: 1)
    #expect(h.recordedAgentAlive() == false, "a dead Main with a surviving child counted as alive")
    let refused = Script.fail("error connecting to /tmp/tmux-501/x (No such file or directory)")
    #expect(h.trustsGone(refused))
    // the worker side judges the leader too
    let probe = LiveSystem(loginEnv: { nil })
    let g = GroupSignaller(probe: probe)
    #expect(!g.leaderAlive(leader))
  }

  // MARK: R1-5 the server scan

  @Test func theServerScanOnlyCountsAServerOfOurSocket() {
    let socket = "talos"
    func has(_ lines: [String]) -> Bool { TmuxPtyHost.listsServer(lines.joined(separator: "\n"), socket: socket) }
    #expect(has(["/opt/homebrew/bin/tmux -L talos -f /x/tmux.conf new-session -d -s agent"]))
    #expect(!has(["/opt/homebrew/bin/tmux -L talos has-session -t =agent"]), "a client is not a server")
    #expect(!has(["/opt/homebrew/bin/tmux -L talos-2 -f /x/tmux.conf new-session -d"]), "another socket")
    #expect(!has(["/bin/zsh -c echo ' -L talos '"]), "a quoted command is not tmux")
    #expect(!has(["/usr/bin/vim notes -L talos"]), "argv[0] is not tmux")
    #expect(!has([]))
  }

  // MARK: R1-6 an unconfirmed kill-session is not a stop

  @Test func closeCheckedSaysWhetherTmuxConfirmedTheKill() {
    for (answer, expected) in [(Script.ok(""), true), (Script.fail("can't find session: agent"), true), (Script.timeout, false),
      (Script.fail("no server running on /tmp/tmux-501/x"), false)]
    {
      let s = Script()
      s.reply = { _ in answer }
      let (h, _) = host(s)
      h.recordChild(getpid())  // alive: a refusal is not proof of anything
      #expect(h.closeChecked() == expected, "\(answer)")
    }
  }

  // MARK: R1-8 the start time is a number

  @Test func theRecordedStartIsNumericFromTheProcessTable() {
    let (h, _) = host(Script())
    h.recordChild(getpid())
    #expect(h.recordedAgentAlive() == true)
    // a different recorded start (as after a pid reuse) is another process, whatever the clock zone says: nothing here reads local-time text
    h.recordChild(getpid(), start: (ProcessInspect.basic(getpid())?.startTime ?? 0) + 3600)
    #expect(h.recordedAgentAlive() == false)
  }

  // MARK: below the cap

  @Test func everyLookIsBoundedSoTheQueueIsNeverHeldForLong() {
    let s = Script()
    s.reply = { _ in Script.timeout }
    let (h, _) = host(s)
    _ = h.attachState()
    _ = h.adoptPending()
    let tmuxCalls = s.calls.filter { $0.argv.first != "/bin/ps" }
    #expect(!tmuxCalls.isEmpty)
    #expect(tmuxCalls.first?.timeout == TmuxPtyHost.boundedReadTimeout, "the first look is short")
    #expect(tmuxCalls.allSatisfy { $0.timeout <= TmuxPtyHost.boundedReadTimeoutMax }, "a look used the 10 s default: \(tmuxCalls.map(\.timeout))")
  }

  // MARK: R2-1 a new-window that did not answer

  /// The old pane is gone, the session lives on with another pane in it, and the new-window ran but did not answer: the look must not be made at
  /// the OLD pane id (that reads "gone" and opens a second window). The pane is found by what started after the launch; none or several is unknown.
  @Test func aTimedOutNewWindowIsNeverReadAsGoneFromTheOldPaneAndOpensNoSecondWindow() {
    let s = Script()
    s.reply = { argv in
      if argv.contains("new-window") { return Script.timeout }
      if argv.contains("show-option") || argv.contains("show-options") { return Script.ok("%1") }
      if argv.contains("list-panes") { return Script.ok("%2\n%9\n") }
      if argv.contains("display-message") { return Script.ok("||||||") }  // %1 is gone; the others cannot be told
      return Script.ok("")
    }
    let (h, _) = host(s)
    #expect(throws: PtyHostError.paneUnreadable(launched: true)) { try h.restart(executable: "/bin/true", args: [], env: [:], cwd: "/") }
    #expect(h.adoptPending() == .unknown, "the old pane's gone was taken for this launch's")
    #expect(throws: PtyHostError.paneUnreadable(launched: false)) { try h.restart(executable: "/bin/true", args: [], env: [:], cwd: "/") }
    #expect(s.count("new-window") == 1, "a second window was opened beside the agent")
  }
}

extension TmuxUnknownUnitTests {
  /// A tmux that answers slowly (here 2.5 s, over the first look's 1 s) is read once the wait has grown: never "unknown" forever.
  @Test func aSlowTmuxIsReadOnceTheWaitHasGrown() {
    let s = Script()
    s.reply = { argv in
      // answers only when given more than 2 s, like a tmux that takes 2.5 s
      Script.ok("")
    }
    let (h, _) = host(s)
    #expect(h.readTimeout() == TmuxPtyHost.boundedReadTimeout)
    // two unanswered looks double it, four double it again, and an answer brings it back
    s.reply = { _ in Script.timeout }
    _ = h.readSession(timeout: 1)
    _ = h.readSession(timeout: 1)
    #expect(h.readTimeout() == 2 * TmuxPtyHost.boundedReadTimeout)
    _ = h.readSession(timeout: 1)
    _ = h.readSession(timeout: 1)
    #expect(h.readTimeout() == 4 * TmuxPtyHost.boundedReadTimeout)
    s.reply = { _ in Script.ok("") }
    for _ in 0..<5 { h.noteLook(answered: true) }  // it comes back down slowly: one level for every 5 answers
    #expect(h.readTimeout() == 2 * TmuxPtyHost.boundedReadTimeout)
    for _ in 0..<10 { h.noteLook(answered: true) }
    #expect(h.readTimeout() == TmuxPtyHost.boundedReadTimeout)
  }
}

extension TmuxUnknownUnitTests {
  // MARK: R3-1 every live pane is refused

  /// An app attached to Main (nothing launched by this host), Main died, and somebody started another agent in the same pane before the
  /// restart: that live pane is refused, whoever's it is. Nothing proves it is not an agent in use.
  @Test func aRestartRefusesEveryLivePaneEvenOneItCannotIdentify() {
    let s = live()
    let (h, _) = host(s)
    h.recordChild(99_998, start: 1)  // the dead agent
    #expect(throws: PtyHostError.alreadyRunning) { try h.restart(executable: "/bin/true", args: [], env: [:], cwd: "/") }
    #expect(s.count("respawn-pane") == 0)
    // with a launch recorded, and a clock stepped back between the launch and the fork
    let s2 = live()
    let (h2, _) = host(s2)
    h2.lastLaunchAt = Date(timeIntervalSince1970: (ProcessInspect.basic(getpid())?.startTime ?? 0) + 10)
    #expect(throws: PtyHostError.alreadyRunning) { try h2.restart(executable: "/bin/true", args: [], env: [:], cwd: "/") }
    #expect(s2.count("respawn-pane") == 0)
  }

  // MARK: R3-2 a new-window that never ran

  @Test func aNewWindowThatNeverRanIsLaunchedAgainAfterTheGraceNotBefore() {
    let s = Script()
    s.reply = { argv in
      if argv.contains("new-window") { return Script.timeout }
      if argv.contains("show-option") || argv.contains("show-options") { return Script.ok("%1") }
      if argv.contains("list-panes") { return Script.ok("%2\n") }
      if argv.contains("display-message") { return argv.contains("%2") ? Script.ok(self.row(pid: 1)) : Script.ok("||||||") }
      return Script.ok("")
    }
    let (h, _) = host(s)
    #expect(throws: PtyHostError.paneUnreadable(launched: true)) { try h.restart(executable: "/bin/true", args: [], env: [:], cwd: "/") }
    #expect(h.adoptPending() == .unknown, "inside the grace the pane is unresolved, never launched again")
    h.lastLaunchAt = Date().addingTimeInterval(-(TmuxPtyHost.newWindowGrace + 5))
    #expect(h.adoptPending() == .notLaunched, "every pane answered and none is new, long after: it never ran")
  }

  // MARK: R3-3 one look is capped

  @Test func oneLookNeverWaitsPastItsBudgetAndSpentLooksAskNothing() {
    let s = Script()
    s.reply = { _ in Script.timeout }
    let (h, _) = host(s)
    for _ in 0..<10 { h.noteLook(answered: false) }  // the adaptive wait is at its top
    h.beginLook(budget: 0.5)
    #expect(h.lookTimeout() <= 0.5, "a read may not wait longer than what is left of the look")
    Thread.sleep(forTimeInterval: 0.6)
    #expect(h.lookExpired)
    let before = s.calls.count
    if case .unknown = h.readPane() {} else { Issue.record("a spent look read the pane") }
    #expect(h.readSession() == .unknown)
    #expect(s.calls.count == before, "a spent look still asked tmux")
    h.endLook()
    #expect(!h.lookExpired)
  }

  // MARK: R3-4 a dead pane's screen speaks only for a launch that ran

  @Test func aDeadPanesRowsAreHandedOverOnlyWhenThePaneHadOutputAfterTheLaunch() {
    func dead(activity: Double) -> Script {
      let s = Script()
      s.reply = { argv in
        if argv.contains("show-option") || argv.contains("show-options") { return Script.ok("%1") }
        if argv.contains("display-message") { return Script.ok("|1|1||\(activity)|1700000000|%1") }
        if argv.contains("capture-pane") { return Script.ok("No session found with ID: abc\n") }
        return Script.ok("")
      }
      return s
    }
    let launch = Date()
    let (old, _) = host(dead(activity: launch.timeIntervalSince1970 - 3600))  // the screen of an earlier run
    old.lastLaunchAt = launch
    if case .gone(let rows) = old.adoptPending() { #expect(rows.isEmpty, "an earlier run's screen was taken for this launch's") } else { Issue.record("not gone") }
    let (fresh, _) = host(dead(activity: launch.timeIntervalSince1970 + 1))
    fresh.lastLaunchAt = launch
    if case .gone(let rows) = fresh.adoptPending() { #expect(rows.contains { $0.contains("No session found") }) } else { Issue.record("not gone") }
  }
}

extension TmuxUnknownUnitTests {
  // MARK: a spent look still counts as unanswered

  @Test func aReadSkippedBecauseTheLookIsSpentCountsAsUnanswered() {
    let s = live()
    let (h, _) = host(s)
    h.beginLook(budget: 0.01)
    Thread.sleep(forTimeInterval: 0.05)
    let before = s.calls.count
    _ = h.readPane()
    _ = h.readSession()
    #expect(s.calls.count == before, "a spent look asked tmux")
    #expect(h.unansweredStreak == 2, "the skipped reads were not counted: \(h.unansweredStreak)")
  }

  /// A tmux that hangs on every call (each uses its whole wait) under a running agent: the looks are cut by the budget and still counted.
  @Test func aHungTmuxIsCountedWithinTheLookBudget() {
    let s = Script()
    s.reply = { argv in
      if argv.contains("has-session") { return Script.ok("") }
      if argv.contains("show-option") || argv.contains("show-options") { return Script.ok("%1") }
      Thread.sleep(forTimeInterval: 0.08)  // a call that hangs (and is then cut by its wait)
      return Script.timeout
    }
    let (h, _) = host(s)
    h.setLookBudget(0.3)
    h.boundedReadDeadline = 5
    let started = Date()
    #expect(h.attachState() == .unknown)
    #expect(Date().timeIntervalSince(started) < 2, "one look held far past its budget")
    #expect(h.unansweredStreak > 0, "a hung tmux never counted")
  }
}

