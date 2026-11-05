import Foundation
import SwiftTerm
import Testing
import TalosDesktopCore
@testable import TalosSupervisor

/// D2 review: the viewer's real pty into a real tmux server on the Rig's private socket, under the app's real tmux.conf.
private final class Viewer: LocalProcessDelegate, @unchecked Sendable {
  private let lock = NSLock()
  private var _exit: Int32??
  var exited: Bool { lock.withLock { _exit != nil } }
  func processTerminated(_ source: LocalProcess, exitCode: Int32?) { lock.withLock { _exit = .some(exitCode) } }
  func dataReceived(slice: ArraySlice<UInt8>) {}
  func getWindowSize() -> winsize { winsize(ws_row: 40, ws_col: 120, ws_xpixel: 0, ws_ypixel: 0) }
}

private func attach(_ r: Rig, _ d: Viewer) -> LocalProcess {
  let argv = TmuxCommands(tmux: Rig.tmuxPath!, socket: r.socket, configPath: Rig.tmuxConf).attach()
  var env = r.loginEnv
  env["TMUX"] = nil
  env["TERM"] = "xterm-256color"
  let p = LocalProcess(delegate: d, dispatchQueue: DispatchQueue(label: "rv-viewer"))
  p.startProcess(executable: argv[0], args: Array(argv.dropFirst()), environment: env.keys.sorted().map { "\($0)=\(env[$0] ?? "")" })
  return p
}

private func tmux(_ r: Rig, _ a: String...) -> String {
  ProcessRunner.run([Rig.tmuxPath!, "-L", r.socket, "-f", Rig.tmuxConf] + a, env: r.loginEnv).out
}

private func sgr(_ button: Int, _ x: Int, _ y: Int, press: Bool = true) -> ArraySlice<UInt8> {
  Array("\u{1B}[<\(button);\(x);\(y)\(press ? "M" : "m")".utf8)[...]
}

@Suite("Review D2: viewer (real tmux, private socket)", .serialized, .enabled(if: Rig.hasTmux))
struct ReviewD2ViewerTests {
  /// D1-REVIEW finding 1 asked for a viewer, not a workspace. The conf clears the prefix table and the right-click menus but
  /// tmux 3.8's root table keeps structural mouse bindings and the middle-click paste.
  @Test func theRootKeyTableHasNothingThatEditsTheSessionOrTypes() throws {
    let r = try Rig(.tmux, scenario: "dev-dialog.sh")
    defer { r.teardown() }
    r.start()
    #expect(r.wait(10) { r.screenContains(DialogMatcher.Strings.devTitle) })
    let keys = tmux(r, "list-keys", "-T", "root")
    let bad = keys.split(separator: "\n").filter { line in
      ["new-pane", "move-pane", "break-pane", "join-pane", "swap-window", "paste-buffer", "new-window", "split-window"]
        .contains { line.contains($0) }
    }
    #expect(bad.isEmpty, "\(bad.joined(separator: "\n"))")
  }

  /// Ctrl-drag in the terminal window (SwiftTerm forwards it as SGR with the ctrl bit) opens a new pane inside the supervised
  /// session. tmux runs a login shell in the agent's window, next to the live agent.
  @Test func aCtrlDragInTheViewerDoesNotAddAPane() throws {
    let r = try Rig(.tmux, scenario: "dev-dialog.sh")
    defer { r.teardown() }
    try coldStartConfirmed(r)
    let d = Viewer()
    let v = attach(r, d)
    defer { v.terminate() }
    #expect(r.wait(5) { v.running })
    usleep(600_000)
    let agentPane = tmux(r, "display-message", "-p", "-t", "=agent:", "#{pane_id}")
    let before = tmux(r, "list-panes", "-s", "-t", "=agent", "-F", "#{pane_id}").split(separator: "\n").count
    v.send(data: sgr(16, 10, 10))
    usleep(60_000)
    v.send(data: sgr(48, 30, 20))
    usleep(60_000)
    v.send(data: sgr(16, 30, 20, press: false))
    usleep(500_000)
    let after = tmux(r, "list-panes", "-s", "-t", "=agent", "-F", "#{pane_id}").split(separator: "\n").count
    #expect(after == before, "panes \(before) -> \(after)")
    let active = tmux(r, "display-message", "-p", "-t", "=agent:", "#{pane_id}")
    #expect(active == agentPane, "the viewer's keys now go to \(active), not the agent's \(agentPane)")
  }

  /// A middle click (SwiftTerm forwards otherMouseDown) pastes tmux's buffer into the agent as typed input. A double-click
  /// fills that buffer, so the text needs no setup; a Return in it answers whatever is on screen.
  @Test func aMiddleClickTypesNothingIntoTheAgent() throws {
    let r = try Rig(.tmux, scenario: "dev-dialog.sh")
    defer { r.teardown() }
    r.start()
    #expect(r.wait(10) { r.screenContains(DialogMatcher.Strings.devTitle) })
    #expect(r.wait(5) { r.sup.status.needsYou == .confirmColdStart })
    let d = Viewer()
    let v = attach(r, d)
    defer { v.terminate() }
    #expect(r.wait(5) { v.running })
    usleep(600_000)
    _ = tmux(r, "set-buffer", "--", "anything\r")
    v.send(data: sgr(1, 10, 10))
    usleep(60_000)
    v.send(data: sgr(1, 10, 10, press: false))
    usleep(1_500_000)
    #expect(r.config.session.confirmedAt == nil, "a pasted Return answered the dev-channel dialog")
    #expect(r.screenContains(DialogMatcher.Strings.devTitle), "the dialog is still up")
  }

  /// WP-D2 "reviewer writes failing first": typing while the agent restarts. Keys land on a dead pane, then on the dialog.
  @Test func typingThroughARestartLeavesOneCleanRestart() throws {
    var t = Supervisor.Timings()
    t.tick = 0.2
    t.agentsPoll = 0.5
    let r = try Rig(.tmux, scenario: "crash-after.sh", env: ["FAKE_CRASH_SECONDS": "1"], timings: t)
    defer { r.teardown() }
    try coldStartConfirmed(r)
    let d = Viewer()
    let v = attach(r, d)
    defer { v.terminate() }
    #expect(r.wait(5) { v.running })
    let end = Date().addingTimeInterval(9)
    while Date() < end {
      v.send(data: Array("x".utf8)[...])
      usleep(100_000)
    }
    #expect(r.wait(10) { isRunning(r.phase()) }, "\(r.phase())")
    usleep(1_500_000)
    #expect(r.starts.count == 2, "\(r.starts.count) starts")
    #expect(r.sup.status.needsYou == nil, "\(String(describing: r.sup.status.needsYou))")
  }

  /// The owner's Enter and the supervisor's race on the restart dialog: one restart, no second confirm, no refusal. (One
  /// Enter, because the fake runs in cooked mode and echoes: a stream of them scrolls the notice away, which real claude can't.)
  @Test func anEnterOnTheRestartDialogDoesNotDoubleConfirm() throws {
    var t = Supervisor.Timings()
    t.tick = 0.2
    t.agentsPoll = 0.5
    let r = try Rig(.tmux, scenario: "crash-after.sh", env: ["FAKE_CRASH_SECONDS": "1"], timings: t)
    defer { r.teardown() }
    try coldStartConfirmed(r)
    let d = Viewer()
    let v = attach(r, d)
    defer { v.terminate() }
    #expect(r.wait(5) { v.running })
    #expect(r.wait(15) { r.starts.count >= 2 })
    #expect(r.wait(10) { r.screenContains(DialogMatcher.Strings.devTitle) || isRunning(r.phase()) })
    v.send(data: [0x0d][...])
    // An Enter that beats the next tick leaves the supervisor at .starting until noticeWait, then running: slow, not wrong.
    #expect(r.wait(20) { isRunning(r.phase()) }, "\(r.phase())")
    usleep(1_500_000)
    #expect(r.starts.count == 2, "\(r.starts.count) starts")
    #expect(r.sup.status.needsYou == nil, "\(String(describing: r.sup.status.needsYou))")
    #expect(r.audit.components(separatedBy: " auto_confirm ").count - 1 <= 1)
  }

  /// A wheel-up in the viewer puts the pane in copy mode. `send-keys -H` then goes to copy mode, not to the agent, so the
  /// supervisor's one restart Enter is swallowed. OBSERVED: `auto_confirm`, the dialog stays up, `needs_you why=twice`, 15 s
  /// later `auto_confirm_no_notice` and the session is SIGTERMed. Scrolling back to see why it crashed kills the restart.
  @Test func theAutoConfirmEnterIsNotSwallowedByCopyMode() throws {
    var t = Supervisor.Timings()
    t.tick = 0.2
    t.agentsPoll = 0.5
    let r = try Rig(.tmux, scenario: "crash-after.sh", env: ["FAKE_CRASH_SECONDS": "1"], timings: t)
    defer { r.teardown() }
    try coldStartConfirmed(r)
    let d = Viewer()
    let v = attach(r, d)
    defer { v.terminate() }
    #expect(r.wait(5) { v.running })
    let end = Date().addingTimeInterval(12)
    var sawMode = false
    while Date() < end, r.starts.count < 2 || !isRunning(r.phase()) {
      v.send(data: sgr(64, 10, 10))  // the owner scrolling back to see what happened
      usleep(50_000)
      if tmux(r, "display-message", "-p", "-t", "=agent:", "#{pane_in_mode}").hasPrefix("1") { sawMode = true }
    }
    usleep(800_000)
    #expect(sawMode, "control: the pane did enter copy mode")
    // 60 s is only a cap on a hang (the assertion is unchanged). It cannot rescue a swallowed Enter: that ends in
    // `.stopped(.noNotice)` at noticeWait, which is terminal. The Enter reaching the agent is what theOneTmuxProcess… below pins.
    #expect(r.wait(60) { isRunning(r.phase()) && r.sup.status.needsYou == nil }, "\(r.phase()) \(String(describing: r.sup.status.needsYou))")
  }

  /// The cause of the test above, pinned without any timing: `send` must be ONE tmux process. Two (cancel, then send-keys)
  /// leave a gap in which a wheel-up re-enters copy mode and swallows the key. A shim counts the processes that carry
  /// `send-keys`; the pane also really is in copy mode for the second send, and the key still reaches the program.
  @Test func aSendIsOneTmuxProcessAndReachesTheProgramEvenFromCopyMode() throws {
    let root = Rig.realPath((NSTemporaryDirectory() as NSString).appendingPathComponent("talos-send-\(UUID().uuidString.prefix(8))"))
    try FileManager.default.createDirectory(atPath: root, withIntermediateDirectories: true)
    let socket = "talos-test-\(getpid())-\(UInt32.random(in: 0...UInt32.max))"
    let sends = root + "/sends"
    let got = root + "/got"
    let shim = root + "/tmux-count"
    try """
    #!/bin/bash
    for a in "$@"; do
      if [ "$a" = send-keys ]; then echo x >> '\(sends)'; break; fi
    done
    exec '\(Rig.tmuxPath!)' "$@"
    """.write(toFile: shim, atomically: true, encoding: .utf8)
    chmod(shim, 0o755)
    let env = ["PATH": "/usr/bin:/bin:/usr/sbin:/sbin", "HOME": root, "LANG": "en_US.UTF-8", "TMPDIR": NSTemporaryDirectory()]
    let host = TmuxPtyHost(
      commands: TmuxCommands(tmux: shim, socket: socket, configPath: Rig.tmuxConf), baseEnv: env, pollInterval: 0.2)
    let raw = [Rig.tmuxPath!, "-L", socket, "-f", Rig.tmuxConf]
    defer {
      host.close()
      _ = ProcessRunner.run(raw + ["kill-server"], env: env)
      unlink("/tmp/tmux-\(getuid())/\(socket)")
      try? FileManager.default.removeItem(atPath: root)
    }
    try host.start(
      executable: "/bin/sh", args: ["-c", "while read l; do echo \"got:$l\" >> '\(got)'; done"], env: [:], cwd: root)
    let pane = try #require(host.supervisedPaneId)
    func inMode() -> Bool { ProcessRunner.run(raw + ["display-message", "-p", "-t", pane, "#{pane_in_mode}"], env: env).out.hasPrefix("1") }
    func gotText() -> String { (try? String(contentsOfFile: got, encoding: .utf8)) ?? "" }
    func sendCount() -> Int { ((try? String(contentsOfFile: sends, encoding: .utf8)) ?? "").split(separator: "\n").count }
    func waitFor(_ s: String) -> Bool {
      let until = Date().addingTimeInterval(10)
      while Date() < until { if gotText().contains(s) { return true }; usleep(50_000) }
      return gotText().contains(s)
    }
    let base = sendCount()  // start-up may have used send-keys-free commands only; measure from here
    #expect(host.send(keys: Array("a\r".utf8)) == .sent)
    #expect(waitFor("got:a"), "not in a mode: \(gotText())")
    #expect(ProcessRunner.run(raw + ["copy-mode", "-t", pane], env: env).ok)
    #expect(inMode(), "control: the pane is in copy mode")
    #expect(host.send(keys: Array("b\r".utf8)) == .sent)
    #expect(waitFor("got:b"), "in copy mode, the key must reach the program: \(gotText())")
    #expect(!inMode(), "send leaves copy mode")
    #expect(sendCount() - base == 2, "two sends, one tmux process each (was \(sendCount() - base))")
  }

  /// A restart Enter that tmux definitely failed to deliver (an overloaded server: exit 1) is not "the one Enter": it does
  /// not count, the dialog stays up, and the next tick sends it again. Before the fix `send` returned nothing, the supervisor
  /// counted it as pressed, and the restart ended at `auto_confirm_no_notice` (stopped).
  @Test func aRestartEnterThatFailedIsSentAgain() throws {
    var t = Supervisor.Timings()
    t.tick = 0.2
    t.agentsPoll = 0.5
    let r = try Rig(.tmux, scenario: "crash-after.sh", env: ["FAKE_CRASH_SECONDS": "1"], timings: t)
    defer { r.teardown() }
    let flag = r.root + "/fail-next-send"
    let shim = r.root + "/tmux-failsend"
    try """
    #!/bin/bash
    for a in "$@"; do
      if [ "$a" = if-shell ] && [ -f '\(flag)' ]; then rm -f '\(flag)'; echo "error connecting to the socket (Resource temporarily unavailable)" >&2; exit 1; fi
    done
    exec '\(Rig.tmuxPath!)' "$@"
    """.write(toFile: shim, atomically: true, encoding: .utf8)
    chmod(shim, 0o755)
    r.tmuxBin = shim
    r.makeSupervisor()  // not started yet: same socket and config, now talking to tmux through the shim
    FileManager.default.createFile(atPath: flag, contents: nil)  // the restart's first Enter fails; armed before the start so a stalled test thread cannot let it through
    try coldStartConfirmed(r)
    #expect(r.wait(15) { r.starts.count >= 2 })
    #expect(r.wait(20) { r.audit.contains("auto_confirm_send_failed") }, "the shim never fired: \(r.audit)")
    #expect(r.wait(20) { isRunning(r.phase()) && r.sup.status.needsYou == nil }, "\(r.phase()) \(String(describing: r.sup.status.needsYou))")
    #expect(r.starts.count == 2, "\(r.starts.count) starts")
    #expect(r.audit.contains(" auto_confirm "), "the retried Enter was recorded")
  }

  /// One status query that tmux fails without saying the pane is gone (an overloaded server: exit 1 "Resource temporarily
  /// unavailable") is not "the host was lost". Before the fix the poll read it as exactly that: the live agent was reported as
  /// exited with host_lost=1, the next start was forced cold, and a crash restart waited for a human Enter that never came.
  @Test func aFailedStatusQueryIsNotAHostLost() throws {
    var t = Supervisor.Timings()
    t.tick = 0.2
    t.agentsPoll = 0.5
    let r = try Rig(.tmux, scenario: "crash-after.sh", env: ["FAKE_CRASHES": "0"], timings: t)
    defer { r.teardown() }
    let flag = r.root + "/fail-next-status"
    let shim = r.root + "/tmux-failstatus"
    try """
    #!/bin/bash
    for a in "$@"; do
      if [ "$a" = display-message ] && [ -f '\(flag)' ]; then rm -f '\(flag)'; echo "error connecting to the socket (Resource temporarily unavailable)" >&2; exit 1; fi
    done
    exec '\(Rig.tmuxPath!)' "$@"
    """.write(toFile: shim, atomically: true, encoding: .utf8)
    chmod(shim, 0o755)
    r.tmuxBin = shim
    r.makeSupervisor()
    try coldStartConfirmed(r)
    FileManager.default.createFile(atPath: flag, contents: nil)
    #expect(r.wait(20) { !FileManager.default.fileExists(atPath: flag) }, "the shim never failed a status query")
    usleep(1_500_000)  // several polls after the failed one
    #expect(!r.audit.contains("host_lost=1"), "\(r.audit)")
    #expect(isRunning(r.phase()), "\(r.phase())")
    #expect(r.starts.count == 1, "\(r.starts.count) starts")
  }

  /// Repair check: one failed status query in the moment after a real death.
  private func failedQueryAtDeath(env: [String: String]) throws {
    var t = Supervisor.Timings()
    t.tick = 0.2
    t.agentsPoll = 0.5
    let r = try Rig(.tmux, scenario: "crash-after.sh", env: env, timings: t)
    defer { r.teardown() }
    let flag = r.root + "/fail-after-death"
    let shim = r.root + "/tmux-failatdeath"
    try """
    #!/bin/bash
    for a in "$@"; do
      if [ "$a" = display-message ] && [ -f '\(flag)' ] && ! kill -0 "$(cat '\(flag)')" 2>/dev/null; then rm -f '\(flag)'; echo failed >> '\(flag).fired'; echo "error connecting to the socket (Resource temporarily unavailable)" >&2; exit 1; fi
    done
    exec '\(Rig.tmuxPath!)' "$@"
    """.write(toFile: shim, atomically: true, encoding: .utf8)
    chmod(shim, 0o755)
    r.tmuxBin = shim
    r.makeSupervisor()
    try coldStartConfirmed(r)
    let pid = try #require(r.host.childPid)
    try "\(pid)".write(toFile: flag, atomically: true, encoding: .utf8)
    #expect(r.wait(20) { r.audit.contains(" exit ") }, "AUDIT: \(r.audit)")
    usleep(4_000_000)  // the retry polls after the failed query
    #expect(FileManager.default.fileExists(atPath: flag + ".fired"), "the shim never fired")
    #expect(!r.audit.contains("host_lost=1"), "AUDIT: \(r.audit)")
  }

  /// The agent dies on its own (the group is empty at once) and the one status query in that moment fails: the parent read
  /// the real exit on the next poll, so this must be a supervisor restart, not a host loss that waits for a human Enter.
  @Test func oneFailedQueryRightAfterACrashIsNotAHostLost() throws {
    try failedQueryAtDeath(env: ["FAKE_CRASHES": "1", "FAKE_CRASH_SECONDS": "4"])
  }

  /// Independent review: main session killed while a worker session keeps the shared tmux server up.
  @Test func rvwSessionKilledWhileServerLivesIsAHostLost() throws {
    var t = Supervisor.Timings()
    t.tick = 0.2
    t.agentsPoll = 0.5
    let r = try Rig(.tmux, scenario: "crash-after.sh", env: ["FAKE_CRASHES": "0"], timings: t)
    defer { r.teardown() }
    try coldStartConfirmed(r)
    let raw = [Rig.tmuxPath!, "-L", r.socket]
    #expect(ProcessRunner.run(raw + ["new-session", "-d", "-s", "t-worker", "--", "/bin/sleep", "300"], env: r.loginEnv).ok)
    #expect(ProcessRunner.run(raw + ["kill-session", "-t", "=\(TmuxCommands.mainSession)"], env: r.loginEnv).ok)
    #expect(r.wait(10) { r.audit.contains("host_lost=1") }, "AUDIT: \(r.audit) PHASE: \(r.phase()) STARTS: \(r.starts.count)")
  }

  /// A status query that keeps failing without tmux saying "gone" must not hide a dead agent forever: while the agent's
  /// process group lives it is no loss, once the group is gone (and tmux still can't say) it is a host loss.
  @Test func aPersistentlyFailingStatusQueryStillReportsADeadAgent() throws {
    var t = Supervisor.Timings()
    t.tick = 0.2
    t.agentsPoll = 0.5
    let r = try Rig(.tmux, scenario: "crash-after.sh", env: ["FAKE_CRASHES": "0"], timings: t)
    defer { r.teardown() }
    let flag = r.root + "/fail-all-status"
    let shim = r.root + "/tmux-failstatus-always"
    try """
    #!/bin/bash
    for a in "$@"; do
      if [ "$a" = display-message ] && [ -f '\(flag)' ]; then echo "error connecting to the socket (Resource temporarily unavailable)" >&2; exit 1; fi
    done
    exec '\(Rig.tmuxPath!)' "$@"
    """.write(toFile: shim, atomically: true, encoding: .utf8)
    chmod(shim, 0o755)
    r.tmuxBin = shim
    r.makeSupervisor()
    try coldStartConfirmed(r)
    let pid = try #require(r.host.childPid)
    FileManager.default.createFile(atPath: flag, contents: nil)
    usleep(1_500_000)  // several polls, every status query failing, the agent alive
    #expect(!r.audit.contains("host_lost=1"), "a live agent was reported lost: \(r.audit)")
    #expect(isRunning(r.phase()), "\(r.phase())")
    killpg(pid, SIGKILL)
    #expect(r.wait(10) { r.audit.contains("host_lost=1") }, "AUDIT: \(r.audit) PHASE: \(r.phase()) STARTS: \(r.starts.count)")
  }

  /// Independent review: the supervised pane killed while a split pane keeps the session alive.
  @Test func rvwPaneKilledWhileSessionLivesIsAHostLost() throws {
    var t = Supervisor.Timings()
    t.tick = 0.2
    t.agentsPoll = 0.5
    let r = try Rig(.tmux, scenario: "crash-after.sh", env: ["FAKE_CRASHES": "0"], timings: t)
    defer { r.teardown() }
    try coldStartConfirmed(r)
    let raw = [Rig.tmuxPath!, "-L", r.socket]
    let pane = try #require((r.host as? TmuxPtyHost)?.supervisedPaneId)
    #expect(ProcessRunner.run(raw + ["split-window", "-d", "-t", "=\(TmuxCommands.mainSession):", "--", "/bin/sleep", "300"], env: r.loginEnv).ok)
    #expect(ProcessRunner.run(raw + ["kill-pane", "-t", pane], env: r.loginEnv).ok)
    #expect(r.wait(10) { r.audit.contains("host_lost=1") }, "AUDIT: \(r.audit) PHASE: \(r.phase()) STARTS: \(r.starts.count)")
  }

  /// "Stop" and "Restart" on a second copy of the app (a dev build beside the installed one): nothing happens and nothing
  /// says why. `stop_refused_passive` reaches only the audit log. stopThenQuit then runs out its 15 s and quits.
  @Test func aPassiveSupervisorSaysItCannotStop() throws {
    let r = try Rig(.tmux, scenario: "dev-dialog.sh")
    defer { r.teardown() }
    let s1 = r.sup!
    try coldStartConfirmed(r)
    let s2 = r.makeSupervisor()
    defer { s2.detach(); s1.detach() }
    s2.startTicking()
    s2.attachOrStart(allowColdStart: true)
    #expect(r.wait(5) { s2.status.childPid == s1.status.childPid })
    let before = r.allEvents.count
    s2.stop()
    usleep(800_000)
    #expect(r.audit.contains("stop_refused_passive"))
    #expect(r.allEvents.count > before, "no event: the menu can't tell the owner the Stop did nothing")
  }
}
