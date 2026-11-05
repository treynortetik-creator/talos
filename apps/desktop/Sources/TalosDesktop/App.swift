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
    TalosApp.main()
  }
}

/// The menu bar item, and the windows: Mac settings (Session, Connection, Permissions, Hotkeys, Companion, General) and the setup
/// checklist. Help is not a window: it is a page in the Talos window (`HelpRouter`).
struct TalosApp: App {
  @StateObject private var model = SupervisorController()
  @StateObject private var web = WebController.shared
  @StateObject private var status = StatusCoordinator.shared
  @StateObject private var companion = CompanionController.shared
  @AppStorage(CompanionController.Key.enabled) private var companionOn = false
  @Environment(\.openWindow) private var openWindow
  @NSApplicationDelegateAdaptor(TalosAppDelegate.self) private var appDelegate

  init() {
    // Without desktop.json, settings changed before setup come back (U8): the same start the controller makes.
    let start = SupervisorController.startupConfig(store: DefaultsStore())
    let cfg = start.config
    WebController.shared.configure(relayUrl: cfg.relayUrl)
    KeepAwake.shared.start(enabled: cfg.keepAwakeOnAC)
    WebController.shared.prepare()
    HotkeyController.shared.bootstrap(configured: cfg.hotkeys.compose)
  }

  /// The standard About panel with the app's version (audit D62: the menu used to show none).
  static func showAbout() {
    NSApp.activate(ignoringOtherApps: true)
    NSApp.orderFrontStandardAboutPanel(options: [
      .applicationName: "Talos",
      .applicationVersion: WebController.version,
      .version: "",
    ])
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
      if model.configured {
        ForEach(Array(status.summary.lines.enumerated()), id: \.offset) { _, l in Text(l) }
      } else {
        Text(model.statusLine)
      }
      if !model.liveNotice.isEmpty { Text(model.liveNotice) }
      Divider()
      Button("Show Talos") {
        if web.hasRelay {
          web.show()
        } else {
          model.notice = MacSettingsText.noRelayYet
          SettingsRouter.open(.connection) { openWindow(id: $0) }
        }
      }
      .keyboardShortcut("t")
      if web.hasRelay {
        switch web.pageState {
        case .signedIn: Button("Sign out") { Task { await web.signOut() } }
        case .signedOut:
          Button("Sign in…") {
            TerminalWindowController.shared.attach(model: model)
            PairingController.shared.start(config: model.supervisor.currentConfig(), web: web)
          }
        case .unreachable:
          Text(PageState.unreachableLine)
          Button("Try now") { web.retryNow() }
        case .loading: Text("Connecting to Talos…")
        }
        Button("Forget this Mac…") { web.forgetThisMac(config: model.supervisor.currentConfig()) }
      }
      Button("Quick compose…") { QuickCompose.shared.show(anchor: QuickCompose.shared.anchorProvider?()) }
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
      Button("Terminals…") {
        TerminalWindowController.shared.attach(model: model)
        TerminalWindowController.shared.show()
      }
        .keyboardShortcut("k")
      Divider()
      if model.sessionIsUp {
        Button("Stop session") { model.stop() }.disabled(!model.configured || !model.supervisor.holdsSessionLock)
      } else {
        if !model.retryCannotWork {
          Button(model.failedStop ? "Try again" : "Start session") { model.start() }.disabled(!model.configured)
        }
        if model.failedStop { Button("Start a new conversation") { model.startNewConversation() } }
      }
      Button("Restart session") { model.restart() }.disabled(!model.configured || (model.sessionIsUp && !model.supervisor.holdsSessionLock))
      Button("Copy Terminal command") { model.copyTerminalCommand() }.disabled(!model.configured)
      Button("Find a running session…") {
        SettingsRouter.openAdopt(model: model) { openWindow(id: $0) }
      }
      if model.hostKind == .tmux { Button("Copy tmux attach command") { model.copyAttachCommand() } }
      Divider()
      Button("Settings…") {
        openWindow(id: "settings")
        NSApp.activate(ignoringOtherApps: true)
      }
      .keyboardShortcut(",")
      Button("Talos Help") { HelpRouter.open(model: model) { openWindow(id: $0) } }
      Button("Compose hotkey…") { SettingsRouter.open(.hotkeys) { openWindow(id: $0) } }
      Button("Setup checklist…") {
        openWindow(id: "onboarding")
        NSApp.activate(ignoringOtherApps: true)
      }
      Button("Permissions…") { SettingsRouter.open(.permissions) { openWindow(id: $0) } }
      Divider()
      Button("About Talos") { TalosApp.showAbout() }
      Button("Open Log") { TalosApp.openLog(model: model) }
      Divider()
      if model.hostKind == .tmux {
        Button("Quit Talos (agent keeps running)") { model.quitFromMenu() }
        .keyboardShortcut("q")
        Button("Quit and stop the agent") { model.stopThenQuit() }.disabled(model.sessionIsUp && !model.supervisor.holdsSessionLock)
      } else {
        Button("Quit Talos (stops the agent)") { model.stopThenQuit() }
        .keyboardShortcut("q")
      }
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
            hasRelay: { WebController.shared.hasRelay })
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
                  SettingsRouter.open(.connection) { openWindow(id: $0) }
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
                  SettingsRouter.open(.connection) { openWindow(id: $0) }
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
              cancelReply: { WebController.shared.cancelLastReply() }))
          status.onCompanionChange = { CompanionController.shared.inputsChanged() }
          // A menu-bar-only app has no top menu at all, so the policy follows the windows (Dock icon while one is open).
          ActivationPolicyController.shared.start()
          if !model.configured, !UserDefaults.standard.bool(forKey: "onboardingShown") {
            UserDefaults.standard.set(true, forKey: "onboardingShown")
            openWindow(id: "onboarding")
            NSApp.activate(ignoringOtherApps: true)
          }
        }
    }
    // The Session, Permissions and Compose hotkey windows are gone: each was a copy of a Mac settings tab, and every door now
    // opens the tab itself (`SettingsRouter`).
    Window(MacSettingsText.windowTitle, id: "settings") { SettingsView(model: model) }
    Window("Set up Talos", id: "onboarding") { OnboardingView(model: model) }
  }
}

struct SessionView: View {
  @ObservedObject var model: SupervisorController
  @State private var command = ""
  @State private var importError: String?

  var body: some View {
    VStack(alignment: .leading, spacing: 10) {
      Text(model.statusLine).font(.headline)
      let blockers: [TakeoverCheck.Blocker] = { if case .blocked(let b) = model.status.phase { return b } else { return [] } }()
      // The Blocked screen says who holds the channels once; the notice that repeats it is dropped.
      let notice = BlockedText.notice(model.liveNotice, whileBlocked: !blockers.isEmpty)
      if !notice.isEmpty { Text(notice).foregroundStyle(.orange) }
      ForEach(Array(BlockedText.lines(blockers).enumerated()), id: \.offset) { _, line in
        Text(line).fixedSize(horizontal: false, vertical: true)
      }
      if BlockedText.offersStartAnyway(blockers) {
        Text(BlockedText.startAnywayWarning).font(.caption).foregroundStyle(.secondary).fixedSize(horizontal: false, vertical: true)
        Button(BlockedText.startAnywayButton) { model.startAnyway() }
      }
      // Always there, not only after a start was blocked: first run has no blocked state to hang it on (audit D44).
      Button(BlockedText.adoptButton) { model.findSessionToAdopt() }
      if model.failedStop {
        HStack {
          if !model.retryCannotWork { Button("Try again") { model.start() } }
          Button("Start a new conversation") { model.startNewConversation() }
        }
      }
      if let plan = model.adopt {
        GroupBox("Adopt pid \(plan.pid)") {
          VStack(alignment: .leading, spacing: 4) {
            Text("Folder: \(plan.agentDir)")
            Text("Args: \(plan.args.joined(separator: " "))").lineLimit(3)
            Text("Session: \(plan.sessionId ?? "none found")")
            Text(model.adoptNote).foregroundStyle(.secondary).fixedSize(horizontal: false, vertical: true)
            Button("Continue") { model.continueAdopt() }
          }
        }
      } else if !model.adoptNote.isEmpty {
        Text(model.adoptNote).foregroundStyle(.secondary)
      }
      Divider()
      Text("Import your launch command").font(.subheadline)
      Text("cd <folder> && [VAR=value …] claude <args…>. Talos runs it without a shell.")
        .font(.caption).foregroundStyle(.secondary)
      TextField("cd ~/agent && claude --dangerously-skip-permissions …", text: $command)
      HStack {
        Button("Import") { importError = model.importCommand(command, thenStart: true) }
        if let e = importError { Text(e).foregroundStyle(.red) }
      }
      if importError == nil, !model.importNote.isEmpty {
        Text(model.importNote).font(.callout).foregroundStyle(.green).fixedSize(horizontal: false, vertical: true)
          .accessibilityIdentifier("import-saved")
      }
      Divider()
      HStack {
        Button("Copy Terminal command") { model.copyTerminalCommand() }
        if model.hostKind == .tmux { Button("Copy tmux attach command") { model.copyAttachCommand() } }
      }
      Text(
        model.hostKind == .tmux
          ? "The agent runs in tmux and keeps running when Talos quits."
          : "tmux 3.2+ not found: the agent stops when Talos quits."
      )
      .font(.caption).foregroundStyle(.secondary)
    }
    .padding()
    .frame(minWidth: 560, minHeight: 420, alignment: .topLeading)
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
    let kind: SupervisorNotice.PhaseKind
    switch status.phase {
    case .running: kind = .running
    case .starting: kind = .starting
    case .stopped, .idle: kind = .stopped
    default: kind = .other
    }
    let logExists = notice.hasPrefix(SupervisorNotice.noLogYet) && FileManager.default.fileExists(atPath: bridgeLogPath)
    return SupervisorNotice.isStale(notice, phase: kind, needsYou: status.needsYou != nil, logExists: logExists) ? "" : notice
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
