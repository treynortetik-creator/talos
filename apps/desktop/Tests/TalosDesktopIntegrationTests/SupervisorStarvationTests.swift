import Foundation
import Testing
import TalosDesktopCore
import TalosSupervisor

private final class Flag: @unchecked Sendable {
  private let lock = NSLock()
  private var _value = false
  var value: Bool {
    get { lock.withLock { _value } }
    set { lock.withLock { _value = newValue } }
  }
}

/// The agents poll must not wait for a free thread in the process-wide dispatch pool (see `anEnterGetsThroughWhileTheDispatchPoolIsStarved`
/// for how the pool is held). Like that test it starves every core, which would sabotage the suites running beside it, so it is off in the
/// normal run and runs alone: `bash scripts/starvation-tests.sh`.
@Suite("Supervisor with a starved dispatch pool", .serialized)
struct SupervisorStarvationTests {
  /// The poll's subprocess is replaced by an answer that is never us, so what is left to starve is the supervisor's own hop out to
  /// the poll and back. Two such polls make the session stuck; each supervision pass moves the clock past the poll gate.
  @Test(.enabled(if: ProcessInfo.processInfo.environment["TALOS_STARVATION_TESTS"] == "1"))
  func theAgentsPollIsAnsweredWhileTheDispatchPoolIsStarved() async throws {
    var t = Supervisor.Timings()
    t.tick = 0.2
    t.agentsPoll = 0.5
    t.dialogStall = 0
    let r = try Rig(.direct, scenario: "dev-dialog.sh", timings: t)
    defer { r.teardown() }
    try coldStartConfirmed(r)
    r.agentsProbe.answer = { [] }
    let stuck = Flag()
    let finished = Flag()
    let probe = Thread {
      defer { finished.value = true }
      usleep(500_000)  // the block below has taken every cooperative thread by now
      // The window ends 1.3 s before the block does, so a poll that only runs once the pool is free cannot count.
      let until = Date().addingTimeInterval(1.2)
      while Date() < until, !stuck.value {
        r.clock.advance(30)
        r.sup.tickNow()
        stuck.value = r.sup.status.needsYou == .stuck
        usleep(50_000)
      }
    }
    probe.start()
    await withTaskGroup(of: Void.self) { g in
      for _ in 0..<ProcessInfo.processInfo.activeProcessorCount { g.addTask { usleep(3_000_000) } }
    }
    for _ in 0..<100 where !finished.value { try await Task.sleep(nanoseconds: 50_000_000) }  // join: no tick after teardown
    #expect(finished.value, "the probe thread is done before the rig goes")
    #expect(stuck.value, "the polls waited for the dispatch pool: \(r.agentsSummary), needsYou \(String(describing: r.sup.status.needsYou))")
  }
}
