import Foundation
import Testing
import TalosDesktopCore
import TalosSupervisor

/// The supervisor signals only process groups it started (R-19, DESKTOP-SPEC 3 and 4.3 step 1a).
@Suite("GroupSignaller", .serialized)
struct SignallerTests {
  /// A sleep in its own process group (perl's setpgrp, then exec).
  func ownGroupSleep() throws -> (Process, Int32) {
    let p = Process()
    p.executableURL = URL(fileURLWithPath: "/usr/bin/perl")
    p.arguments = ["-e", "setpgrp(0,0); exec '/bin/sleep', '60'"]
    p.standardInput = FileHandle.nullDevice
    try p.run()
    usleep(200_000)
    return (p, p.processIdentifier)
  }

  @Test func refusesGroupsItDoesNotOwnAndOurOwnGroup() throws {
    let (p, pid) = try ownGroupSleep()
    defer {
      kill(pid, SIGKILL)
      p.terminate()
    }
    let g = try #require(ProcessInspect.basic(pid)).pgid
    #expect(g == pid, "the sleep leads its own group")
    let s = GroupSignaller(probe: LiveSystem(loginEnv: { [:] }))
    #expect(!s.signal(g, SIGTERM), "not owned")
    #expect(ProcessInspect.alive(pid))
    // Signal 0 (no-op) for these: even a broken guard can't hurt the test runner's group.
    s.own(getpgrp(), leaderStart: 0)
    #expect(!s.signal(getpgrp(), 0), "never our own group")
    s.own(0, leaderStart: 0)
    s.own(1, leaderStart: 0)
    #expect(!s.signal(0, 0) && !s.signal(1, 0))
    // Owned, but recorded with another start time: a recycled pid is refused.
    s.own(g, leaderStart: 1)
    #expect(!s.signal(g, 0))
    #expect(ProcessInspect.alive(pid))
    // Owned with the right start time: signalled.
    s.own(g, leaderStart: try #require(ProcessInspect.basic(pid)).startTime)
    #expect(s.signal(g, SIGKILL))
    #expect(Rig.waitUntil(3) { !ProcessInspect.alive(pid) })
  }
}

extension Rig {
  static func waitUntil(_ timeout: Double, _ cond: () -> Bool) -> Bool {
    let until = Date().addingTimeInterval(timeout)
    while Date() < until {
      if cond() { return true }
      usleep(50_000)
    }
    return cond()
  }
}
