import Foundation
import Testing
import TalosDesktopCore
import TalosSupervisor

/// "Quit and stop" asks the worker manager to stop every session without waiting for it: the quit's own time limit runs on the main
/// thread, so a stop that held the caller until a slow tick and every worker's grace were over bounded nothing. Real private tmux
/// (`talos-test-…`, never `-L talos`) and the fake claude.
@Suite("Quit and stop never holds its caller", .serialized, .enabled(if: Rig.hasTmux))
struct WorkerQuitStopTests {
  /// A tmux that hangs on `capture-pane` while `hang` exists, and says so in `hanging`.
  private func hangShim(_ r: WorkerRig) throws -> (shim: String, hang: String, hanging: String) {
    let hang = r.root + "/hang"
    let hanging = r.root + "/hanging"
    let shim = r.root + "/tmux-hang"
    try """
    #!/bin/bash
    for a in "$@"; do
      if [ "$a" = capture-pane ] && [ -f '\(hang)' ]; then : > '\(hanging)'; while [ -f '\(hang)' ]; do sleep 0.05; done; fi
    done
    exec '\(Rig.tmuxPath!)' "$@"
    """.write(toFile: shim, atomically: true, encoding: .utf8)
    chmod(shim, 0o755)
    return (shim, hang, hanging)
  }

  @Test func theStopReturnsWhileATickIsStuckAndFinishesAfterIt() throws {
    let r = try WorkerRig(scenario: "review-worker.sh")
    defer { r.teardown() }
    let (shim, hang, hanging) = try hangShim(r)
    let m = r.manager(tmux: shim)
    m.tune { $0.callTimeout = 600 }  // only the test ends the hang
    try r.wake("trip")
    #expect(r.wait(10) { m.tickOnce(); return r.up("trip") }, "\(r.why("trip"))")
    let pid = try #require(r.entry("trip")?.pane_pid)
    FileManager.default.createFile(atPath: hang, contents: nil)
    let tick = DispatchSemaphore(value: 0)
    // own threads, not the shared pool: a loaded test run can leave a pool block unstarted for longer than these waits
    Thread { m.tickOnce(); tick.signal() }.start()
    #expect(r.wait(10) { FileManager.default.fileExists(atPath: hanging) }, "the tick never reached tmux")
    let asked = DispatchSemaphore(value: 0)
    Thread { m.beginStopAll(); asked.signal() }.start()
    let returned = asked.wait(timeout: .now() + 5 * waitScale) == .success
    #expect(returned, "the stop held its caller behind a tick that is stuck in tmux")
    #expect(!m.isAllStopped, "said stopped while the tick still holds the queue")
    unlink(hang)
    #expect(tick.wait(timeout: .now() + 10 * waitScale) == .success)
    if !returned { _ = asked.wait(timeout: .now() + 10 * waitScale) }
    #expect(r.wait(10) { m.isAllStopped }, "the stop never finished")
    #expect(r.state("trip") == "parked", "\(r.why("trip"))")
    #expect(!ProcessInspect.groupAlive(pid))
    #expect(r.fileOnDisk?.threads["trip"]?.state == "parked")
  }
}
