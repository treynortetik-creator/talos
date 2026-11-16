import Foundation
import Testing
import TalosDesktopCore
import TalosSupervisor

/// Counts the `ProcessInfo` activities the real guard takes and gives back, through its `begin`/`end` seam.
private final class ActivityLog: @unchecked Sendable {
  private let lock = NSLock()
  private var _begins = 0
  private var _ends = 0
  private var _most = 0
  var begins: Int { lock.withLock { _begins } }
  var ends: Int { lock.withLock { _ends } }
  var held: Int { lock.withLock { _begins - _ends } }
  /// The most activities held at once.
  var most: Int { lock.withLock { _most } }
  func guardForTest() -> ProcessActivityNapGuard {
    ProcessActivityNapGuard(
      begin: { [self] in lock.withLock { _begins += 1; _most = max(_most, _begins - _ends) }; return NSObject() },
      end: { [self] _ in lock.withLock { _ends += 1 } })
  }
}

/// Main's supervisor keeps the app out of App Nap while it watches a live session: with the window closed, a napping app's timers are
/// held back, and the tick carries the start and stop deadlines, the dev-channel answer and the stall warnings.
@Suite("Supervisor App Nap (real pty, real tmux)", .serialized)
struct SupervisorNapGuardTests {
  private func rig(_ kind: HostKind) throws -> (Rig, ActivityLog) {
    let r = try Rig(kind, scenario: "dev-dialog.sh")
    let log = ActivityLog()
    r.sup.napGuard = log.guardForTest()
    return (r, log)
  }

  @Test(arguments: bothHosts)
  func aTickWithNothingRunningNeverHolds(kind: HostKind) throws {
    let (r, log) = try rig(kind)
    defer { r.teardown() }
    r.sup.startTicking()
    r.sup.tickNow()
    r.sup.drain()
    #expect(log.begins == 0, "nothing is running, so the app may nap")
  }

  @Test(arguments: bothHosts)
  func aLiveSessionHoldsOnlyOnceTheTickRuns(kind: HostKind) throws {
    let (r, log) = try rig(kind)
    defer { r.teardown() }
    r.sup.start()
    r.sup.drain()
    #expect([.starting, .running].contains(r.phase()), "phase \(r.phase())")
    #expect(log.begins == 0, "no tick, so nothing would run late")
    r.sup.startTicking()
    r.sup.drain()
    #expect(log.held == 1, "the tick now runs for a live session")
  }

  @Test(arguments: bothHosts)
  func runningHoldsAndStopReleases(kind: HostKind) throws {
    let (r, log) = try rig(kind)
    defer { r.teardown() }
    try coldStartConfirmed(r)
    #expect(log.held == 1, "a running Main keeps the app out of App Nap")
    r.sup.stop()
    #expect(r.wait(15) { r.sup.tickNow(); return stopReason(r.phase()) == .user }, "phase \(r.phase())")
    r.sup.drain()
    #expect(log.held == 0 && log.ends == 1, "a stopped Main lets the app nap again")
    #expect(log.most == 1, "never two holds")
  }

  @Test(arguments: bothHosts)
  func detachReleases(kind: HostKind) throws {
    let (r, log) = try rig(kind)
    defer { r.teardown() }
    try coldStartConfirmed(r)
    #expect(log.held == 1)
    r.sup.detach()
    #expect(log.held == 0, "a detached supervisor ticks no more, so it holds nothing")
    #expect(log.most == 1, "never two holds")
  }

  @Test(arguments: bothHosts)
  func aSecondStartAfterAStopTakesOneHoldAgain(kind: HostKind) throws {
    let (r, log) = try rig(kind)
    defer { r.teardown() }
    try coldStartConfirmed(r)
    r.sup.startTicking()  // a second start of the tick takes no second hold
    r.sup.stop()
    #expect(r.wait(15) { r.sup.tickNow(); return stopReason(r.phase()) == .user }, "phase \(r.phase())")
    r.sup.start()
    #expect(r.wait(20) { r.sup.tickNow(); return [.starting, .running].contains(r.phase()) }, "phase \(r.phase())")
    #expect(log.held == 1 && log.begins == 2, "begins \(log.begins), ends \(log.ends)")
    #expect(log.most == 1, "never two holds")
  }
}
