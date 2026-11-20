import Foundation
import TalosDesktopCore
import TalosSupervisor

/// Needs-you prompts: the sign-in window a login card's button, and the menu item, open, and a thread's Terminals tab for the rest.
extension SupervisorController {
  /// "Sign in to Claude again": the in-app window (link, Copy link, the code box). When Claude says it is signed in, a Main that was waiting
  /// on the sign-in starts again, cleanly (a cold start: `restartCold`); thread sessions pick up the new credentials on their next request.
  /// `startNow`: the owner's own click asked (the popup's button, the menu item), so the login starts when the tools are found. From a needs-you
  /// event the window is only shown, behind nothing and without taking the keyboard; the owner presses the button himself.
  func showSignIn(startNow: Bool) {
    let waiting: Bool = {
      if case .dialog(let l)? = supervisor.status.needsYou { return l == Supervisor.signInLabel || l == DialogMatcher.Screen.loginExpired.label }
      return false
    }()
    SignInCardController.shared.show(config: supervisor.currentConfig(), startNow: startNow) { [weak self] in
      if waiting { self?.supervisor.restartCold() }
    }
  }

  func showThreadTerminal(_ thread: String) {
    TerminalWindowController.shared.attach(model: self)
    TerminalWindowController.shared.show(takeFocus: false, raise: true)
    TerminalWindowController.shared.select(thread, takeKeyboard: false)
  }
}
