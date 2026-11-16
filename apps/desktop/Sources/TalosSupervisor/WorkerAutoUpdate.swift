import Foundation
import TalosDesktopCore

/// The thread sessions' half of the app updater's quiet rule (`AutoUpdater`): the same quiet as a restart on update waits for
/// (`updateQuiet`: no turn, nothing owed or asking the owner, no draft, no key in an attached client lately, the pane silent).
extension WorkerManager {
  /// Why the thread sessions are not quiet now (empty: quiet), and each running session's pane process, to look under for background
  /// work. A session starting, stopping or busy is not quiet; a parked or stopped one has nothing running.
  public func autoUpdateLook() -> (notQuiet: [String], panes: [Int32]) {
    queue.sync {
      var why: [String] = []
      var panes: [Int32] = []
      for id in rt.keys.sorted() {
        guard let r = rt[id] else { continue }
        if r.adoptPending {
          why.append("thread \(id) being adopted")
          continue
        }
        switch r.entry.state {
        case "live":
          if r.pgid > 0 { panes.append(r.pgid) }
          if !updateQuiet(id) { why.append("thread \(id) busy") }
        case "starting", "busy", "stopping":
          if r.pgid > 0 { panes.append(r.pgid) }
          why.append("thread \(id) \(r.entry.state)")
        default: continue
        }
      }
      // a restart on update under way is work too
      if updateState.current != nil { why.append("a thread restart is under way") }
      return (why, panes)
    }
  }
}
