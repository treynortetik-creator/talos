import Foundation
import Testing
import TalosDesktopCore
import TalosSupervisor

/// Regression tests for the dev-channel guard, through real tmux on the rig's private socket, real ptys and the
/// fake-claude fixtures. Every signal goes to a pid or group this test started. A failure is a finding.

/// LiveSystem with a few pids' snapshots replaced: stands in for pid reuse, which a test can't force.
final class RecyclingProbe: SystemProbe, @unchecked Sendable {
  let base: LiveSystem
  private let lock = NSLock()
  private var fakes: [Int32: ProcessSnapshot] = [:]
  init(base: LiveSystem) { self.base = base }
  func fake(_ s: ProcessSnapshot) { lock.withLock { fakes[s.pid] = s } }
  func snapshot(_ pid: Int32) -> ProcessSnapshot? { lock.withLock { fakes[pid] } ?? base.snapshot(pid) }
  func psInfo(_ pid: Int32) -> PsInfo? { base.psInfo(pid) }
  func readFile(_ path: String) -> Data? { base.readFile(path) }
  func modifiedAt(_ path: String) -> Double? { base.modifiedAt(path) }
  func isExecutable(_ path: String) -> Bool { base.isExecutable(path) }
  func agents(claude: String, env: [String: String]) -> [AgentEntry]? { base.agents(claude: claude, env: env) }
  func cliVersion(claude: String, env: [String: String]) -> String? { base.cliVersion(claude: claude, env: env) }
  func loginShellEnv() -> [String: String]? { base.loginShellEnv() }
  func post(command: [String], thread: String, text: String, env: [String: String]) -> Bool {
    base.post(command: command, thread: thread, text: text, env: env)
  }
}

extension Rig {
  func tmuxRun(_ args: [String]) -> RunResult {
    ProcessRunner.run([Rig.tmuxPath!, "-L", socket, "-f", Rig.tmuxConf] + args, env: loginEnv)
  }

  /// SIGKILLs the fake agent's group, only after checking it is the group of the fake this test launched.
  func killFakeAgent(_ pid: Int32) {
    guard let s = ProcessInspect.snapshot(pid), s.pgid == pid, s.commandLine.contains("fake-claude") else {
      Issue.record("refusing to signal \(pid): not our fake")
      return
    }
    killpg(pid, SIGKILL)
  }
}

@Suite("Review D1: tmux pane targeting", .serialized, .enabled(if: Rig.hasTmux))
struct ReviewD1TmuxTests {
  /// tmux.conf keeps the default prefix table and `mouse on` (right-click menu: Split, Kill, Respawn). The owner in
  /// the D2 viewer presses prefix-% once. Every supervisor command targets `=agent:` = the session's ACTIVE pane, so
  /// from then on the supervisor reads, polls and would type into the owner's new pane, never the agent's.
  @Test func aSecondPaneInTheAgentSessionDoesNotBlindTheSupervisor() throws {
    let r = try Rig(.tmux, scenario: "dev-dialog.sh")
    defer { r.teardown() }
    try coldStartConfirmed(r)
    let pid = try #require(r.sup.status.childPid)
    let split = r.tmuxRun(["split-window", "-t", "=agent:", "--", "/bin/sleep", "60"])
    #expect(split.ok, "split-window: \(split.err)")
    usleep(600_000)
    r.killFakeAgent(pid)  // the agent crashes
    #expect(
      r.wait(10) { r.starts.count >= 2 || r.phase() != .running },
      "the agent died but the supervisor still says \(r.phase()) (it is watching the other pane)")
  }

  /// Nothing stops two supervisors on one tmux session (a dev build and ~/Applications/Talos.app, `open -n`, or an
  /// Option C controller that makes two for one thread): both attach, both see the crash, both respawn, and both may
  /// press Enter on the same dialog. 4.4 allows exactly one Enter per restart.
  @Test func twoSupervisorsOnOneSessionRestartAndConfirmOnce() throws {
    let r = try Rig(.tmux, scenario: "crash-after.sh", env: ["FAKE_CRASH_SECONDS": "4"])
    defer { r.teardown() }
    let s1 = r.sup!
    try coldStartConfirmed(r)
    let s2 = r.makeSupervisor()
    defer { s2.detach(); s1.detach() }
    s2.startTicking()
    s2.attachOrStart(allowColdStart: false)
    #expect(r.wait(5) { s2.status.startKind == .attached })
    #expect(r.wait(25) { r.starts.count >= 2 }, "restarted")
    usleep(8_000_000)
    let enters = r.audit.components(separatedBy: " auto_confirm ").count - 1
    #expect(r.starts.count == 2, "\(r.starts.count) starts: \(r.starts)")
    #expect(enters <= 1, "\(enters) auto-confirm Enters for one restart")
  }

  /// Option C names sessions `t-<thread_id>`; nothing enforces `TmuxCommands.isValidSessionName`. With a name tmux
  /// accepts but can't target (`.` / `:`), start() creates the session, then can't find it, throws "exited
  /// immediately" and leaves the agent running unseen: a second claude (and its pollers) no supervisor knows about.
  @Test(arguments: ["t-a.b", "t-c:d"])
  func aSessionNameTmuxCannotTargetLeavesNoOrphan(name: String) throws {
    let r = try Rig(.tmux, scenario: "dev-dialog.sh")
    defer { r.teardown() }
    let h = TmuxPtyHost(
      commands: TmuxCommands(tmux: Rig.tmuxPath!, socket: r.socket, configPath: Rig.tmuxConf, session: name),
      baseEnv: r.loginEnv, pollInterval: 0.2)
    let env = LoginShellEnv.build(shellEnv: r.loginEnv, overrides: r.config.env)
    var started = true
    do {
      try h.start(executable: Rig.fixtures + "/claude", args: ["--session-id", Rig.sessionId], env: env, cwd: r.agentDir)
    } catch { started = false }
    usleep(500_000)
    let panes = r.tmuxRun(["list-panes", "-a", "-F", "#{session_name}|#{pane_pid}|#{pane_dead}"]).out
    if started {
      #expect(h.sessionExists() && h.childPid != nil, "started but untargetable: \(panes)")
    } else {
      #expect(!panes.contains("\(name)|"), "start failed yet left a live pane nobody supervises: \(panes)")
    }
    h.detach()
  }
}

@Suite("Review D1: takeover whitelist", .serialized)
struct ReviewD1TakeoverTests {
  /// ourPgids = signaller groups ∪ previousChildPgid ∪ launch.childPid, by number only, and neither is cleared after
  /// Stop. Once that pid number is reused (macOS wraps pids about daily on a busy box), an owner's Terminal session
  /// that got it, and its Telegram poller in that group, are invisible to 4.2: Start launches a second poller that
  /// steals Telegram. The just-exited child must be matched by leader start time, not by number.
  @Test func aStoppedChildsRecycledPgidIsNotWhitelisted() throws {
    let kind: HostKind = Rig.hasTmux ? .tmux : .direct
    let r = try Rig(kind, scenario: "dev-dialog.sh")
    defer { r.teardown() }
    let env = r.loginEnv
    let probe = RecyclingProbe(base: LiveSystem(loginEnv: { env }))
    let o = Supervisor.Options(
      name: "agent", configPath: r.configPath, home: r.home, talosAppHome: r.talosHome, auditLogPath: r.auditPath)
    let sup = Supervisor(options: o, host: r.host, probe: probe, timings: r.timings, random: { 0 })
    defer { sup.detach() }
    sup.startTicking()
    sup.start()
    #expect(r.wait(10) { r.screenContains(DialogMatcher.Strings.devTitle) })
    #expect(r.wait(5) { sup.status.needsYou == .confirmColdStart })
    r.humanEnter()
    #expect(r.wait(10) { sup.status.phase == .running }, "\(sup.status.phase)")
    let old = try #require(sup.status.childPid)
    sup.stop()
    #expect(r.wait(10) { stopReason(sup.status.phase) == .user && !ProcessInspect.alive(old) })

    // Later: the owner's own session got pid `old` (its group), and its poller wrote bot.pid.
    let poller = try r.spawn([Rig.fixtures + "/holder.sh"], commandLineHas: "server.ts")
    try "\(poller)".write(toFile: r.botPidPath, atomically: true, encoding: .utf8)
    let real = try #require(ProcessInspect.basic(poller))
    probe.fake(
      ProcessSnapshot(
        pid: poller, ppid: old, pgid: old, startTime: real.startTime, argv: ["bun", "run", "--cwd", "plugin", "server.ts"],
        cwd: "/elsewhere"))
    probe.fake(ProcessSnapshot(pid: old, ppid: 1, pgid: old, startTime: real.startTime, argv: ["claude", "--channels", "x"], cwd: "/elsewhere"))
    #expect(!sup.takeoverBlockers().isEmpty, "a live poller in a recycled group was whitelisted as ours")
    // Control: the same poller in any other group number blocks, so the whitelist is the only reason it didn't.
    probe.fake(
      ProcessSnapshot(
        pid: poller, ppid: 1, pgid: 99_998, startTime: real.startTime, argv: ["bun", "run", "--cwd", "plugin", "server.ts"],
        cwd: "/elsewhere"))
    #expect(sup.takeoverBlockers().map(\.resource) == [.telegram], "control")
  }
}

@Suite("Review D1: rollback command through a real shell")
struct ReviewD1RollbackTests {
  /// Copy Terminal command is pasted into a shell. Metacharacters in any field must reach claude verbatim, and run
  /// nothing.
  @Test func renderedCommandRunsExactlyTheFieldsInZsh() throws {
    let root = Rig.realPath(NSTemporaryDirectory()) + "/talos-rv61-\(UUID().uuidString.prefix(8))"
    let dir = root + "/agent dir 'q' $(x)"
    try FileManager.default.createDirectory(atPath: dir, withIntermediateDirectories: true)
    defer { try? FileManager.default.removeItem(atPath: root) }
    let prog = root + "/bin/claude"
    try FileManager.default.createDirectory(atPath: root + "/bin", withIntermediateDirectories: true)
    try "#!/bin/bash\nprintf '%s\\0' \"$PWD\" \"$X\" \"$@\" > \"\(root)/out\"\n".write(
      toFile: prog, atomically: true, encoding: .utf8)
    chmod(prog, 0o755)
    let args = ["--a", "$(touch \(root)/pwn1)", "x;touch \(root)/pwn2", "it's", "`touch \(root)/pwn3`", "*", "l1\nl2"]
    let x = "v'$(touch \(root)/pwn4)\""
    let spec = LaunchSpec(agentDir: dir, env: ["X": x], program: prog, args: args, resumeId: Rig.sessionId)
    let r = ProcessRunner.run(["/bin/zsh", "-f", "-c", spec.render()], env: ["PATH": "/usr/bin:/bin"], cwd: root)
    #expect(r.ok, "\(r.err)")
    let out = (try? Data(contentsOf: URL(fileURLWithPath: root + "/out"))) ?? Data()
    let fields = out.split(separator: 0, omittingEmptySubsequences: false).map { String(decoding: $0, as: UTF8.self) }
    #expect(Array(fields.prefix(fields.count - 1)) == [dir, x] + args + ["--resume", Rig.sessionId])
    for n in 1...4 { #expect(!FileManager.default.fileExists(atPath: "\(root)/pwn\(n)"), "pwn\(n) ran") }
  }

  /// Pasted into a shell a Claude session spawned (markers set), the rendered command must hand claude none of them,
  /// and still hand it the owner's own CLAUDE_EFFORT.
  @Test func renderedCommandRunsCleanInAShellHoldingSessionMarkers() throws {
    let root = Rig.realPath(NSTemporaryDirectory()) + "/talos-mk-\(UUID().uuidString.prefix(8))"
    try FileManager.default.createDirectory(atPath: root + "/bin", withIntermediateDirectories: true)
    defer { try? FileManager.default.removeItem(atPath: root) }
    let prog = root + "/bin/claude"
    try "#!/bin/bash\n/usr/bin/env > \"\(root)/envout\"\n".write(toFile: prog, atomically: true, encoding: .utf8)
    chmod(prog, 0o755)
    let spec = LaunchSpec(agentDir: root, env: ["CLAUDE_EFFORT": "high"], program: prog, args: [], resumeId: nil)
    var polluted = ["PATH": "/usr/bin:/bin", "CLAUDE_EFFORT": "low", "KEEPME": "1"]
    for k in ClaudeEnvScrub.sessionMarkers.union(["CLAUDECODE", "CLAUDE_PID"]) { polluted[k] = "x" }
    let r = ProcessRunner.run(["/bin/zsh", "-f", "-c", spec.render()], env: polluted, cwd: root)
    #expect(r.ok, "\(r.err)")
    let got = (try? String(contentsOfFile: root + "/envout", encoding: .utf8)) ?? ""
    let names = Set(got.split(separator: "\n").compactMap { $0.split(separator: "=", maxSplits: 1).first.map(String.init) })
    for k in polluted.keys where k != "PATH" && k != "KEEPME" && k != "CLAUDE_EFFORT" { #expect(!names.contains(k), "\(k) reached claude") }
    #expect(got.contains("KEEPME=1"))
    #expect(got.contains("CLAUDE_EFFORT=high"), "the owner's setting wins over the inherited one")
  }
}
