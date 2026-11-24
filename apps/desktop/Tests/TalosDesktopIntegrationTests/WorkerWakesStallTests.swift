import Foundation
import Testing
import TalosDesktopCore
@testable import TalosSupervisor
import TalosTestSupport

private final class Gate: @unchecked Sendable {
  private let lock = NSLock()
  private let sem = DispatchSemaphore(value: 0)
  private var _entered = 0
  private var _open = false
  private var _names: [String] = []
  var entered: Int { lock.withLock { _entered } }
  var names: [String] { lock.withLock { _names } }
  func see(_ name: String) { lock.withLock { _names.append(name) } }
  /// Blocks the caller until `open()`: the stall, ended by the test and not by a sleep.
  func pass() {
    lock.withLock { _entered += 1 }
    if lock.withLock({ _open }) { return }
    sem.wait()
    sem.signal()
  }
  func open() {
    lock.withLock { _open = true }
    sem.signal()
  }
}

private final class Lines: @unchecked Sendable {
  private let lock = NSLock()
  private var all: [String] = []
  func add(_ s: String) { lock.withLock { all.append(s) } }
  var list: [String] { lock.withLock { all } }
}

/// The wakes block of the tick stays on the tick (a stalled tick must leave the heartbeat stale, so the hub falls back to main and the
/// stall is filed), and each call in it is a named step, so the report says where the tick sat. The clock is moved on by hand
/// (`JumpClock`); the stall is a gate the test opens, never a long sleep.
@Suite("Workers wakes block stall", .serialized, .enabled(if: Rig.hasTmux))
struct WorkerWakesStallTests {
  private func manager(_ r: WorkerRig, clock: JumpClock) -> WorkerManager {
    var o = WorkerManager.Options(
      talosHome: r.talosHome, agentDir: r.agentDir, claudePath: Rig.fixtures + "/claude", permissionFlag: nil, tmux: Rig.tmuxPath!,
      tmuxConf: Rig.tmuxConf)
    o.socket = r.socket
    o.permissionHook = Rig.hookSource
    o.home = r.root + "/home"
    o.tick = 0.2
    o.heartbeat = 0.5
    let e = r.env
    let m = WorkerManager(options: o, probe: LiveSystem(loginEnv: { e }), baseEnv: { e }, awake: { clock.now() })
    m.heartbeatWatchdog.period = 3600  // the test calls `check()` itself
    return m
  }

  private func heartbeat(_ r: WorkerRig) -> String? {
    FileManager.default.contents(atPath: r.talosHome + "/workers.json").flatMap(WorkersFile.decode)?.supervisor.heartbeat_at
  }

  /// Stalls the tick in `step`, 25 s on the fake clock: the heartbeat goes stale and the stall is filed once, naming the step; when the
  /// stall ends the heartbeat is on time again and the same stall is not filed a second time.
  private func stall(in step: String, action: String? = nil) throws {
    let r = try WorkerRig()
    defer { r.teardown() }
    r.mgr.detach()
    let clock = JumpClock()
    let gate = Gate()
    let m = manager(r, clock: clock)
    if let action { try r.wake("trip", action: action) }
    m.stepHook = { name in if name == step { gate.pass() } }
    let said = Lines()
    m.heartbeatWatchdog.onStall = { said.add($0) }
    m.startTicking()
    defer { m.detach() }
    defer { gate.open() }
    #expect(r.wait(30) { gate.entered >= 1 && m.watch.view().step == step }, "the tick sits in \(step): \(m.watch.view().step)")
    #expect(m.heartbeatWatchdog.check() == .none, "a heartbeat on time is left alone")
    clock.advance(25)
    #expect(m.heartbeatWatchdog.check() == .waiting, "the stalled tick is reported and waited for, not cut")
    #expect(said.list.count == 1, "filed once: \(said.list)")
    #expect(said.list.first?.contains("heartbeat 25s old") == true, "the heartbeat went stale: \(said.list)")
    #expect(said.list.first?.contains("tick in step \(step) for 25s") == true, "the report names the call: \(said.list)")
    #expect(!(said.list.first ?? "").contains("trip"), "no thread id in the report: \(said.list)")
    gate.open()
    #expect(r.wait(30) { m.heartbeatWatchdog.check() == .none }, "once the call returns the heartbeat is on time again")
    #expect(said.list.count == 1, "a recovered stall is not filed again: \(said.list)")
  }

  @Test func aStallInTheWakeFileLookNamesTheLook() throws { try stall(in: "wakes.look") }

  @Test func aStallInsideAWakesActionNamesTheAction() throws { try stall(in: "wakes.apply.park", action: "park") }

  @Test func aStallInALaterCallNamesThatCall() throws { try stall(in: "wakes.retryHeld") }

  @Test func anActionIsNamedByItsWordOnlyAndAnUnknownOneIsDropped() throws {
    for a in WakeFile.actions { #expect(WorkerManager.applyStep(a) == "apply." + a) }
    #expect(WorkerManager.applyStep("rm-rf-everything") == "apply.other", "a name is never built from a file's text")
    let r = try WorkerRig()
    defer { r.teardown() }
    r.mgr.detach()
    let gate = Gate()
    let m = manager(r, clock: JumpClock())
    try r.wake("trip", action: "rm-rf-everything")
    m.stepHook = { gate.see($0) }
    defer { m.detach() }
    m.tickOnce()
    #expect(!gate.names.contains { $0.hasPrefix("wakes.apply") }, "a wake with an unknown action is dropped, as before: \(gate.names)")
    #expect(!gate.names.contains { $0.contains("rm-rf") || $0.contains("trip") }, "\(gate.names)")
    #expect(!FileManager.default.fileExists(atPath: r.talosHome + "/workers/trip/wake"), "and taken, not left to loop")
  }
}
