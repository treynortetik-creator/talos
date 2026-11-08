import Foundation

/// Needs-you prompts: "Open on the Mac" on a login card. The owner's own tap, so it opens Terminals even inside the quiet window (quiet
/// hours stop notifying him, not the app acting on his tap), forward but not key: a stray keystroke elsewhere cannot land in a dialog.
extension SupervisorController {
  func showThreadTerminal(_ thread: String) {
    TerminalWindowController.shared.attach(model: self)
    TerminalWindowController.shared.show(takeFocus: false)
    TerminalWindowController.shared.select(thread, takeKeyboard: false)
  }
}
