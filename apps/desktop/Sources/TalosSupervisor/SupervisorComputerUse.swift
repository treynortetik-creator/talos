import Foundation
import TalosDesktopCore

/// The computer-use permission dialog on Main's pane (`ComputerUseDismiss` decides; the thread sessions' twin is WorkerComputerUse.swift):
/// Escape and nothing else, on an exact match re-read just before the key; Main is needs-you while it is up; one fixed line to the phone at
/// most once an hour. Past the hourly limit, or when an Escape did not take, it is left on screen and the owner is told Main waits on it.
extension Supervisor {
  func mainComputerUse(_ rows: [String], launch l: inout Launch) {
    let label = DialogMatcher.Screen.computerUsePermissions.label
    let block = DialogMatcher.computerUseBlock(rows)
    let now = options.awake()
    switch recovery.computerUse.look(onScreen: block != nil, now: now) {
    case .fading:
      return  // one look that missed it is not the dialog gone (ComputerUseDismiss.goneAfter)
    case .gone:
      return  // the dialog's `.dialog` needs-you ends with the screen (superviseLive)
    case .press:
      if needsYou == nil { needsYou = .dialog(label) }
      guard let again = host.visibleRows(), !DialogMatcher.takesNoKeys(again), DialogMatcher.computerUseBlock(again) == block else {
        audit("dialog_dismiss_skipped", ["kind": ComputerUseDismiss.auditKind, "why": "screen_changed"])
        return
      }
      let sent = sendKey(.dialog(.computerUse)) { $0.sendEscape() }
      guard sent != .refused else {
        audit("dialog_dismiss_skipped", ["kind": ComputerUseDismiss.auditKind, "why": "refused"])
        return
      }
      guard sent != .failed else {
        audit("dialog_dismiss_failed", ["kind": ComputerUseDismiss.auditKind])
        return
      }
      recovery.computerUse.pressed(now: now)
      audit(ComputerUseDismiss.auditEvent, ["kind": ComputerUseDismiss.auditKind, "session": "main"])
      if recovery.computerUse.mayTellOwner(now: now) {
        _ = postToPhone { _ in ComputerUseDismiss.ownerLine }
      }
    case .pressed(let stuck):
      if needsYou == nil { needsYou = .dialog(label) }
      if stuck { raiseNeedsYou(.dialog(label), key: "stall:\(label)", launch: &l) }
    case .limit(let first):
      if first { audit("dialog_dismiss_limit", ["kind": ComputerUseDismiss.auditKind, "per_hour": "\(ComputerUseDismiss.perHour)"]) }
      raiseNeedsYou(.dialog(label), key: "stall:\(label)", launch: &l)
    }
  }
}
