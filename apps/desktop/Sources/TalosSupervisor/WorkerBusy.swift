import Foundation
import TalosDesktopCore

/// A start over the limit: every quiet session holds background work, and a park would cut it, so none is stopped. The new session
/// starts anyway and its thread gets one plain line. Also the hold a start waits in when every slot is busy (kept here so
/// `WorkerManager.swift` stays inside its size limit).
extension WorkerManager {
  /// Keeps a start for the next tick. `heldSince` stays put, so the hold still ends.
  func hold(_ id: String, resume: Bool, now t: Double, unreadable: Bool = false) {
    if rt[id]?.heldSince == nil { rt[id]?.heldSince = t }
    rt[id]?.heldResume = resume
    rt[id]?.heldUnreadable = unreadable
  }

  /// A start over the limit that really happened (the entry is `starting`; one held or refused is not, and is asked again by
  /// `retryHeld`): logged, and its thread's line kept until it is sent.
  func noteOverLimitStart(_ id: String) {
    guard rt[id]?.entry.state == "starting" else { return }
    audit("worker_start_over_limit thread=\(id)")
    rt[id]?.busyNote.reset()
    rt[id]?.busyLine = BackgroundWork.busyLine
    tellComputerBusy(id)
  }

  /// The "computer is busy" line: sent, and tried again each tick while a clear failure leaves it unsent (like the background-cut
  /// line). One per start, and never more than one in the notice window (`noticeDebounce`, ten minutes), so a thread woken again and
  /// again says it once.
  func tellComputerBusy(_ id: String) {
    guard let line = rt[id]?.busyLine else { return }
    sendNotice(id, \.busyNote, kind: BackgroundWork.busyKind, text: line)
    if rt[id]?.busyNote.sent == true { rt[id]?.busyLine = nil }
  }
}
