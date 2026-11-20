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
  /// desktop.json's saved conversation id is not a session id (a UUID): nothing is started with it. The owner's way on is the menu's
  /// Start a new conversation (or fixing the file). The value is never shown or logged: it is from a file an agent may write.
  public static let sessionIdInvalid =
    "The saved conversation id in desktop.json is not a session id, so Talos did not start Main with it. Start a new conversation, or fix session.id."
  public static let crashedNoRestart = "Talos crashed and auto-restart is off"
  public static let restartedOnRequest = "Restarted the agent: asked from your phone"
  public static let autoRestoredCrashLoop = "Talos kept crashing, so it put back the last good setup"
  public static let autoRestoredBridgeDown = "The bridge stayed down, so Talos put back the last good setup"
  public static let restoreNothingToChange = "Tried restoring the last good setup: nothing to change"
  public static let restoreFailed = "Talos couldn't put back the last good setup, so it stopped there and did not restart"
  public static let cleanExitLoop = "Talos stopped restarting: the agent keeps exiting cleanly"
  /// `desktop.json` is there and cannot be read. The line names what was not done and what to do; it starts with `couldNotStart`
  /// so it raises that banner and is told apart from every other notice by `isConfigUnreadable`.
  public static let configUnreadable =
    couldNotStart + ": its settings file (desktop.json) can't be read. Nothing was started and no setting will be saved. "
    + "Fix the file or move it out of its folder, then quit and reopen Talos."
  public static let configUnreadableStatus = "Settings file can't be read: nothing started, nothing saved"
  public static let configUnreadableShort = "desktop.json can't be read, so nothing was started or saved"
  public static let ignoredOwnerStopped = "Ignored a restart request: you stopped the agent at the Mac."
  public static let ignoredTooSoon =
    "Ignored a restart request: one was acted on less than \(Int(AgentRecovery.requestMinGap / 60)) minutes ago."

  /// The line for Main running without its bridge.
  public static func bridgeNotLive(_ reason: String?) -> String {
    let base = "Main is running but its Talos bridge didn't start"
    guard let reason = reason?.trimmingCharacters(in: .whitespacesAndNewlines), !reason.isEmpty else { return base }
    return base + ": " + reason
  }

  /// Main's bridge is live but has not reached the relay for `MainRestartContract.relayDownS`: the phone gets nothing.
  public static func relayUnreachable(closeCode: Int?) -> String {
    "Talos bridge is running but can't reach the relay, so your phone gets nothing" + (closeCode.map { " (last close code \($0))" } ?? "")
  }

  /// Main was told about an owner message, has done nothing about it for `MainRestartContract.unseenS`, and its pane has printed
  /// nothing since. Nothing is restarted: the owner looks.
  public static let mainNotReading =
    "Main isn't picking up messages: one has waited over \(Int(MainRestartContract.unseenS / 60)) minutes and its screen "
    + "hasn't changed. Look at the pane; nothing was restarted"

  /// Main got an owner message (at `since`) and has shown no progress for `MainRestartContract.stallS`. With nothing done
  /// (`did == .none`: the unstick is off, or was not allowed to act) nothing is pressed or re-sent, a long think can look the same,
  /// so the owner decides; otherwise the line says what Talos did, in the minutes the request had been stuck.
  public static func mainStalled(since: Date, did: MainWatch.Unstick = .none, timeZone: TimeZone = .current) -> String {
    let lead = { (min: Int) in "Main looked stuck for \(min) min on your message; Talos pressed Esc" }
    switch did {
    case .awaiting(let min): return lead(min) + " and is sending it again"
    case .resent(let min): return lead(min) + " and sent it again"
    case .failed(let min): return lead(min) + " but couldn't send your message again; please resend it"
    case .none: break
    }
    let f = DateFormatter()
    f.timeStyle = .short
    f.dateStyle = .none
    f.timeZone = timeZone
    return "Main got your message at \(f.string(from: since)) and has shown no progress for \(Int(MainRestartContract.stallS / 60)) min: its model "
      + "request may be stuck (a long think can look the same). Press Esc in its pane to cancel, then send again"
  }

  /// Main's turn ended on an empty thinking block with no answer (nothing pressed): the owner's message was delivered again, or could not be.
  public static let missedTurnResent = "Your agent missed your message; sent it again"
  /// The re-delivered message was missed too: nothing more is sent by itself.
  public static let missedTurnAgain = "Your agent missed your message again; please send it again or restart it"
  public static let missedTurnFailed = "Your agent missed your message and Talos couldn't send it again; please send it again"

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
      (autoRestoredBridgeDown, .autoRestored), (restoreFailed, .restoreFailed), (cleanExitLoop, .stoppedRestarting),
    ]
    return table.first { text.hasPrefix($0.0) }?.1
  }

  public enum PhaseKind: Sendable { case running, starting, stopped, other }

  /// A notice describes a moment. "Press Enter" is wrong once the session is gone or no longer waiting; a failure line is wrong
  /// once a new start is under way (D41).
  public static func isStale(_ text: String, phase: PhaseKind, needsYou waiting: Bool, logExists: Bool = false) -> Bool {
    if text.hasPrefix(noLogYet) { return logExists }
    if text.hasPrefix(needsYou) { return !(waiting && (phase == .running || phase == .starting)) }
    if text == configUnreadable { return false }  // it stands for the whole run: no start can follow it
    let failures = [stoppedRestarting, resumeFailed, confirmFailed, blocked, couldNotStart, crashedNoRestart, cleanExitLoop]
    if failures.contains(where: { text.hasPrefix($0) }) { return phase == .running || phase == .starting }
    return false
  }

  /// Menu line when there is no `desktop.json`. Names only controls that exist.
  public static let notSetUp = "Not set up: Settings… → Session → Find a running session, or import your command"

  /// What a prompt nobody named is, in the owner's words: `a 'Bash command' prompt`. Only the kind, which is ours (`Prompt.title`, a
  /// fixed table). The question on the pane is never quoted: it is screen text an agent or a file in a repository can write, and the
  /// line is a system row in the thread, which Main reads as Talos speaking. The owner reads the question in Terminals.
  static func promptWhat(_ p: PromptDetector.Prompt) -> String {
    var what = p.title.map { "a '\($0)' prompt" } ?? "a prompt"
    // Claude Code's own countdown (its dangerous-rm prompt, even in bypass mode): it blocks the call itself when it runs out
    if let s = p.autoBlockSeconds {
      what += " (Claude Code blocks it automatically in \(s < 60 ? "under a minute" : "about \((s + 30) / 60) min"))"
    }
    return what
  }

  /// What the menu's needs-you line says about a dialog on Main's pane, by its label (`DialogMatcher.Screen.label`). A dialog that is never
  /// to be answered (`answerless`) gets the one key that is safe there, never "answer".
  public static func mainDialog(_ label: String) -> String {
    if label == "sign in" || label == DialogMatcher.Screen.loginExpired.label {
      return "Claude is signed out. Choose Sign in to Claude again in the menu bar item"
    }
    if label == "api key" { return "Claude found an API key in your environment and is asking whether to use it. Answer in the Talos popup" }
    if label == DialogMatcher.Screen.mcpConsent.label { return "Claude is asking whether to use a project MCP server. Answer in the Talos popup" }
    if label == DialogMatcher.Screen.bypassDisclaimer.label { return "Claude is asking whether to run with permission checks off. Answer in the Talos popup" }
    guard DialogMatcher.Screen.answerless(label: label) else { return "\(label) on screen" }
    if label == UsageLimitScreen.kind { return UsageLimitScreen.menuLine }
    return "the \(label) dialog is on Main's pane; press Esc there to close it (Esc only: Enter opens System Settings)"
  }

  /// Main's session waits on a prompt of the CLI's: the line for the default thread.
  public static func mainPromptLine(agentName: String?, prompt: PromptDetector.Prompt) -> String {
    "\(agentName ?? "The agent") is waiting on \(promptWhat(prompt)); open Terminal on the Mac to answer."
  }

  /// A thread session waits on a prompt of the CLI's: the line for its own thread (the wording of `WorkerNotice.line`, and like it
  /// without the thread's name).
  public static func workerPromptLine(prompt: PromptDetector.Prompt) -> String {
    "This thread's session is waiting on \(promptWhat(prompt)); open this thread in Terminals on the Mac to answer."
  }
}

/// What the menu says about thread sessions, kept apart from Main's own notice. Main's line goes stale by Main's phase and
/// Main's question; a thread session's line has nothing to do with either, so it is judged by what the worker manager says
/// about that thread now: a waiting line shows while the thread still waits, a failure line while its record still says failed.
public struct ThreadNotices: Equatable, Sendable {
  public enum Kind: Equatable, Sendable {
    /// Its pane shows a prompt. The words shown are the prompt as it is now, not as it was when this was set.
    case waiting
    /// The line telling the thread about the prompt could not be posted.
    case untold
    /// The session ended as failed, with the manager's code (`crash_loop`, `start_failed`, `needs_mac` …).
    case failed(code: String)
  }

  private struct Item: Equatable, Sendable {
    var thread: String
    var kind: Kind
  }
  /// One line per thread, the newest last.
  private var items: [Item] = []

  public init() {}

  /// The thread's line is now this one. An older line for the same thread is replaced.
  public mutating func set(_ kind: Kind, thread: String) {
    items.removeAll { $0.thread == thread }
    items.append(Item(thread: thread, kind: kind))
  }

  /// The thread's session started again: whatever was said about it is over.
  public mutating func clear(thread: String) { items.removeAll { $0.thread == thread } }

  /// The menu line: the newest line that is still true, and how many more there are. Empty when none is.
  /// `waiting` is thread id to prompt (the manager's `needsYou()`), `failed` the threads whose record says failed, `names` thread
  /// id to display name. A thread with no name is shown by its id.
  public func line(waiting: [String: String], failed: Set<String>, names: [String: String]) -> String {
    let live = items.filter { item in
      switch item.kind {
      case .waiting, .untold: return waiting[item.thread] != nil
      case .failed: return failed.contains(item.thread)
      }
    }
    guard let newest = live.last else { return "" }
    let name = Self.name(newest.thread, names: names)
    let text: String
    switch newest.kind {
    case .waiting: text = Self.waitingLine(name: name, prompt: waiting[newest.thread] ?? "")
    case .untold: text = Self.untoldLine(name: name)
    case .failed(let code): text = Self.failedLine(name: name, code: code)
    }
    return live.count > 1 ? "\(text) (+\(live.count - 1) more in Terminals…)" : text
  }

  /// The thread's name as config.json has it, cleaned to one short line; its id when it has none.
  public static func name(_ thread: String, names: [String: String]) -> String {
    names[thread].flatMap { SessionSwitcher.cleanTitle($0) } ?? SessionSwitcher.cleanTitle(thread) ?? "A thread"
  }

  /// The prompt names (`WorkerNotice.promptName`) whose questions come as a card and a Talos popup with buttons: no terminal in their line.
  static let answeredOnCard: Set<String> = ["approve a project MCP server", "bypass permissions", "development channels"]

  public static func waitingLine(name: String, prompt: String) -> String {
    if answeredOnCard.contains(prompt) {
      return "\(SupervisorNotice.needsYou): the \(name) session is waiting on a '\(prompt)' prompt. Answer it on its card or in the Talos popup."
    }
    let what = prompt.isEmpty ? "a prompt" : "a '\(prompt)' prompt"
    return "\(SupervisorNotice.needsYou): the \(name) session is waiting on \(what). Open Terminals…"
  }

  public static func untoldLine(name: String) -> String {
    "Couldn't tell the \(name) thread its session is waiting on a prompt. Open Terminals… to answer it."
  }

  /// One plain sentence per code, without the pointer to Terminals: the banner's words.
  public static func failedSentence(name: String, code: String) -> String {
    switch code {
    case "crash_loop": return "The \(name) session kept crashing, so it was stopped"
    case "start_failed": return "The \(name) session didn't start"
    case "needs_mac": return "The \(name) session stopped at a question only this Mac can answer"
    case "resume_missing": return "The \(name) session's conversation can't be resumed"
    case "folder_claimed": return "The \(name) session didn't start: another thread session works in that folder"
    case "mode_escalation_denied": return "The \(name) session wasn't started: it would have more access than the main session"
    default: return "The \(name) session stopped and needs attention"
    }
  }

  public static func failedLine(name: String, code: String) -> String {
    failedSentence(name: name, code: code) + ". Open Terminals… for the reason."
  }

  /// The banner for a thread session that failed. One tag per thread, so a second failure of the same thread replaces the first.
  public static func failedBanner(agent: String, thread: String, name: String, code: String) -> NativeNotice {
    NativeNotice(
      title: NotificationPolicy.cleanAgentName(agent), body: failedSentence(name: name, code: code), navigate: nil,
      tag: "worker:failed:\(thread)", quiet: false, opensTerminal: true)
  }
}

/// The Talos home the thread sessions run from is chosen when their manager is built. `desktop.json` can name another one later
/// (an imported command with `TALOS_APP_HOME=`), and Main and its bridge follow it at their next start. What the manager does then:
public enum TalosHomeChange {
  public enum Plan: Equatable, Sendable {
    case same
    /// Nothing of ours runs from the old home: stop watching it and start again from the new one.
    case move
    /// A thread session may be running from the old home. Moving would orphan it, so the owner is told to restart Talos.
    case restartNeeded
  }

  public static func plan(built: String, wanted: String, workersMayRun: Bool) -> Plan {
    if same(built, wanted) { return .same }
    return workersMayRun ? .restartNeeded : .move
  }

  /// Two spellings of one folder (a trailing slash, `/./`) are the same home.
  public static func same(_ a: String, _ b: String) -> Bool {
    (a as NSString).standardizingPath == (b as NSString).standardizingPath
  }

  /// `TALOS_APP_HOME` from desktop.json's `env`, else the app's own environment, else the default. An empty value is no value.
  public static func home(configEnv: [String: String], processEnv: [String: String], userHome: String) -> String {
    func set(_ v: String?) -> String? { v.flatMap { $0.isEmpty ? nil : $0 } }
    return set(configEnv["TALOS_APP_HOME"]) ?? set(processEnv["TALOS_APP_HOME"]) ?? userHome + "/.config/talos/app"
  }

  public static let restartPrefix = "The Talos home changed"
  public static func restartNotice(to home: String) -> String {
    "\(restartPrefix) to \(home), but thread sessions are still running from the old one. Quit and reopen Talos to move them."
  }
}
