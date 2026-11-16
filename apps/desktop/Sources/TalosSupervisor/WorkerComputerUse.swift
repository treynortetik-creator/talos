import Foundation
import TalosDesktopCore

/// The computer-use permission dialog on a thread session's pane (`ComputerUseDismiss` decides): Escape, and nothing else, on an exact match
/// re-read just before the key; the session is needs-you while the dialog is up; one fixed line to the thread at most once an hour. Past
/// the hourly limit, or when an Escape did not take, the dialog stays for the owner and the thread gets the usual "waiting on" line.
extension WorkerManager {
  /// The needs-you name of the dialog, the same one `noteScreen` gives it.
  static var computerUseKind: String { WorkerNotice.promptName(.computerUsePermissions) }

  func noteComputerUse(_ id: String, rows: [String]) {
    guard var cu = rt[id]?.cu else { return }
    let block = DialogMatcher.computerUseBlock(rows)
    let decision = cu.look(onScreen: block != nil, now: awake())
    rt[id]?.cu = cu
    switch decision {
    case .fading:
      return  // one look that missed it is not the dialog gone (ComputerUseDismiss.goneAfter)
    case .gone:
      guard rt[id]?.needsYouPrompt == Self.computerUseKind else { return }
      rt[id]?.needsYouPrompt = nil
      rt[id]?.dialogSinceAwake = nil
      rt[id]?.dlg.reset()
      dirty = true
      closeNoticeRecord(id)
    case .press:
      raiseScreenNeedsYou(id, kind: Self.computerUseKind)
      // re-read right before the key: Escape only lands on the very dialog that was matched
      let again = run(tmux(id).capturePane())
      let rows = TmuxCommands.parseCapture(again.out)
      guard again.ok, !DialogMatcher.takesNoKeys(rows), DialogMatcher.computerUseBlock(rows) == block else {
        audit("dialog_dismiss_skipped thread=\(id) kind=\(ComputerUseDismiss.auditKind) why=screen_changed")
        return
      }
      guard let sent = sendKey(id, tmux(id).sendEscape(), .dialog(.computerUse)) else {
        audit("dialog_dismiss_skipped thread=\(id) kind=\(ComputerUseDismiss.auditKind) why=refused")
        return
      }
      guard sent.ok || sent.timedOut else {
        audit("dialog_dismiss_failed thread=\(id) kind=\(ComputerUseDismiss.auditKind)")
        return
      }
      rt[id]?.cu.pressed(now: awake())
      audit("\(ComputerUseDismiss.auditEvent) kind=\(ComputerUseDismiss.auditKind) thread=\(id)")
      if rt[id]?.cu.mayTellOwner(now: awake()) == true { postComputerUseLine(id) }
    case .pressed(let stuck):
      raiseScreenNeedsYou(id, kind: Self.computerUseKind)
      if stuck { sendNotice(id, \.dlg, kind: Self.computerUseKind, text: WorkerNotice.line(screen: .computerUsePermissions)) }
    case .limit(let first):
      raiseScreenNeedsYou(id, kind: Self.computerUseKind)
      if first {
        audit("dialog_dismiss_limit kind=\(ComputerUseDismiss.auditKind) thread=\(id) per_hour=\(ComputerUseDismiss.perHour)")
      }
      sendNotice(id, \.dlg, kind: Self.computerUseKind, text: WorkerNotice.line(screen: .computerUsePermissions))
    }
  }

  /// needs-you for a screen handled here rather than by `noteScreen` (the computer-use dialog, the usage-limit screen): `needs_you` in
  /// workers.json, the log line and the event, as `noteScreen` raises them, without its line.
  func raiseScreenNeedsYou(_ id: String, kind: String) {
    guard rt[id]?.needsYouPrompt != kind else { return }
    rt[id]?.needsYouPrompt = kind
    rt[id]?.needsYouAt = ISOTime.string(now())
    rt[id]?.flaggedPrompt = nil
    rt[id]?.dialogSinceAwake = awake()
    rt[id]?.dlg.reset()
    rt[id]?.recordsChecked = true
    dirty = true
    audit("worker_needs_you thread=\(id) prompt=\"\(WorkerNotice.logValue(kind))\"")
    publish()
    emit(.needsYou(thread: id, prompt: kind))
  }

  /// The owner's one line, fixed text, through `postNotice` (a child process: off the queue). Its outcome is in the log.
  private func postComputerUseLine(_ id: String) {
    guard let post = postNotice else { return }
    Thread.detachNewThread { [weak self] in
      let outcome = post(id, ComputerUseDismiss.ownerLine)
      self?.queue.async { self?.audit("worker_notice thread=\(id) kind=\"computer_use_dismissed\" outcome=\(outcome)") }
    }
  }
}
