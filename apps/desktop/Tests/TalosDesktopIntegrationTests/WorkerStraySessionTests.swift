import Foundation
import Testing
import TalosDesktopCore
import TalosSupervisor

/// A thread's tmux session that runs while `workers.json` does not vouch for it (the app went between `new-session` and its record,
/// or the pane pid was never read) is still the app's: it is taken back, or stopped and replaced, never left running unowned with
/// every Start failing "already running". Real private tmux (`talos-test-…`, never `-L talos`) and the fake claude.
@Suite("A thread session the file does not vouch for", .serialized, .enabled(if: Rig.hasTmux))
struct WorkerStraySessionTests {
  private let scenario = "review-worker.sh"

  /// The file says the worker runs, but has no pane pid for it (`claimPane` could not read the pane before the app went).
  @Test func aRunningWorkerWithNoPanePidInTheFileIsTakenBackAtLaunch() throws {
    let r = try WorkerRig(scenario: scenario)
    defer { r.teardown() }
    let pid = try r.liveWorkerThenAppGone()
    var f = try #require(r.fileOnDisk)
    f.threads["trip"]?.pane_pid = 0
    try f.encoded().write(to: URL(fileURLWithPath: r.talosHome + "/workers.json"))
    r.manager()
    r.firstTick()
    #expect(r.up("trip"), "\(r.why("trip"))")
    #expect(r.entry("trip")?.pane_pid == pid)
    #expect(r.mgr.ownedGroups.contains(pid), "a running worker nobody owns")
    try r.wake("trip")
    r.mgr.tickOnce()
    #expect(r.state("trip") != "failed", "\(String(describing: r.entry("trip")?.error))")
    #expect(r.starts.count == 1, "taken back, not started again")
  }

  /// The file says parked: a start finds the session running. It is the thread's own worker, so it is stopped and the start goes on.
  @Test func aStartThatFindsTheThreadsOwnWorkerRunningReplacesIt() throws {
    let r = try WorkerRig(scenario: scenario)
    defer { r.teardown() }
    let pid = try r.liveWorkerThenAppGone()
    try r.fileSaysParked()
    r.manager()
    r.firstTick()
    try r.wake("trip")
    #expect(r.wait(10) { r.mgr.tickOnce(); return r.up("trip") && r.starts.count == 2 }, "\(r.why("trip"))")
    #expect(r.entry("trip")?.error == nil)
    #expect(!ProcessInspect.groupAlive(pid), "the old session runs on beside the new one")
    #expect(r.mgr.ownedGroups.contains(r.entry("trip")?.pane_pid ?? -1))
  }

  /// Control: a session under the thread's name that is not a worker (no `--name talos-<id>`) is never signalled; the start says so.
  @Test func aSessionThatIsNotAWorkerIsLeftAlone() throws {
    let r = try WorkerRig(scenario: scenario)
    defer { r.teardown() }
    #expect(r.tmuxCmd(["new-session", "-d", "-s", "t-trip", "--", "/bin/sleep", "60"]).ok)
    let pid = try #require(Int32(r.tmuxCmd(["display-message", "-p", "-t", "=t-trip:", "#{pane_pid}"]).out.trimmingCharacters(in: .whitespacesAndNewlines)))
    r.manager()
    r.firstTick()
    try r.wake("trip")
    r.mgr.tickOnce()
    #expect(r.state("trip") == "failed", "\(r.why("trip"))")
    #expect(ProcessInspect.groupAlive(pid), "a process the app did not start was signalled")
  }

  /// The record of a start is on disk before tmux makes the session, so an app that goes in between leaves a file that says starting.
  @Test func theStartIsOnDiskBeforeTheSessionExists() throws {
    let r = try WorkerRig(scenario: scenario)
    defer { r.teardown() }
    let seen = r.root + "/file-at-new-session"
    let shim = r.root + "/tmux-record"
    try """
    #!/bin/bash
    for a in "$@"; do [ "$a" = new-session ] && cp '\(r.talosHome)/workers.json' '\(seen)' 2>/dev/null; done
    exec '\(Rig.tmuxPath!)' "$@"
    """.write(toFile: shim, atomically: true, encoding: .utf8)
    chmod(shim, 0o755)
    r.manager(tmux: shim)
    try r.wake("trip")
    r.mgr.tickOnce()
    let d = try #require(FileManager.default.contents(atPath: seen), "workers.json did not exist when new-session ran")
    let f = try #require(WorkersFile.decode(d))
    #expect(f.threads["trip"]?.state == "starting", "\(String(describing: f.threads["trip"]))")
  }
}
