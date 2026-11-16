import Foundation
import Testing
import TalosDesktopCore
import TalosSupervisor

/// A wake that waited longer than any message waits for its claim (the app was closed) starts nothing: the hub has given every message
/// in it back to main. An Enter whose send timed out may have landed, so it is never followed by a second copy of the line. Real private tmux (`talos-test-…`, never `-L talos`)
/// and the fake claude, on the rig's jumping clock.
@Suite("The pointer's deadline and its Enter", .serialized, .enabled(if: Rig.hasTmux))
struct WorkerPointerDeadlineTests {
  private let line = "trip \(PointerTyper.text)"

  private func ticks(_ r: WorkerRig, _ timeout: Double, _ cond: () -> Bool) -> Bool {
    r.wait(timeout) {
      r.mgr.tickOnce()
      return cond()
    }
  }

  private func rig(_ clock: JumpClock, tmux: String? = nil, prepare: (WorkerRig) throws -> Void = { _ in }) throws -> WorkerRig {
    let r = try WorkerRig(scenario: "review-worker.sh", extraEnv: ["FAKE_RV_ECHO_BOX": "1"])
    try prepare(r)
    r.manager(tmux: tmux, now: { clock.wallMs() / 1000 }, awake: { clock.awake() })
    return r
  }

  @Test func aWakeOlderThanAnyClaimWindowStartsNothing() throws {
    let clock = JumpClock()
    let r = try rig(clock)
    defer { r.teardown() }
    try r.wake("trip", at: Date().timeIntervalSince1970 - PointerTyper.longestClaim - 60)
    r.mgr.tickOnce()
    #expect(!r.allEvents.contains { if case .started = $0 { return true }; return false }, "a session started for a message main has")
    #expect(r.entry("trip")?.pointer_owed_until == nil)
  }

  /// Control: a wake a few minutes old may still name a hand-off from main, which waits 15 minutes for its lead: it starts the session.
  @Test func aWakeInsideTheHandOffWindowStillStarts() throws {
    let clock = JumpClock()
    let r = try rig(clock)
    defer { r.teardown() }
    try r.wake("trip", at: Date().timeIntervalSince1970 - 300)
    r.mgr.tickOnce()
    #expect(r.allEvents.contains { if case .started = $0 { return true }; return false }, "\(r.why("trip"))")
  }

  @Test func anEnterThatTimedOutButLandedIsNotFollowedByASecondLine() throws {
    let clock = JumpClock()
    var shim = ""
    let r = try rig(clock) { r in
      shim = r.root + "/tmux-late-enter"
      try """
      #!/bin/bash
      for a in "$@"; do  # the pointer's Enter is the send of an if-shell: one string
        case "$a" in Enter | send-keys\\ *\\ Enter | send-keys\\ *\\ Enter\\ *) '\(Rig.tmuxPath!)' "$@"; exec /bin/sleep 3 ;; esac
      done
      exec '\(Rig.tmuxPath!)' "$@"
      """.write(toFile: shim, atomically: true, encoding: .utf8)
      chmod(shim, 0o755)
    }
    defer { r.teardown() }
    r.manager(tmux: shim, now: { clock.wallMs() / 1000 }, awake: { clock.awake() })
    r.mgr.tune { $0.callTimeout = 1 }
    try r.wake("trip")
    #expect(ticks(r, 15) { r.typedLines.count == 1 }, "\(r.why("trip"))")
    clock.advance(30)  // past the time an empty box is still a screen that has not caught up
    #expect(!ticks(r, 4) { r.typedLines.count > 1 }, "the line was typed again after its Enter landed: \(r.typedLines)")
    #expect(r.typedLines == [line])
  }
}
