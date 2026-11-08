import AppKit
import Foundation
import TalosDesktopCore

/// The Terminal screen's tabs in the Talos window: the list pushed to the page, Resume, and the Ctrl+1 … Ctrl+9 chord that is
/// taken before the embedded terminal sees it. Kept apart from `WebWindow.swift` (the stored state stays there).
extension WebController {
  /// The page is on (or has been on) the Terminal screen: keep its tab list current while the window is up. Pushes at once, then
  /// every 1.5 s when something changed. Needs a signed-in page that can read the list.
  func startTerminalSessions() {
    guard pageReady, signedIn, pageFeatures.contains(Self.tabsFeature) else {
      logTabs(snapshot: "unchecked", sent: "skip")
      return
    }
    pushTerminalSessions()
    guard sessionsTimer == nil else { return }
    sessionsTimer = Timer.scheduledTimer(withTimeInterval: 1.5, repeats: true) { [weak self] _ in
      Task { @MainActor in self?.pushTerminalSessions() }
    }
  }

  /// The page left the Terminal screen (or a dialog covers it): no timer. What was last sent stands in the page's store.
  func pauseTerminalSessions() {
    sessionsTimer?.invalidate()
    sessionsTimer = nil
  }

  /// The page is gone or signed out: no timer, and the next page gets the whole list again.
  func stopTerminalSessions() {
    pauseTerminalSessions()
    lastSessionsSent = nil
  }

  /// One diagnostic line when the state of the tab list changes (DesktopLog): which guard holds it back, as booleans and counts.
  func logTabs(snapshot: String, sent: String) {
    let visible = windowVisibleForTest ?? (window?.isVisible == true)
    DesktopLog.tabs(
      "pageReady=\(pageReady) signedIn=\(signedIn) feature=\(pageFeatures.contains(Self.tabsFeature)) visible=\(visible) snapshot=\(snapshot) sent=\(sent)")
  }

  /// Sends the list when it differs from the last one sent. A window that is hidden sends nothing.
  func pushTerminalSessions() {
    let visible = windowVisibleForTest ?? (window?.isVisible == true)
    guard pageReady, signedIn, pageFeatures.contains(Self.tabsFeature), visible else {
      logTabs(snapshot: "unchecked", sent: "skip")
      return
    }
    guard let snap = terminalSessionSource.snapshot() else {
      logTabs(snapshot: "nil", sent: "skip")
      return
    }
    let items = TerminalSessions.sendable(TerminalSessions.items(entries: snap.entries, workers: snap.workers))
    guard items != lastSessionsSent else {
      logTabs(snapshot: "\(snap.entries.count) entries", sent: "\(items.count)")  // already on the page
      return
    }
    // remembered only once it went: a send that failed is tried again on the next look, not taken for done
    let went = deliver(.terminalSessions(items))
    if went { lastSessionsSent = items }
    logTabs(snapshot: "\(snap.entries.count) entries", sent: went ? "\(items.count)" : "skip")
    // the embedded view follows a session that left the list (archived): it shows the "gone" note, never someone else's pane
  }

  /// The owner pressed Resume or Start on a parked thread's panel. Honoured only for a thread the list shows as resumable now,
  /// through the same request the Terminals window makes; the page is always told what happened.
  func terminalResume(_ id: String) {
    guard pageReady, signedIn else { return }
    var outcome = TerminalSessions.ResumeOutcome.failed
    if let snap = terminalSessionSource.snapshot(),
      TerminalSessions.mayResume(id, entries: snap.entries, workers: snap.workers)
    {
      outcome = terminalSessionSource.resume(id)
    }
    deliver(.terminalResumeResult(threadId: id, outcome: outcome))
    pushTerminalSessions()
  }

  /// Called by the window for every key event before anything sees it. Only a bare Ctrl+digit typed while the embedded terminal
  /// holds the keyboard is ours; every other key goes on untouched.
  func interceptKey(_ event: NSEvent) -> Bool {
    guard let n = EmbeddedTerminal.controlDigit(event), terminal.isOpen, terminal.holdsKeyboard(window?.firstResponder) else { return false }
    return terminalControlDigit(n)
  }

  /// Ctrl+1 … Ctrl+9 typed into the embedded terminal. With the tabs showing, the key switches the tab here and the page is told
  /// so its strip follows (true: the key goes no further, so no control byte reaches the session). Without tabs it is false and
  /// the terminal gets the key like any other.
  func terminalControlDigit(_ n: Int) -> Bool {
    guard pageReady, signedIn, let items = lastSessionsSent, !items.isEmpty else { return false }
    if let target = items.first(where: { $0.key == String(n) }) {
      terminal.select(target.id, keepKeyboard: true)
      deliver(.terminalSelect(session: target.id))
    }
    return true  // a number with no tab does nothing (and is not typed into the session either)
  }
}
