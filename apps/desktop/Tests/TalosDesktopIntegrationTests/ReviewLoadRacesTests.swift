import Darwin
import Foundation
import Testing
import TalosDesktopCore
import TalosSupervisor

/// Re-review of PR #97 at 54c2cb9. Both tests FAIL at 54c2cb9.
@Suite("Re-review of PR #97", .serialized, .enabled(if: Rig.hasTmux))
struct ReviewLoadRacesTests {
  /// The open descriptor this process holds on `path`, found by asking the kernel: `WorkerManager.lockFd` is private.
  private func descriptor(on path: String) -> Int32? {
    var buf = [CChar](repeating: 0, count: Int(MAXPATHLEN))
    for fd in Int32(0)..<4096 where fcntl(fd, F_GETPATH, &buf) == 0 {
      if String(cString: buf) == path { return fd }
    }
    return nil
  }

  /// M1. The cause of appRelaunchReadoptsLiveWorkersWithoutARestart and anUnknownStateInTheFileIsAdopted: `releaseLock` only calls
  /// `close()`. A flock lives until every copy of the open file description is gone or one of them unlocks, and a spawn in
  /// flight on a parallel suite holds a copy until exec, so `detach()` returns with the lock still held and the next manager's
  /// one `tickOnce` is a silent no-op. The `dup` here is that copy, held on purpose so the test does not depend on timing.
  /// Supervisor.releaseLock already does `flock(LOCK_UN)` first.
  @Test func aDetachedManagerReleasesTheLockEvenWhileASpawnHoldsACopy() throws {
    let r = try WorkerRig()
    defer { r.teardown() }
    r.mgr.startTicking()
    try r.wake("trip")
    #expect(r.wait(10) { r.state("trip") == "live" })
    let held = try #require(descriptor(on: r.talosHome + "/workers.lock"), "the manager holds workers.lock")
    let copy = dup(held)
    #expect(copy >= 0)
    defer { close(copy) }
    r.mgr.detach()
    let again = r.makeManager()
    r.firstTick(again)  // the sibling's copy of the descriptor must not keep the flock alive
    #expect(r.state("trip") == "live")
  }

  /// M2. `confirmSentAt` is the tick's start, taken before `host.send`, so a slow send spends the agent's `noticeWait`: here the
  /// agent redraws 1 s after the Enter reaches it, well inside a 3 s wait, and is stopped anyway with `noNotice`.
  @Test func aSlowRestartEnterDoesNotSpendTheAgentsNoticeWait() throws {
    var t = Supervisor.Timings()
    t.tick = 0.2
    t.agentsPoll = 0.5
    t.backoff = Backoff(steps: [0.3, 0.5, 0.5, 0.5, 0.5], jitter: 0)
    t.stopGrace = 3
    t.noticeWait = 3
    let r = try Rig(
      .tmux, scenario: "slow-notice.sh", env: ["FAKE_CRASH_SECONDS": "1", "FAKE_NOTICE_DELAY": "1"], timings: t)
    defer { r.teardown() }
    let flag = r.root + "/slow-next-send"
    let shim = r.root + "/tmux-slowsend"
    try """
    #!/bin/bash
    for a in "$@"; do
      if [ "$a" = if-shell ] && [ -f '\(flag)' ]; then rm -f '\(flag)'; sleep 4; fi
    done
    exec '\(Rig.tmuxPath!)' "$@"
    """.write(toFile: shim, atomically: true, encoding: .utf8)
    chmod(shim, 0o755)
    r.tmuxBin = shim
    r.makeSupervisor()
    FileManager.default.createFile(atPath: flag, contents: nil)  // only `host.send` uses if-shell; the human Enter is raw tmux
    try coldStartConfirmed(r)
    #expect(r.wait(15) { r.starts.count >= 2 })
    #expect(r.wait(20) { r.audit.contains(" auto_confirm ") }, "the restart's Enter: \(r.audit)")
    #expect(r.wait(15) { (isRunning(r.phase()) && r.sup.status.needsYou == nil) || r.audit.contains("auto_confirm_no_notice") })
    #expect(!r.audit.contains("auto_confirm_no_notice"), "\(r.phase()) \(String(describing: r.sup.status.needsYou))")
    #expect(isRunning(r.phase()), "\(r.phase())")
  }
}
