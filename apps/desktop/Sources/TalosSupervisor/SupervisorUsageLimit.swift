import Foundation
import TalosDesktopCore

/// Claude Code's usage-limit screen on Main's pane (`UsageLimitScreen`; the thread sessions' twin is WorkerUsageLimit.swift). Main is
/// needs-you while it is up (`needs_you` in main-restart-check.json, with the screen's own kind), Terminals is not brought forward
/// (`opensTerminal`: the screen is `answerless`), and the phone gets one line per appearance, at most one an hour, naming the model, when
/// it resets if the screen says. Talos presses no row of it: one of its options spends usage credits. Its choices (Stop and wait, Switch model)
/// are the Mac popup and the phone card (`SupervisorPanePrompt.swift`), and their keys are the card's own (`KeyGuard.Intent.usageLimit`).
extension Supervisor {
  func mainUsageLimit(_ rows: [String], launch l: inout Launch) {
    let info = UsageLimitScreen.read(rows)
    let now = options.awake()
    switch recovery.usageLimit.look(onScreen: info != nil, now: now) {
    case .none, .fading:
      return
    case .gone:
      recovery.restartCheck.resetsAt = nil  // the `.dialog` needs-you ends with the screen (superviseLive)
      return
    case .still:
      if needsYou == nil { needsYou = .dialog(UsageLimitScreen.kind) }
    case .appeared:
      // the reset as an instant: the next such moment after this read, in the zone the screen names, else the Mac's own
      let read = Date(timeIntervalSince1970: options.wallClock() / 1000)
      recovery.restartCheck.resetsAt = UsageLimitScreen.resetsAt(info?.resets, after: read, zone: .current)?.timeIntervalSince1970
      recovery.restartCheck.dirty = true
      raiseNeedsYou(.dialog(UsageLimitScreen.kind), key: "stall:\(UsageLimitScreen.kind)", launch: &l)
      let model = info?.model ?? "unnamed"
      guard recovery.usageLimit.mayTellOwner(now: now) else {
        audit("usage_limit_seen", ["model": model, "line": "held_hourly"])
        return
      }
      audit("usage_limit_seen", ["model": model, "line": "yes"])
      // fixed words and values rebuilt from Talos's own lists (UsageLimitScreen.Info): nothing of the screen, so the Mac may post it
      let line = UsageLimitScreen.mainLine(info ?? .init())
      _ = postToPhone { _ in line }
    }
  }
}
