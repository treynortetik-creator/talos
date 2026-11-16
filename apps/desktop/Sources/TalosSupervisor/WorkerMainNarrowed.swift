import Foundation
import TalosDesktopCore

/// No thread session under a Main narrowed beyond a worker's reach (`MainNarrowed`). Split out of `WorkerManager` to keep that file
/// under the size limit.
extension WorkerManager {
  /// The narrowing mode Main is in, if any: as it really runs (`mainRunsNarrowed`, what the main session was launched with), or as
  /// the settings would start it now (its arguments, and its environment the way it is built: the login shell's with `desktop.json`
  /// `env` on top). Either one refuses: a Main that is still narrowed until its restart, and one that will be at its next.
  func mainNarrowedMode() -> String? {
    mainRunsNarrowed?() ?? MainNarrowed.mode(args: options.mainArgs, env: baseEnv())
  }

  /// A session that was already running when Main became narrowed (the owner turned a mode on and restarted Main) is as wide as it
  /// was: it is parked after its turn, with no stop limit and nothing queued behind it, and its thread is told. Its next start is
  /// refused (`refuseUnderNarrowedMain`), so its messages go to the main session.
  func parkUnderNarrowedMain() {
    guard let mode = mainNarrowedMode() else { return }
    for id in rt.keys.sorted() {
      guard let r = rt[id], !r.adoptPending, WorkersFile.liveStates.contains(r.entry.state) else { continue }
      audit("worker_parked_main_narrowed thread=\(id) mode=\"\(mode)\"")
      rt[id]?.afterPark = nil
      requestPark(id, reason: "main_narrowed", byOwner: false)
      tell(id, slot: \.ceilingNote, kind: "main narrowed: \(mode)", MainNarrowed.line(mode))
    }
  }

  /// True when the start is refused: the thread is failed with the reason, told once (naming the mode) with the way out, and nothing
  /// was made or parked.
  func refuseUnderNarrowedMain(_ id: String) -> Bool {
    guard let mode = mainNarrowedMode() else { return false }
    audit("worker_start_refused thread=\(id) why=main_narrowed mode=\"\(mode)\"")
    fail(id, "start_failed", MainNarrowed.detail(mode))
    tell(id, slot: \.ceilingNote, kind: "main narrowed: \(mode)", MainNarrowed.line(mode))
    return true
  }
}
