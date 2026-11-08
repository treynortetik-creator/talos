import Foundation
import TalosDesktopCore

/// Option C: what resets a worker's idle clock. Split out of `WorkerManager` to keep that file under the size limit.
extension WorkerManager.Runtime {
  /// What `workers.json` keeps of the idle clock: the last real activity while the worker has a pane (a relaunched app seeds from it),
  /// nothing once it is parked, failed or off.
  var savedActivity: String? {
    let hasPane = WorkersFile.liveStates.contains(entry.state) || entry.state == "parking" || entry.state == "stopping"
    return hasPane && lastActive > 0 ? ISOTime.string(lastActive) : nil
  }

  /// A new pane starts a new watch of the screen: the last pane's text is not what this one is compared with, and a dialog on it has
  /// not been on screen for as long as the old screen was.
  mutating func forgetScreen() {
    body = nil
    screenText = nil
    screenSameSince = 0
  }
}

extension WorkerManager {
  /// The screen above the input box's lower rule is not what it was at the last tick: the session drew something (a turn, a typed
  /// key). Output that leaves it as it was, such as the status line repainting, is not activity. The first look at a pane counts for
  /// nothing: it is the baseline.
  func noteScreen(_ r: inout Runtime, rows: [String], now t: Double) {
    let body = WorkerActivity.body(rows: rows)
    if let before = r.body, before != body { r.lastActive = max(r.lastActive, t) }
    r.body = body
  }

  /// The idle limit has passed on the clock; true when it still has once the owner's keys are counted. A key typed in an attached tmux
  /// client may change nothing on the screen, so the clients' activity times are read here, only when a park is due. A list that can't
  /// be read says no: unread is not "nobody is typing".
  func idleLimitPassed(_ id: String, idle: Double, now t: Double) -> Bool {
    let clients = run(tmux(id).listClientsActivity())
    guard clients.ok, let typed = TmuxCommands.parseClientActivity(clients.out) else { return false }
    if let last = typed.max(), last > (rt[id]?.lastActive ?? 0) { rt[id]?.lastActive = last }
    return t - (rt[id]?.lastActive ?? t) >= idle
  }
}
