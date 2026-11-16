import Foundation

/// "Quit and stop": every thread session is stopped and left parked, so nothing runs or starts with no supervisor. The quit's time limit
/// is a timer on the main thread, so the stop must never hold the main thread: `beginStopAll` only asks, on the workers' queue, and
/// returns; `isAllStopped` says when it is done. A tick in flight (its tmux calls take up to `callTimeout` each) finishes first.
extension WorkerManager {
  /// Starts the stop and returns at once. Safe from the main thread.
  public func beginStopAll() {
    publishedLock.withLock { _allStopped = false }
    queue.async { self.stopAllLocked() }
  }

  /// Whether the stop asked for by `beginStopAll` (or `stopAll`) has finished. Never waits for the queue.
  public var isAllStopped: Bool { publishedLock.withLock { _allStopped } }

  /// The same stop, waited for (tests, and a caller that is not the main thread).
  public func stopAll() {
    publishedLock.withLock { _allStopped = false }
    queue.sync { stopAllLocked() }
  }

  /// On the queue. A passive copy runs nothing, so it stops nothing and writes nothing.
  private func stopAllLocked() {
    defer {
      publish()
      publishedLock.withLock { _allStopped = true }
    }
    endSupervision()
    stopped = true
    guard lockFd >= 0 else { return }
    for id in Array(rt.keys) {
      rt[id]?.heldSince = nil
      rt[id]?.pendingPointer = false
      rt[id]?.afterPark = nil
      if rt[id]?.adoptPending == true { adoptOne(id, now: now()) }  // what still can't be read stays for the next launch
    }
    // a start whose `new-session` timed out has no pane id and no group yet: its session is ended by name
    for (id, r) in rt where r.pgid > 0 || r.paneId != nil || (r.entry.state == "starting" && !r.adoptPending) { stopNow(id, why: "owner") }
    writeFile()
  }
}
