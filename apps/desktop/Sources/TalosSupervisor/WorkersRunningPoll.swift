import Foundation

/// The app's once-a-second look at whether any thread session may be running (`SupervisorController.workersRunning`). Its own
/// type so a test can drive exactly what the app runs, without the GUI.
public enum WorkersRunningPoll {
  /// Hands `anyMayBeRunning` to `deliver`, on the caller's thread. `snapshot()` never waits for the workers' queue, so this
  /// takes no thread from the cooperative pool and a slow tmux cannot pile calls up behind it.
  public static func poll(_ w: WorkerManager, deliver: (Bool) -> Void) {
    deliver(w.snapshot().anyMayBeRunning)
  }
}
