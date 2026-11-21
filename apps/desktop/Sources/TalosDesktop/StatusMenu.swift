import AppKit
import SwiftUI
import TalosDesktopCore
import TalosSupervisor

/// What the menu bar item's menu holds. Its own view (it was inline in the app's scene) so a test can draw it and a person can read
/// the words: the status lines first ("Agent: ...", "Talos server: ...", "Your Mac: ..."), then the everyday items, and every
/// engineer item inside the Advanced submenu (`AdvancedMenuItems`). Plain words only outside Advanced (`MacWordsGuardTests`).
struct StatusMenuContent: View {
  @ObservedObject var model: SupervisorController
  @ObservedObject var web: WebController
  @ObservedObject var status: StatusCoordinator
  @ObservedObject var companion: CompanionController
  @ObservedObject var updates: UpdateController
  @ObservedObject var allowUpdates: CloneConfirmCenter
  @Binding var companionOn: Bool
  @Environment(\.openWindow) private var openWindow

  var body: some View {
    if model.configured {
      ForEach(Array(status.summary.lines.enumerated()), id: \.offset) { _, l in Text(l) }
    } else {
      Text(MacWords.agentLine("not set up"))
    }
    if !model.liveNotice.isEmpty { Text(model.liveNotice) }
    // a thread session's line, apart from Main's: it shows while that thread still waits or is still failed
    if !model.threadNotice.isEmpty { Text(model.threadNotice) }
    Divider()
    Button("Show Talos") {
      if web.hasRelay {
        web.show()
      } else {
        model.notice = MacSettingsText.noRelayYet
        SettingsRouter.open(.advanced) { openWindow(id: $0) }
      }
    }
    .keyboardShortcut("t")
    Button("Sign in to Claude again…") { model.showSignIn(startNow: true) }
    if web.hasRelay {
      switch web.pageState {
      case .signedIn: Button(MacWords.signOutWindow) { SignOutAction.run(web: web) }
      case .signedOut:
        Button(MacWords.connectThisMac) {
          TerminalWindowController.shared.attach(model: model)
          PairingController.shared.start(config: model.supervisor.currentConfig(), web: web)
        }
      case .unreachable:
        Text(PageState.unreachableLine)
        Button("Try now") { web.retryNow() }
      case .loading: Text("Connecting to Talos…")
      }
      Button(MacWords.disconnectThisMac) { web.forgetThisMac(config: model.supervisor.currentConfig()) }
    }
    Button(MacWords.quickMessage) { QuickCompose.shared.show(anchor: QuickCompose.shared.anchorProvider?()) }
      .keyboardShortcut("n")
    Toggle("Show Companion", isOn: $companionOn)
    if companionOn {
      // The keyboard path to everything in the tray (spec 4.2). The menu redraws when `trayRevision` bumps.
      Menu("Companion: status") {
        let tray = companion.trayContent()
        if let h = tray.headline { Text(h) }
        ForEach(Array(tray.rows.enumerated()), id: \.offset) { _, r in
          Button("\(r.title): \(r.word)") { companion.openRow(r) }
        }
        if tray.more > 0 { Button("+\(tray.more) more") { companion.openHome() } }
        if let f = tray.footer { Text(f) }
        if tray.offersOpenTalos { Button("Open Talos") { companion.openTalosFromMenu() } }
      }
    }
    if let until = companion.snoozedUntil {
      Button(MacSettingsText.snoozeEntry(until: until.formatted(date: .omitted, time: .shortened))) { companion.endSnooze() }
    }
    Divider()
    if model.sessionIsUp {
      Button(MacWords.stopAgent) { model.stop() }.disabled(!model.configured || !model.supervisor.holdsSessionLock)
    } else {
      if !model.retryCannotWork {
        Button(model.failedStop ? "Try again" : MacWords.startAgent) { model.start() }.disabled(!model.configured)
      }
      if model.failedStop { Button("Start a new conversation") { model.startNewConversation() } }
    }
    Button(MacWords.restartAgent) { model.restart() }.disabled(!model.configured || (model.sessionIsUp && !model.supervisor.holdsSessionLock))
    Divider()
    Button("Settings…") {
      openWindow(id: "settings")
      NSApp.activate(ignoringOtherApps: true)
    }
    .keyboardShortcut(",")
    Button("Talos Help") { HelpRouter.open(model: model) { openWindow(id: $0) } }
    Button(MacWords.quickMessageShortcut) { SettingsRouter.open(.general) { openWindow(id: $0) } }
    // Only a Mac that still needs setup has the screens; an existing install never sees them again
    if OnboardingMarker.isNeeded(configured: model.configured, pending: OnboardingMarker.isPending(home: NSHomeDirectory())) {
      Button(OnboardingCopy.menuSetUp) {
        openWindow(id: "onboarding")
        NSApp.activate(ignoringOtherApps: true)
      }
    }
    Button(MacWords.privacyAndAccess) { SettingsRouter.open(.access) { openWindow(id: $0) } }
    Divider()
    Button("About Talos") {
      openWindow(id: "about")
      NSApp.activate(ignoringOtherApps: true)
    }
    Button(updates.menuDot ? "\u{25CF} " + updates.menuTitle : "Check for Updates\u{2026}") {
      updates.menuChoice()
    }
    if allowUpdates.pending != nil {
      Button("Allow updates\u{2026}") { allowUpdates.showAgain() }
    }
    AdvancedMenuItems(model: model, openWindow: { openWindow(id: $0) })
    Divider()
    if model.hostKind == .tmux {
      Button(MacWords.quitKeepsAgent) { model.quitFromMenu() }
      .keyboardShortcut("q")
      Button(MacWords.quitAndStop) { model.stopThenQuit() }.disabled(model.sessionIsUp && !model.supervisor.holdsSessionLock)
    } else {
      Button(MacWords.quitStopsAgent) { model.stopThenQuit() }
      .keyboardShortcut("q")
    }
  }
}
