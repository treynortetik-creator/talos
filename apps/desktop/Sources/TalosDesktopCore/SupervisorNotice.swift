import Foundation

/// The sentences the menu and Session window show for supervisor events, and when one has gone stale (audit D41, D42).
/// Pure so the wording and the clearing rules are tested without the app.
public enum SupervisorNotice {
  public static let needsYou = "Talos needs you at the Mac"
  public static let restarted = "Talos restarted after a crash and resumed"
  public static let stoppedRestarting = "Talos stopped restarting (crash loop)"
  public static let resumeFailed = "The last conversation can't be resumed"
  public static let confirmFailed = "The restart wasn't confirmed in time; the session is stopped"
  public static let blocked = "Another session holds the channels"
  public static let couldNotStart = "Talos couldn't start"
  public static let crashedNoRestart = "Talos crashed and auto-restart is off"
  public static let restartedOnRequest = "Restarted the agent: asked from your phone"
  public static let autoRestoredCrashLoop = "Talos kept crashing, so it put back the last good setup"
  public static let autoRestoredBridgeDown = "The bridge stayed down, so Talos put back the last good setup"
  public static let restoreNothingToChange = "Tried restoring the last good setup: nothing to change"
  public static let restoreFailed = "Talos couldn't put back the last good setup, so it stopped there and did not restart"
  public static let ignoredOwnerStopped = "Ignored a restart request: you stopped the agent at the Mac."
  public static let ignoredTooSoon =
    "Ignored a restart request: one was acted on less than \(Int(AgentRecovery.requestMinGap / 60)) minutes ago."

  public static func recovery(_ o: AgentRecovery.Outcome) -> String {
    switch o {
    case .restartedOnRequest: return restartedOnRequest
    case .restoreFailed: return restoreFailed
    case .ignoredOwnerStopped: return ignoredOwnerStopped
    case .ignoredTooSoon: return ignoredTooSoon
    case .restored(let why, let result, let restarted):
      let ending = restarted ? " and restarted" : ", but it was not restarted"
      let lead = why == .crashLoop ? autoRestoredCrashLoop : autoRestoredBridgeDown
      switch result {
      case .nothingToChange:
        return restoreNothingToChange + (restarted ? ". Restarted the agent." : ". It was not restarted.")
      case .unknown: return lead + ending
      case .changed(let files, let saved): return "\(lead) (wrote \(files) from the version saved \(saved))\(ending)"
      }
    }
  }

  /// What the owner's phone is told about an automatic restore: the menu's own line, nil when there is nothing to say. Nothing is said
  /// when the restore changed nothing, and nothing for the outcomes that only answer a request from the phone.
  public static func phoneLine(_ o: AgentRecovery.Outcome) -> String? {
    switch o {
    case .restoreFailed: return recovery(o)
    case .restored(_, .nothingToChange, _): return nil
    case .restored: return recovery(o)
    case .restartedOnRequest, .ignoredOwnerStopped, .ignoredTooSoon: return nil
    }
  }

  /// Open Log with no log file yet. It describes a moment: it goes stale once the file exists.
  public static let noLogYet = "No log yet."
  public static func noLogNotice(path: String) -> String { "\(noLogYet) The bridge writes \(path) once it has run." }

  /// Which banner a notice raises. Every stopped or blocked state has one (D42).
  public static func event(for text: String) -> NotificationPolicy.Supervisor? {
    let table: [(String, NotificationPolicy.Supervisor)] = [
      (needsYou, .needsYou), (restarted, .restartedAfterCrash), (stoppedRestarting, .stoppedRestarting),
      (resumeFailed, .resumeFailed), (confirmFailed, .confirmFailed), (blocked, .blocked),
      (couldNotStart, .couldNotStart), (crashedNoRestart, .crashedNoRestart), (autoRestoredCrashLoop, .autoRestored),
      (autoRestoredBridgeDown, .autoRestored), (restoreFailed, .restoreFailed),
    ]
    return table.first { text.hasPrefix($0.0) }?.1
  }

  public enum PhaseKind: Sendable { case running, starting, stopped, other }

  /// A notice describes a moment. "Press Enter" is wrong once the session is gone or no longer waiting; a failure line is wrong
  /// once a new start is under way (D41).
  public static func isStale(_ text: String, phase: PhaseKind, needsYou waiting: Bool, logExists: Bool = false) -> Bool {
    if text.hasPrefix(noLogYet) { return logExists }
    if text.hasPrefix(needsYou) { return !(waiting && (phase == .running || phase == .starting)) }
    let failures = [stoppedRestarting, resumeFailed, confirmFailed, blocked, couldNotStart, crashedNoRestart]
    if failures.contains(where: { text.hasPrefix($0) }) { return phase == .running || phase == .starting }
    return false
  }

  /// Menu line when there is no `desktop.json`. Names only controls that exist.
  public static let notSetUp = "Not set up: Settings… → Session → Find a running session, or import your command"

  /// What a prompt nobody named is, in the owner's words: `a 'Bash command' prompt, "Do you want to proceed?"`. The question is screen
  /// text, cleaned to one short line by the detector; the kind is ours.
  static func promptWhat(_ p: PromptDetector.Prompt) -> String {
    var what = p.title.map { "a '\($0)' prompt" } ?? "a prompt"
    if let q = p.question, !q.isEmpty { what += ", \"\(q)\"" }
    // Claude Code's own countdown (its dangerous-rm prompt, even in bypass mode): it blocks the call itself when it runs out
    if let s = p.autoBlockSeconds {
      what += " (Claude Code blocks it automatically in \(s < 60 ? "under a minute" : "about \((s + 30) / 60) min"))"
    }
    return what
  }

  /// Main's session waits on a prompt of the CLI's: the line for the default thread.
  public static func mainPromptLine(agentName: String?, prompt: PromptDetector.Prompt) -> String {
    "\(agentName ?? "The agent") is waiting on \(promptWhat(prompt)); open Terminal on the Mac to answer."
  }

  /// A thread session waits on a prompt of the CLI's: the line for its own thread (the wording of `WorkerNotice.line`).
  public static func workerPromptLine(threadName: String, prompt: PromptDetector.Prompt) -> String {
    let name = SessionSwitcher.cleanTitle(threadName) ?? "A thread"
    return "\(name)'s session is waiting on \(promptWhat(prompt)); open Terminals \u{2192} \(name) on the Mac to answer."
  }
}
