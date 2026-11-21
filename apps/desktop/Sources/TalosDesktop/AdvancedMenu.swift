import AppKit
import SwiftUI
import TalosDesktopCore

/// The menu bar menu's Advanced submenu: the engineer items (the agent's own screen, the commands to copy, taking over a running
/// agent, the problem report). Technical words are allowed here and nowhere else in the menu (`MacWordsGuardTests`).
struct AdvancedMenuItems: View {
  @ObservedObject var model: SupervisorController
  var openWindow: (String) -> Void
  /// A test draws the submenu's items as a plain list (a picture of the open submenu); the real menu uses the submenu.
  var asList = false

  var body: some View {
    if asList { items } else { Menu(MacWords.advancedMenu) { items } }
  }

  @ViewBuilder private var items: some View {
    Group {
      Button(MacWords.showAgentScreen) {
        TerminalWindowController.shared.attach(model: model)
        TerminalWindowController.shared.show()
      }
      Button(MacWords.copyTerminalCommand) { model.copyTerminalCommand() }.disabled(!model.configured)
      if model.hostKind == .tmux { Button(MacWords.copyAttachCommand) { model.copyAttachCommand() } }
      Divider()
      Button(MacWords.takeOver) { SettingsRouter.openAdopt(model: model) { openWindow($0) } }
      Button(OnboardingCopy.menuUseFolder) {
        openWindow("advanced-setup")
        NSApp.activate(ignoringOtherApps: true)
      }
      Divider()
      Button(MacWords.showProblemReport) { TalosApp.openLog(model: model) }
    }
  }
}
