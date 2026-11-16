import Foundation
import TalosDesktopCore

/// Option C: a worker the owner has something open on is never the cap's victim. Quiet is not idle when the quiet worker is sitting on
/// a dialog or prompt, owes a pointer, or holds text the owner typed into its input box: stopping it would lose the question, the
/// message or the draft. The cap then picks another quiet worker, or holds the start (`WorkerPolicy.planStart`), the same as when every
/// slot is busy.
extension WorkerManager {
  /// True when this worker is waiting on the owner, or when that cannot be told (a read that fails is never "nothing open").
  func waitsOnOwner(_ id: String, now t: Double) -> Bool {
    guard let r = rt[id] else { return true }
    if r.needsYouPrompt != nil || r.pendingPointer || r.draftSince != nil || r.owed.leftover { return true }
    // the screen as it is now: a dialog just drawn has not been flagged yet, and a draft with no pointer waiting is never tracked
    let capture = run(tmux(id).capturePane())
    guard capture.ok else { return true }
    let rows = TmuxCommands.parseCapture(capture.out)
    let ours = PointerTyper.boxText(rows: rows) == PointerTyper.text  // Talos's own line is not the owner's draft
    if guardShape(rows) != .none || (!ours && draftPresent(id, rows)) { return true }
    // an attached client typed a moment ago: the owner is at the pane
    let clients = run(tmux(id).listClientsActivity())
    guard clients.ok, let activity = TmuxCommands.parseClientActivity(clients.out) else { return true }
    return activity.contains { t - $0 < options.clientQuiet }
  }
}
