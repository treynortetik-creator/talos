import AppKit
import SwiftUI
import TalosDesktopCore

extension SupervisorController {
  /// Quit from the top menu or the menu bar: with tmux the agent keeps running, so Talos detaches and quits; without it the
  /// quit goes through the same held, bounded stop as every other quit (`QuitCoordinator`).
  func quitFromMenu() {
    RelaunchGuard.shared.deliberateQuit()  // the owner asked: no rescue relaunch
    if hostKind == .tmux { supervisor.detach() }
    NSApp.terminate(nil)
  }
}

/// Opens Mac settings on a tab. The Session, Permissions and Compose hotkey windows are gone: every door lands here.
@MainActor
enum SettingsRouter {
  static func open(_ tab: SettingsNavigator.Tab, via open: (String) -> Void) {
    SettingsNavigator.shared.selected = tab
    open("settings")
    NSApp.activate(ignoringOtherApps: true)
  }

  /// "Find a running session": the Session tab, then the search. The menu bar and the setup checklist both come through here.
  static func openAdopt(model: SupervisorController, via open: (String) -> Void) {
    Self.open(.session, via: open)
    model.findSessionToAdopt()
  }
}

/// Help is a page in the Talos window (`HelpPage`): every door, the top menu, the menu bar and the setup checklist, opens it here.
@MainActor
enum HelpRouter {
  static func open(model: SupervisorController, via open: (String) -> Void, web: WebController = .shared) {
    switch HelpPage.plan(hasRelay: web.hasRelay) {
    case .showPage(let path):
      web.show()
      // queued until the page is ready, so a Help opened while the window is still loading lands once it has
      web.sendWhenReady(.navigate(path: path), reveal: false)
    case .needsRelay(let notice):
      model.notice = notice
      SettingsRouter.open(.connection, via: open)
    }
  }
}

/// What each top-menu item does.
@MainActor
enum AppMenuActions {
  /// The Window menu's "Show Companion": the same switch (`companion.enabled`) as the menu bar item, the setup screen
  /// and Settings.
  static func toggleCompanion(_ c: CompanionController = .shared) { c.isEnabled.toggle() }

  static func perform(_ a: AppMenuSpec.Action, model: SupervisorController, open: (String) -> Void) {
    let web = WebController.shared
    func window(_ id: String) {
      open(id)
      NSApp.activate(ignoringOtherApps: true)
    }
    switch a {
    case .settings: window("settings")
    case .help: HelpRouter.open(model: model, via: open)
    case .setupChecklist: window("onboarding")
    case .permissions: SettingsRouter.open(.permissions, via: open)
    case .about:
      NSApp.activate(ignoringOtherApps: true)
      NSApp.orderFrontStandardAboutPanel(options: [.applicationName: "Talos", .applicationVersion: WebController.version, .version: ""])
    case .showTalos:
      if web.hasRelay {
        web.show()
      } else {
        model.notice = MacSettingsText.noRelayYet
        SettingsRouter.open(.connection, via: open)
      }
    case .showTerminal:
      TerminalWindowController.shared.attach(model: model)
      TerminalWindowController.shared.show()
    case .quickCompose: QuickCompose.shared.show(anchor: QuickCompose.shared.anchorProvider?())
    case .companionToggle: toggleCompanion()
    case .signIn: SignInAction.start(model: model)
    case .signOut: Task { await web.signOut() }
    case .quit: model.quitFromMenu()
    case .hide, .hideOthers, .showAll, .closeWindow, .minimize: break  // AppKit's own actions
    }
  }
}

/// Dock-icon click support: a menu-bar app has no windows to reopen unless asked. Also the one place every quit passes through,
/// and the one that can tell who asked.
final class TalosAppDelegate: NSObject, NSApplicationDelegate {
  /// Who asked for the quit, as a bundle id: read from the Apple event being handled. A test sets it.
  var quitSender: () -> String? = { QuitSender.bundleId() }

  private var launchGate = LaunchWindowGate()

  /// The main Talos window opens once per launch (a start at login too) when a relay is set up and the owner has not turned
  /// it off. It waits one turn of the run loop so the app's scenes exist first.
  func applicationDidFinishLaunching(_ notification: Notification) {
    DispatchQueue.main.async { [weak self] in
      MainActor.assumeIsolated {
        let start = SupervisorController.startupConfig(store: DefaultsStore())
        let web = WebController.shared
        let open = self?.launchGate.shouldOpen(
          enabled: start.config.openWindowAtLaunch, hasRelay: web.hasRelay, setUp: start.hasFile,
          rescueRelaunch: RelaunchWatchdog.isRelaunch(CommandLine.arguments))
        if open == true { web.show() }
      }
    }
  }

  func applicationShouldHandleReopen(_ sender: NSApplication, hasVisibleWindows flag: Bool) -> Bool {
    if !flag { MainActor.assumeIsolated { AppMenu.shared.reopen() } }
    return true
  }

  func applicationShouldTerminate(_ sender: NSApplication) -> NSApplication.TerminateReply {
    // A quit from the Dock (or Activity Monitor) is the owner getting rid of Talos; macOS's Quit & Reopen is not.
    let sender = quitSender()
    if RelaunchWatchdog.isDeliberateQuit(senderBundleId: sender) { MainActor.assumeIsolated { RelaunchGuard.shared.deliberateQuit() } }
    // The Dock's Quit, Cmd-Q, Activity Monitor and logout all arrive here: the same safe stop for each (see QuitPlan).
    return MainActor.assumeIsolated { QuitCoordinator.shared.shouldTerminate() }
  }
}

enum QuitSender {
  /// The app that sent the quit Apple Event being handled right now, nil when there is none (a quit from our own code).
  static func bundleId() -> String? {
    guard let ev = NSAppleEventManager.shared().currentAppleEvent,
      let pid = ev.attributeDescriptor(forKeyword: AEKeyword(keySenderPIDAttr))?.int32Value, pid > 0
    else { return nil }
    return NSRunningApplication(processIdentifier: pid)?.bundleIdentifier
  }
}
