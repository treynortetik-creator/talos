import AppKit
import SwiftUI
import TalosDesktopCore
import TalosSupervisor

@main
enum Entry {
  static func main() {
    if CommandLine.arguments.contains("--selftest") {
      exit(SelfTest.run())
    }
    // the read-only report of what an update would restart: before anything of the app starts (UpdateCheckCLI.swift)
    if CommandLine.arguments.dropFirst().first == "--update-check" {
      let rest = Array(CommandLine.arguments.dropFirst(2))
      exit(MainActor.assumeIsolated { UpdateCheckCLI.run(rest) })
    }
    TalosApp.main()
  }
}

/// The menu bar item, and the windows: Mac settings (Your agent, Phone & Mac, Privacy & access, General, Advanced) and the setup
/// checklist. Help is not a window: it is a page in the Talos window (`HelpRouter`).
struct TalosApp: App {
  @StateObject private var model: SupervisorController
  @StateObject private var web = WebController.shared
  @StateObject private var status = StatusCoordinator.shared
  @StateObject private var companion = CompanionController.shared
  @StateObject private var updates = UpdateController.shared
  @StateObject private var allowUpdates = CloneConfirmCenter.shared
  @AppStorage(CompanionController.Key.enabled) private var companionOn = false
  @Environment(\.openWindow) private var openWindow
  @NSApplicationDelegateAdaptor(TalosAppDelegate.self) private var appDelegate

  init() {
    // First of all, before the supervisor, the web server or any window: a temporary or out-of-place copy cannot update itself or
    // start at login, so it asks to move into ~/Applications (a yes, or another Talos already running, quits this copy here).
    AppMovePrompt.runIfNeeded()
    // The first launch after a move: a few seconds in, once the windows are up, offer to Trash the copy left in Downloads.
    DispatchQueue.main.asyncAfter(deadline: .now() + 4) { MainActor.assumeIsolated { DownloadTidyPrompt.runIfNeeded() } }
    // A fresh install (no desktop.json yet) starts with the companion and the Dock icon on; checked before anything makes the file.
    AutoSetup.seedFreshInstall(.standard, isFresh: !FileManager.default.fileExists(atPath: SupervisorController.configPath))
    // Without desktop.json, settings changed before setup come back (U8): the same start the controller makes.
    let start = SupervisorController.startupConfig(store: DefaultsStore())
    let cfg = start.config
    WebController.shared.configure(relayUrl: cfg.relayUrl, configEnv: cfg.env)
    KeepAwake.shared.start(enabled: cfg.keepAwakeOnAC)
    WebController.shared.prepare()
    HotkeyController.shared.bootstrap(configured: cfg.hotkeys.compose)
    SupervisorController.launchTrust = KeychainLaunchTrust()  // the app seals the confirmed launch with its Keychain key; tests keep the in-memory store
    // Made now, not when the menu is first opened: the Terminal screen in the Talos window reads it from the first launch.
    _model = StateObject(wrappedValue: SupervisorController())
  }

  /// Reveals the bridge's log in Finder. With no log yet, says so in the menu instead of doing nothing.
  static func openLog(model: SupervisorController) {
    let path = model.bridgeLogPath
    if FileManager.default.fileExists(atPath: path) {
      if model.notice.hasPrefix(SupervisorNotice.noLogYet) { model.notice = "" }
      NSWorkspace.shared.activateFileViewerSelecting([URL(fileURLWithPath: path)])
    } else {
      model.notice = SupervisorNotice.noLogNotice(path: path)
    }
  }

  var body: some Scene {
    MenuBarExtra {
      StatusMenuContent(
        model: model, web: web, status: status, companion: companion, updates: updates, allowUpdates: allowUpdates,
        companionOn: $companionOn)
    } label: {
      Group {
        if let image = status.menuBarImage {
          Image(nsImage: image)
        } else {
          Text("Talos")
        }
      }
        .accessibilityLabel(status.summary.icon.menuBarLabel)
        .task {
          status.start(model: model)
          // The menus beside the Apple logo (Settings… and Help live there). Never from `init`: NSApp is nil there.
          AppMenu.shared.host = AppMenu.Host(
            run: { a in AppMenuActions.perform(a, model: model, open: { openWindow(id: $0) }) },
            companionOn: { CompanionController.shared.isEnabled },
            signedIn: { WebController.shared.signedIn },
            offersSignIn: { WebController.shared.pageState.offersSignIn },
            hasRelay: { WebController.shared.hasRelay },
            canReload: { WebController.shared.webWindowIsFront },
            updateTitle: { UpdateController.shared.menuTitle },
            updateDot: { UpdateController.shared.menuDot })
          UpdateController.shared.openWindow = { openWindow(id: "updates") }
          AppMenu.shared.install()
          AppMenu.shared.keepInstalled()
          model.installQuitHooks()
          // Never from TalosApp.init: NSApp is nil there. `openWindow` is a SwiftUI value, so hand the panel a closure for it.
          companion.start(
            inputs: { StatusCoordinator.shared.companionInputsNow },
            host: CompanionController.Host(
              openTalos: {
                if WebController.shared.hasRelay {
                  WebController.shared.show()
                } else {
                  model.notice = MacSettingsText.noRelayYet
                  SettingsRouter.open(.advanced) { openWindow(id: $0) }
                }
              },
              openSettings: {
                openWindow(id: "settings")
                NSApp.activate(ignoringOtherApps: true)
              },
              showCompose: { QuickCompose.shared.show(anchor: $0) },
              composeIsVisible: { QuickCompose.shared.isVisible },
              openPath: { path in
                // `web.show()`, then the navigation; it waits for the page if it is still loading.
                guard WebController.shared.hasRelay else {
                  model.notice = MacSettingsText.noRelayYet
                  SettingsRouter.open(.advanced) { openWindow(id: $0) }
                  return
                }
                WebController.shared.show()
                WebController.shared.sendWhenReady(.navigate(path: path), reveal: false)
              },
              showTerminal: {
                TerminalWindowController.shared.attach(model: model)
                TerminalWindowController.shared.show()
              },
              requestReply: { WebController.shared.requestLastReply(thread: $0, completion: $1) },
              cancelReply: { WebController.shared.cancelLastReply() },
              postReplyBanner: { StatusCoordinator.shared.postReplyBanner(thread: $0, name: $1) },
              setRepliesFlag: { WebController.shared.setCompanionReplies($0, shown: $1, epoch: $2) }))
          status.onCompanionChange = { CompanionController.shared.inputsChanged() }
          // A menu-bar-only app has no top menu at all, so the policy follows the windows (Dock icon while one is open).
          ActivationPolicyController.shared.start()
          // a hello still pending is asked for again; then the launch rule decides (configured wins; the marker only matters for a half-done setup)
          let home = NSHomeDirectory()
          HelloDeliveryTimer.shared.start(model: model)
          if OnboardingLaunch.shouldOpen(
            configured: model.configured, pending: OnboardingMarker.isPending(home: home),
            shownThisRun: OnboardingShared.openedThisRun, dismissed: OnboardingDismissal.isSet(home: home))
          {
            OnboardingShared.openedThisRun = true
            openWindow(id: "onboarding")
            NSApp.activate(ignoringOtherApps: true)
          }
        }
    }
    // The Session, Permissions and Compose hotkey windows are gone: each was a copy of a Mac settings tab, and every door now
    // opens the tab itself (`SettingsRouter`).
    Window(MacSettingsText.windowTitle, id: "settings") { SettingsView(model: model) }
    Window(OnboardingCopy.windowTitle, id: "onboarding") { OnboardingWindowView(model: model) }
      .windowStyle(.hiddenTitleBar)
      .windowResizability(.contentSize)
    // The Advanced route for an existing agent folder: reached from the menu, never from setup.
    Window(OnboardingCopy.advancedTitle, id: "advanced-setup") { AdvancedSetupView(model: model) }
    Window("About Talos", id: "about") { AboutView(controller: UpdateController.shared) }
      .windowResizability(.contentSize)
      .commands { TalosAppCommands() }
    Window("Talos updates", id: "updates") { UpdateWindow(controller: UpdateController.shared) }
      .windowResizability(.contentSize)
  }
}

/// The Talos menu's own first two items, from SwiftUI's side: About opens OUR About window (never the stock panel) and Check for Updates
/// sits right below it. `AppMenu` (the menus built from `AppMenuSpec`) takes over the whole bar once the app is up; this is what the
/// bar shows before that, and what stands if it is ever swapped back, so the stock About panel cannot appear at any moment.
struct TalosAppCommands: Commands {
  @Environment(\.openWindow) private var openWindow

  var body: some Commands {
    CommandGroup(replacing: .appInfo) {
      Button("About Talos") {
        openWindow(id: "about")
        NSApp.activate(ignoringOtherApps: true)
      }
      Button(UpdateMenu.checkTitle) {
        UpdateController.shared.openWindow = { openWindow(id: "updates") }
        UpdateController.shared.menuChoice()
      }
    }
  }
}

extension SupervisorController {
  /// Start/Stop is one menu item: it says Stop while a session is starting, running or restarting.
  var sessionIsUp: Bool {
    switch status.phase {
    case .starting, .running, .cleaningUp, .waitingToRestart, .stopping: return true
    default: return false
    }
  }
}

extension SupervisorController {
  /// Where the bridge writes its log, from the current config and environment.
  var bridgeLogPath: String {
    BridgeLog.path(
      configEnv: supervisor.currentConfig().env, processEnv: ProcessInfo.processInfo.environment, home: NSHomeDirectory())
  }
}

extension SupervisorController {
  /// A notice disappears from the menu once it no longer describes the session: "press Enter" once nothing waits, a failure once
  /// a new start is under way (audit D41).
  var liveNotice: String {
    // It stands for the whole run, whatever else was said since (a Stop clears `notice`; this must not go with it).
    if status.configUnreadable { return SupervisorNotice.configUnreadable }
    let kind: SupervisorNotice.PhaseKind
    switch status.phase {
    case .running: kind = .running
    case .starting: kind = .starting
    case .stopped, .idle: kind = .stopped
    default: kind = .other
    }
    let logExists = notice.hasPrefix(SupervisorNotice.noLogYet) && FileManager.default.fileExists(atPath: bridgeLogPath)
    let shown = Self.following(notice, eventNotice: needsYouEventNotice, current: status.needsYou)
    return SupervisorNotice.isStale(shown, phase: kind, needsYou: status.needsYou != nil, logExists: logExists) ? "" : shown
  }

  /// The failed stop the owner can act on: Try again / Start a new conversation (audit D41, D43).
  var failedStop: Bool {
    if case .stopped(let r) = status.phase { return r.isFailure }
    return false
  }

  /// Try again would resume the same missing conversation and fail the same way: only Start a new conversation helps.
  var retryCannotWork: Bool {
    if case .stopped(let r) = status.phase { return r.retryCannotWork }
    return false
  }
}
