import Foundation
import TalosDesktopCore

/// Option C: a thread that no longer has its own session (back to shared, archived, deleted) leaves `workers.json` and both session
/// lists once its worker has gone and it has stayed that way for `forgetAfter`. Kept, it stayed listed for ever with a Resume whose
/// wake is dropped (the thread has no settings), so the tap did nothing. Its session id goes with it: switched back to its own session
/// later, the thread starts a new one. The wait means a config read wrongly for a moment (a hand edit, a missing `threads` list) forgets
/// nothing. The master switch turned off forgets nothing either, so turning it back on resumes every thread where it was.
extension WorkerManager {
  static let forgetAfter: Double = 600

  func forgetUndedicated(_ settings: DedicatedSettings) {
    guard settings.enabled else { return absentSince.removeAll() }
    let w = awake()
    for id in Array(absentSince.keys) where rt[id] == nil || settings.threads[id] != nil { absentSince[id] = nil }
    for (id, r) in rt where settings.threads[id] == nil && WorkersFile.restingStates.contains(r.entry.state) && !r.adoptPending {
      guard let since = absentSince[id] else {
        absentSince[id] = w
        continue
      }
      guard w - since >= Self.forgetAfter else { continue }
      rt[id] = nil
      absentSince[id] = nil
      dirty = true
    }
  }
}
