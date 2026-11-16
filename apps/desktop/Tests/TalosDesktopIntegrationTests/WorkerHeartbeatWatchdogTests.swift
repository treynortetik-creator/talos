import Foundation
import Testing
import TalosDesktopCore
@testable import TalosSupervisor
import TalosTestSupport

private final class CountingNapGuard: NapGuard, @unchecked Sendable {
  private let lock = NSLock()
  private var _held = false
  private var _holds = 0
  var held: Bool { lock.withLock { _held } }
  var holds: Int { lock.withLock { _holds } }
  func hold() { lock.withLock { if !_held { _holds += 1 }; _held = true } }
  func release() { lock.withLock { _held = false } }
}

private final class Lines: @unchecked Sendable {
  private let lock = NSLock()
  private var all: [String] = []
  func add(_ s: String) { lock.withLock { all.append(s) } }
  var list: [String] { lock.withLock { all } }
}

/// The workers' heartbeat in `workers.json` must not stop while the app lives: the app keeps itself out of App Nap while it supervises,
/// and a watchdog on its own queue notices a late heartbeat, says what the tick was doing and gets the loop going again. The awake
/// clock is moved on by hand (`JumpClock`); the real waits only cap a hang.
@Suite("Workers heartbeat watchdog", .serialized)
struct WorkerHeartbeatWatchdogTests {
  /// A tmux that hangs on one call while `mark` exists (and ignores SIGTERM, as a wedged one would), else the real one.
  private func hangingTmux(_ r: WorkerRig, mark: String) throws -> String {
    let path = r.root + "/tmux"
    try """
    #!/bin/sh
    if [ -e '\(mark)' ]; then rm -f '\(mark)'; trap '' TERM; exec /bin/sleep 600; fi
    exec '\(Rig.tmuxPath!)' "$@"
    """.write(toFile: path, atomically: true, encoding: .utf8)
    chmod(path, 0o755)
    return path
  }

  private func manager(_ r: WorkerRig, tmux: String, clock: JumpClock) -> WorkerManager {
    var o = WorkerManager.Options(
      talosHome: r.talosHome, agentDir: r.agentDir, claudePath: Rig.fixtures + "/claude", permissionFlag: nil, tmux: tmux,
      tmuxConf: Rig.tmuxConf)
    o.socket = r.socket
    o.permissionHook = Rig.hookSource
    o.home = r.root + "/home"
    o.tick = 0.2
    o.heartbeat = 0.5
    o.callTimeout = 600  // the runner's own timeout never ends the hang in this test: only the watchdog can
    let e = r.env
    let m = WorkerManager(options: o, probe: LiveSystem(loginEnv: { e }), baseEnv: { e }, awake: { clock.now() })
    m.napGuard = CountingNapGuard()
    m.heartbeatWatchdog.period = 3600  // the test calls `check()` itself, so the watchdog's own timer never races it
    return m
  }

  private func heartbeat(_ r: WorkerRig) -> String? {
    FileManager.default.contents(atPath: r.talosHome + "/workers.json").flatMap(WorkersFile.decode)?.supervisor.heartbeat_at
  }

  @Test
  func theAppStaysOutOfAppNapWhileItSupervises() throws {
    let r = try WorkerRig()
    defer { r.teardown() }
    r.mgr.detach()
    let nap = CountingNapGuard()
    let m = manager(r, tmux: Rig.tmuxPath!, clock: JumpClock())
    m.napGuard = nap
    m.startTicking()
    m.startTicking()
    m.tune { _ in }  // the queue has run both starts
    #expect(nap.held, "ticking holds the app out of App Nap")
    #expect(nap.holds == 1, "a second start takes no second hold")
    m.detach()
    #expect(!nap.held, "a stopped loop lets the app nap again")
  }

  @Test
  func aCallThatHangsIsCancelledAndTheHeartbeatMovesAgain() throws {
    let r = try WorkerRig()
    defer { r.teardown() }
    r.mgr.detach()
    // a worker the file says is live: adopting it asks tmux, and that call hangs
    try """
    {"v":1,"supervisor":{"pid":1,"heartbeat_at":"2026-10-30T00:00:00.000Z","workers_supported":true,"main_pane_pid":0},
     "threads":{"trip":{"state":"live","tmux":"t-trip","cwd":"\(r.agentDir)","pane_pid":0}}}
    """.write(toFile: r.talosHome + "/workers.json", atomically: true, encoding: .utf8)
    let mark = r.root + "/hang"
    FileManager.default.createFile(atPath: mark, contents: Data())
    let clock = JumpClock()
    let m = manager(r, tmux: try hangingTmux(r, mark: mark), clock: clock)
    let said = Lines()
    m.heartbeatWatchdog.onStall = { said.add($0) }
    m.startTicking()
    defer { m.detach() }
    #expect(r.wait(30) { m.watch.view().child?.what == "tmux has-session" }, "the tick waits on the hanging call")
    #expect(m.heartbeatWatchdog.check() == .none, "a heartbeat on time is left alone")
    let before = heartbeat(r)
    clock.advance(60)
    #expect(m.heartbeatWatchdog.check() == .cancelledCall("tmux has-session"))
    #expect(said.list.count == 1, "the stall is reported once: \(said.list)")
    #expect(said.list.first?.contains("tick in step adopt") == true, "the report says where the tick was: \(said.list)")
    #expect(said.list.first?.contains("waiting on tmux has-session") == true, "and what it waited on: \(said.list)")
    #expect(r.wait(30) { heartbeat(r) != nil && heartbeat(r) != before }, "the heartbeat moves again")
    #expect(r.wait(30) { m.heartbeatWatchdog.check() == .none }, "and the watchdog sees it on time")
    #expect(said.list.count == 1, "a recovered stall is not reported again")
  }

  @Test
  func aLoopWithNoTickRunningIsRestartedAndNeverDoubled() throws {
    let r = try WorkerRig()
    defer { r.teardown() }
    r.mgr.detach()
    let clock = JumpClock()
    let m = manager(r, tmux: Rig.tmuxPath!, clock: clock)
    let said = Lines()
    m.heartbeatWatchdog.onStall = { said.add($0) }
    m.startTicking()
    defer { m.detach() }
    #expect(r.wait(30) { heartbeat(r) != nil }, "the loop wrote its first heartbeat")
    m.queue.sync { m.timer?.cancel() }  // the loop's timer is dead, the app lives on
    clock.advance(60)
    #expect(m.heartbeatWatchdog.check() == .restartedLoop)
    #expect(said.list.first?.contains("last tick ended") == true, "\(said.list)")
    m.queue.sync {}
    #expect(m.queue.sync { m.timer?.isCancelled == false }, "one new timer replaced the dead one")
    let after = heartbeat(r)
    #expect(r.wait(30) { heartbeat(r) != after }, "the heartbeat moves again")
    #expect(r.wait(30) { m.heartbeatWatchdog.check() == .none })
  }

  @Test
  func aPassiveCopyIsLeftAlone() throws {
    let r = try WorkerRig()
    defer { r.teardown() }
    r.firstTick()  // the rig's manager holds workers.lock
    let clock = JumpClock()
    let m = manager(r, tmux: Rig.tmuxPath!, clock: clock)
    m.heartbeatWatchdog.onStall = { _ in Issue.record("a passive copy writes no heartbeat: nothing is late") }
    m.startTicking()
    defer { m.detach() }
    #expect(r.wait(30) { let v = m.watch.view(); return v.stepSince > 0 && !v.inTick && !v.supervising }, "a tick found the lock taken")
    #expect(!m.isActive)
    clock.advance(600)
    #expect(m.heartbeatWatchdog.check() == .none)
  }

  @Test
  func aStallIsFiledAsAProblemTheErrorsListReads() throws {
    let home = (TestTemp.base as NSString).appendingPathComponent("talos-problem-\(UUID().uuidString.prefix(8))")
    defer { try? FileManager.default.removeItem(atPath: home) }
    MacProblem.file(home: home, name: "WorkerHeartbeatStalled", message: "heartbeat 60s old", key: "adopt", at: Date())
    MacProblem.file(home: home, name: "WorkerHeartbeatStalled", message: "heartbeat 90s old", key: "adopt", at: Date())
    let files = (try? FileManager.default.contentsOfDirectory(atPath: home + "/problems/open")) ?? []
    #expect(files.count == 1, "one file per kind of stall: \(files)")
    let o = files.first.flatMap { FileManager.default.contents(atPath: home + "/problems/open/" + $0) }
      .flatMap { (try? JSONSerialization.jsonObject(with: $0)) as? [String: Any] }
    #expect(o?["count"] as? Int == 2)
    #expect(o?["source"] as? String == "mac")
    #expect(o?["trust"] as? String == "external")
    #expect(o?["message"] as? String == "heartbeat 90s old")
  }
}
