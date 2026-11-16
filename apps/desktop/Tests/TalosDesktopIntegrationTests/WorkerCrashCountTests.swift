import Foundation
import Testing
import TalosDesktopCore
import TalosSupervisor

/// Only a crash counts toward `crash_loop`: a session that ends while it is starting, one that ends on its way to a park the owner
/// asked for, and a `new-session` that made nothing are not crashes. Real private tmux (`talos-test-…`, never `-L talos`) and the fake
/// claude. The loop is driven tick by tick.
@Suite("What counts as a crash", .serialized, .enabled(if: Rig.hasTmux))
struct WorkerCrashCountTests {
  private func ticks(_ r: WorkerRig, _ timeout: Double, _ cond: () -> Bool) -> Bool {
    r.wait(timeout) {
      r.mgr.tickOnce()
      return cond()
    }
  }

  @Test func aSessionThatEndsWhileStartingIsAFailedStartNotACrash() throws {
    let r = try WorkerRig(scenario: "clean-exit.sh", extraEnv: ["FAKE_EXIT_AFTER": "0.3"])
    defer { r.teardown() }
    r.manager()
    try r.wake("trip")
    #expect(ticks(r, 10) { r.state("trip") == "failed" }, "\(r.why("trip"))")
    #expect(r.entry("trip")?.error?.code == "start_failed")
    #expect(r.entry("trip")?.restarts.isEmpty == true, "counted as a crash: \(String(describing: r.entry("trip")?.restarts))")
  }

  @Test func aSessionThatEndsOnItsWayToTheOwnersParkIsNotACrash() throws {
    let r = try WorkerRig(scenario: "review-worker.sh", extraEnv: ["FAKE_RV_NOISE": "trip", "FAKE_RV_EXIT_AFTER": "3"])
    defer { r.teardown() }
    r.manager(busyWindow: 2)
    try r.wake("trip")
    #expect(ticks(r, 10) { r.state("trip") == "busy" }, "\(r.why("trip"))")
    try r.wakeFile("trip", action: "park", reason: "control")
    #expect(ticks(r, 3) { r.state("trip") == "stopping" }, "\(r.why("trip"))")
    #expect(ticks(r, 10) { r.state("trip") == "parked" }, "\(r.why("trip"))")
    #expect(r.entry("trip")?.restarts.isEmpty == true, "counted as a crash: \(String(describing: r.entry("trip")?.restarts))")
  }

  /// `new-session` timed out and tmux made nothing: the start failed in tmux, and says so.
  @Test func aNewSessionThatMadeNothingIsAFailedStartInTmux() throws {
    let r = try WorkerRig(scenario: "review-worker.sh")
    defer { r.teardown() }
    let shim = r.root + "/tmux-slow-new"
    try """
    #!/bin/bash
    for a in "$@"; do [ "$a" = new-session ] && exec /bin/sleep 5; done
    exec '\(Rig.tmuxPath!)' "$@"
    """.write(toFile: shim, atomically: true, encoding: .utf8)
    chmod(shim, 0o755)
    r.manager(tmux: shim)
    r.mgr.tune { $0.callTimeout = 1 }
    try r.wake("trip")
    #expect(ticks(r, 10) { r.state("trip") == "failed" }, "\(r.why("trip"))")
    #expect((r.entry("trip")?.error?.detail ?? "").contains("tmux"), "\(String(describing: r.entry("trip")?.error))")
    #expect(r.entry("trip")?.restarts.isEmpty == true, "counted as a crash: \(String(describing: r.entry("trip")?.restarts))")
  }

  /// Control: a live session that ends by itself is a crash, and is counted.
  @Test func aLiveSessionThatEndsByItselfIsCounted() throws {
    let r = try WorkerRig(scenario: "review-worker.sh", extraEnv: ["FAKE_RV_EXIT_AFTER": "1"])
    defer { r.teardown() }
    r.manager()
    try r.wake("trip")
    #expect(ticks(r, 10) { r.up("trip") }, "\(r.why("trip"))")
    #expect(ticks(r, 10) { r.state("trip") == "parked" }, "\(r.why("trip"))")
    #expect(r.entry("trip")?.restarts.count == 1)
  }
}
