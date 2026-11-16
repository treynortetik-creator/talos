import Foundation
import TalosDesktopCore

/// Option C: a thread's tmux session that runs while `workers.json` does not vouch for it. The app went between `new-session` and its
/// record, or before `claimPane` read the pane pid, or an older build left the file saying parked. Left alone it would run on unowned
/// and outside the cap, and every Start, Restart and Start fresh would fail "already running". Only this thread's own worker is ever
/// taken back or stopped: anything else that holds the name is never signalled.
extension WorkerManager {
  /// The pane's process is this thread's worker: the leader of its own group, started with `--name talos-<id>`, and not main.
  func isThreadsWorker(_ id: String, _ snap: ProcessSnapshot, pid: Int32) -> Bool {
    snap.pgid == pid && !WorkerSpec.argvLooksLikeMain(snap.argv)
      && zip(snap.argv, snap.argv.dropFirst()).contains { $0 == "--name" && $1 == WorkerSpec.sessionName(id) }
  }

  /// The session id a worker was started with, from its argv.
  static func sessionId(argv: [String]) -> String? {
    // both forms: `--session-id <id>` (what a worker is started with) and `--session-id=<id>` (Main's form; ResumeRewrite.apply)
    for (k, a) in argv.enumerated() {
      if a == "--session-id" || a == "--resume" { return k + 1 < argv.count ? argv[k + 1] : nil }
      for f in ["--session-id=", "--resume="] where a.hasPrefix(f) { return String(a.dropFirst(f.count)) }
    }
    return nil
  }

  /// A start found the thread's session running while this copy owns no group for it. When it is the thread's own worker it is stopped
  /// like any other (SIGTERM, a short grace, SIGKILL, kill-session) and true is returned: the start goes on. False for anything else, and
  /// for a read that fails: nothing is signalled.
  func stopStrayWorker(_ id: String) -> Bool {
    let read = run(tmux(id).withPane(nil).paneState())
    guard read.ok, let ps = TmuxCommands.parsePaneState(read.out), !ps.dead, let pid = ps.pid, let snap = probe.snapshot(pid),
      isThreadsWorker(id, snap, pid: pid)
    else { return false }
    signaller.own(pid, leaderStart: snap.startTime)
    rt[id]?.pgid = pid
    rt[id]?.paneId = ps.paneId
    if let sid = Self.sessionId(argv: snap.argv) { rt[id]?.entry.session_id = sid }  // the start that follows resumes what it ran
    stopNow(id, why: "restart")  // stopped so this start can go on: the first half of a restart
    audit("worker_stray_stopped thread=\(id)")
    return true
  }
}
