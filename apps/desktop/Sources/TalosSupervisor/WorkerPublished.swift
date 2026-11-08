import Foundation
import TalosDesktopCore

/// The read side of the worker manager. A tick holds the workers' queue for as long as its tmux calls take (10 s each), so a read
/// that took the queue was held behind it: the app's per-second poll piled one blocked thread per second onto the cooperative pool,
/// and the Terminals window stalled the main thread. Reads take only `publishedLock` and return what the queue last published.
extension WorkerManager {
  struct Published {
    var file: WorkersFile
    var needsYou: [String: String]
    /// The dialogs a popup may show (WorkerDialogPopup.swift).
    var popup: [NeedsYouPopupItem]
  }

  /// The thread sessions as of the last tick. Never waits for the queue, so no caller (the main thread, the cooperative pool) can
  /// be held behind a slow tmux.
  public func snapshot() -> WorkersFile { published().file }

  func published() -> Published { publishedLock.withLock { _published } }

  /// Replaces what reads return. On the queue, after anything that changes it: the end of each tick, `tune`, `stopAll`.
  func publish() {
    let p = Published(file: fileModel(), needsYou: rt.compactMapValues { waitingOn($0) }, popup: popupItems())
    publishedLock.withLock { _published = p }
  }
}
