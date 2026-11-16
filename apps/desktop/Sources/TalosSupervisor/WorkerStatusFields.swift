import Foundation
import TalosDesktopCore

/// The fields that let `thread_session status` tell the truth (workers.json `stopped_why`, `turn_started_at`; `needs_you` is
/// written from the needs-you flag in `Runtime.persisted`). Kept here so the manager's own file stays under the size limit.
extension WorkerManager {
  /// `stopped_why` for a park asked for with `reason` (the manager's own park reasons), or for the restart it is the first half of.
  static func stoppedWhy(reason: String, afterPark: String?) -> String {
    if afterPark == "restart" || afterPark == "fresh" { return "restart" }
    switch reason {
    case "idle", "cap", "governor", "interrupted": return reason
    case "exited": return "crash"
    default: return "owner"  // a tap (`control`), and the limit a tap set on the turn (`stop_limit`)
    }
  }

  /// Records why the session is going, on the entry, so a relaunched app (and the bridge) still knows.
  func noteStopped(_ id: String, reason: String) {
    let after = rt[id]?.afterPark
    rt[id]?.entry.stopped_why = Self.stoppedWhy(reason: reason, afterPark: after)
    dirty = true
  }

  /// The pane has gone quiet after a pointer: that turn is over. `last_turn_at` is the end of the last finished turn.
  func noteTurnEnded(_ id: String, now t: Double) {
    guard rt[id]?.entry.turn_started_at != nil else { return }
    rt[id]?.entry.turn_started_at = nil
    rt[id]?.entry.last_turn_at = ISOTime.string(t)
    dirty = true
  }
}

extension WorkersFile.Entry {
  /// A start: none of the three describes the new session.
  mutating func clearStatusFields() {
    needs_you = nil
    stopped_why = nil
    turn_started_at = nil
  }
}
