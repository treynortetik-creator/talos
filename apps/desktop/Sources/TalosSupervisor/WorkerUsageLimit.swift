import Foundation
import TalosDesktopCore

/// Claude Code's usage-limit screen on a thread session's pane (`UsageLimitScreen`): the session is needs-you while it is up, and the
/// thread gets one line per appearance, at most one an hour, naming the model, when it resets if the screen says, and how to go on
/// (Esc in the pane, then `/model`). Talos sends this screen NO key, ever: one of its options spends usage credits. Every key sender checks
/// `DialogMatcher.takesNoKeys` on the rows it is about to press into.
extension WorkerManager {
  func noteUsageLimit(_ id: String, rows: [String]) {
    guard var w = rt[id]?.ul else { return }
    let info = UsageLimitScreen.read(rows)
    let change = w.look(onScreen: info != nil, now: awake())
    rt[id]?.ul = w
    let kind = UsageLimitScreen.kind
    switch change {
    case .none, .fading:
      return
    case .gone:
      rt[id]?.ulLine = nil
      rt[id]?.needsYouResetsAt = nil
      guard rt[id]?.needsYouPrompt == kind else { return }
      rt[id]?.needsYouPrompt = nil
      rt[id]?.dialogSinceAwake = nil
      rt[id]?.dlg.reset()
      dirty = true
      closeNoticeRecord(id)
    case .appeared:
      // the reset as an instant: the next such moment after this read, in the zone the screen names, else the Mac's own
      let at = UsageLimitScreen.resetsAt(info?.resets, after: Date(timeIntervalSince1970: now()), zone: .current)
      rt[id]?.needsYouResetsAt = at.map { ISOTime.string($0.timeIntervalSince1970) }
      dirty = true
      raiseScreenNeedsYou(id, kind: kind)
      let model = info?.model ?? "unnamed"
      if rt[id]?.ul.mayTellOwner(now: awake()) == true {
        rt[id]?.ulLine = UsageLimitScreen.threadLine(info ?? .init())
        audit("usage_limit_seen thread=\(id) model=\"\(WorkerNotice.logValue(model))\" line=yes")
      } else {
        rt[id]?.ulLine = nil
        audit("usage_limit_seen thread=\(id) model=\"\(WorkerNotice.logValue(model))\" line=held_hourly")
      }
      sendUsageLimitLine(id)
    case .still:
      raiseScreenNeedsYou(id, kind: kind)  // a flag the generic screen check cleared meanwhile comes back
      sendUsageLimitLine(id)  // a post that failed is tried again (sendNotice's own rule)
    }
  }

  private func sendUsageLimitLine(_ id: String) {
    guard let line = rt[id]?.ulLine else { return }
    sendNotice(id, \.dlg, kind: UsageLimitScreen.kind, text: line)
  }
}
