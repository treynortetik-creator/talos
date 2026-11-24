import Foundation
import TalosDesktopCore

extension WorkerManager {
  /// A failed has-session is proof the session is gone only when tmux itself said so. What a refused socket prints ("no server running on
  /// <path>") is also what a busy live server prints: it proves it only with no socket file at all, or the thread's agent group gone too.
  /// A refusal with that group alive (or not known) is "unknown", never "gone": a live agent is neither parked nor started a second time.
  func goneForSure(_ r: RunResult, group: Int32?) -> Bool {
    guard TmuxCommands.saysGone(status: r.status, stderr: r.err, timedOut: r.timedOut) else { return false }
    guard TmuxCommands.saysSocketGone(status: r.status, stderr: r.err, timedOut: r.timedOut) else { return true }
    // the socket file can vanish under a live server: with the thread's agent known, only its group being gone is proof
    if let g = group, g > 0 { return !signaller.leaderAlive(g) }
    // no agent known for this thread (parked, or never started): a server process still running for the socket is a refusing server
    return !serverProcessRuns()
  }

  /// Whether a tmux SERVER process of this user runs for the workers' private socket (see `TmuxPtyHost.listsServer`). Unreadable: yes.
  func serverProcessRuns() -> Bool {
    let r = ProcessRunner.run(["/bin/ps", "-u", "\(getuid())", "-o", "command="], env: ["PATH": "/usr/bin:/bin"], timeout: 5)
    guard r.ok else { return true }
    return TmuxPtyHost.listsServer(r.out, socket: options.socket)
  }
}
