import Foundation
import TalosDesktopCore

/// Main's answer to the development-channels warning (`AutoConfirmGuard` holds the conditions). This file decides, presses, and holds the one
/// refusal path (`devDialogRefused`).
extension Supervisor {
  enum DevConfirm {
    /// The one Enter was sent (or may have been: a timeout counts).
    case sent
    /// The send failed outright: nothing arrived, the next tick looks again.
    case notSent
    case refused(AutoConfirmGuard.Refusal)
  }

  /// The pane's process ended after the owner tapped "Exit" on the card: the same state as his Stop (`.stopped(.user)`), so nothing restarts into
  /// the same dialog, no second card comes and no crash-loop message is posted, until he starts it again.
  func stopsForOwnerExit(_ l: Launch) -> Bool {
    guard l.devCard.ownerExit else { return false }
    audit("dev_card_exit_stop", ["session": l.sessionId])
    finishStop(.user, closeHost: true)
    return true
  }

  /// An attached tmux client typed within `devDialogClientQuiet`, or the clients could not be read. Fails closed: unlike the prompt
  /// watcher's `ownerIsTyping`, "I could not look" is not "nobody is typing", because a key goes into a dialog.
  func clientsMayBeTyping() -> Bool {
    guard let times = host.clientActivities() else { return true }
    guard let last = times.max() else { return false }
    return options.wallClock() / 1000 - last < timings.devDialogClientQuiet
  }

  private func devDialogInputs(_ screen: DialogMatcher.Screen, _ l: Launch, _ loop: CrashLoop, _ now: Double) -> AutoConfirmGuard.Inputs {
    let enabled = config.autoConfirmRestart
    return AutoConfirmGuard.Inputs(
      enabled: enabled, isMain: options.name == TmuxCommands.mainSession, launchedChannels: l.launchedChannels, screen: screen,
      // none stored yet, no seal, a seal that does not verify, or no key all count as changed: fail closed, the owner confirms
      launchChanged: !LaunchSeal.isConfirmed(config, fingerprint: l.fingerprint, parts: l.parts, trust: options.launchTrust),
      // the awake clock, so a Mac asleep with the dialog open does not use the window up
      secondsSinceSpawn: options.awake() - l.awakeStartedAt, confirmsThisStart: l.confirmsSent,
      clientsMayBeTyping: enabled && clientsMayBeTyping(), loop: loop, now: now)
  }

  /// The decision, the decision again (so the typing check is read twice), a fresh read of the screen (the same warning must still be
  /// there), and the one Enter straight after it: nothing slow sits between that last look and the key.
  func confirmDevDialog(_ screen: DialogMatcher.Screen, launch l: inout Launch, loop: CrashLoop, now: Double) -> DevConfirm {
    if case .refuse(let why) = AutoConfirmGuard.decide(devDialogInputs(screen, l, loop, now)) { return .refused(why) }
    if case .refuse(let why) = AutoConfirmGuard.decide(devDialogInputs(screen, l, loop, now)) { return .refused(why) }
    guard let rows = host.visibleRows(), DialogMatcher.classify(rows) == screen else { return .refused(.screenChanged) }
    // A definite failure (no pane, tmux exited non-zero) means the Enter never arrived: it does not count, and the next tick tries
    // again. A timeout may have delivered it, and the rule is never press twice, so it counts.
    if host.send(keys: [0x0d]) == .failed {
      audit("auto_confirm_send_failed", ["session": l.sessionId, "pid": "\(l.childPid)"])
      return .notSent
    }
    l.confirmsSent += 1
    // After the send returns, not the tick's start: host.send and visibleRows can each block for seconds, and the agent's
    // noticeWait begins when the Enter has been delivered.
    l.confirmSentAt = clock.now()
    var shown: [String] = []
    if case .devChannels(let d) = screen { shown = d.channels ?? [] }
    // The one line for every auto-accept (the time is the log's own).
    audit(
      "auto_confirm",
      [
        "session": l.sessionId, "pid": "\(l.childPid)", "kind": l.kind.rawValue, "channels": shown.joined(separator: ","),
        "cli": l.cliVersion ?? "unknown",
      ])
    return .sent
  }

  /// Refusals that can clear by themselves within a moment: a client's last key ages out, a screen read mid-redraw settles. Held back
  /// for `devRefusalHold` passes before the owner (and the phone) is told, so a blink never pages anyone and then answers itself. The
  /// others (channels, highlight, two titles, the window, the rate limit, a changed launch, the setting off) wait for the owner at once.
  static func mayClearByItself(_ why: AutoConfirmGuard.Refusal) -> Bool { why == .clientsMayBeTyping || why == .screenChanged }
  static let devRefusalHold = 3

  /// THE place where a refused warning is handled: the one named function a later card for the owner hooks into. `why` is the guard's
  /// reason and `dialog` what was parsed off the screen (its channels, highlighted row and counts). Today: the reason goes to the log
  /// once, nothing is pressed, and the owner is told once, in the same words as before the rule changed (a cold start: press Enter in the
  /// pane, plus the phone post of a recovery's cold start; a restart: why it was not confirmed). A later reading may name another reason
  /// (the first came from a screen still being drawn): the question's reason is replaced, nobody is told again.
  func devDialogRefused(_ why: AutoConfirmGuard.Refusal, dialog: DialogMatcher.DevChannels, launch l: inout Launch) {
    if l.devRefusal != why {
      l.devRefusal = why
      l.devRefusalPasses = 0
      audit("auto_confirm_refused", ["kind": l.kind.rawValue, "reason": why.rawValue, "session": l.sessionId])
    }
    l.devRefusalPasses += 1
    if Self.mayClearByItself(why), l.devRefusalPasses < Self.devRefusalHold { return }
    offerDevDialog(dialog, launch: &l)  // the card for the owner, besides the Mac popup and the terminal
    guard l.kind == .supervisorRestart else { return raiseNeedsYou(.confirmColdStart, key: "cold", launch: &l) }
    if l.notifiedScreens.contains("refuse"), case .restartNotConfirmed(let told) = needsYou {
      if told != why {
        needsYou = .restartNotConfirmed(why)
        l.question = needsYou
        audit("needs_you_reason", ["why": "refuse", "reason": why.rawValue])
      }
    } else {
      raiseNeedsYou(.restartNotConfirmed(why), key: "refuse", launch: &l)
    }
  }
}
