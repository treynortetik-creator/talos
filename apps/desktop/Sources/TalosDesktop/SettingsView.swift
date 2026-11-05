import AppKit
import SwiftUI
import TalosDesktopCore

/// Mac settings (DESKTOP-SPEC 6.6): Session, Connection, Permissions, Hotkeys, Companion, General. Each change is written to
/// `desktop.json` at once through the supervisor (atomic, 0600); fields that change the launch command make the next start a
/// cold one. Every setting says when it applies. Before setup there is no `desktop.json` and a change is held (see `PreSetup`).
/// Which tab is showing, so any opener (the menus, the setup checklist, a link on another tab) can land on the matching one.
@MainActor
final class SettingsNavigator: ObservableObject {
  static let shared = SettingsNavigator()
  enum Tab: String { case session, connection, permissions, hotkeys, companion, general }
  @Published var selected: Tab = .session
}

/// A caption under a setting: when it applies.
struct AppliesNote: View {
  let setting: MacSettingsText.Setting
  var body: some View {
    Text(MacSettingsText.applies(setting)).font(.caption).foregroundStyle(.secondary).fixedSize(horizontal: false, vertical: true)
  }
}

struct SettingsView: View {
  @ObservedObject private var nav = SettingsNavigator.shared
  @ObservedObject var model: SupervisorController
  @ObservedObject private var web = WebController.shared
  @ObservedObject private var login = LoginItemController.shared
  @ObservedObject private var awake = KeepAwake.shared
  @State private var cfg = DesktopConfig.defaults
  @State private var loaded = false
  // Text fields are saved on Return or when this window goes away, never per keystroke: a half-typed folder must not be the
  // live config (and each save can make the next restart cold).
  @State private var drafts = SettingsDrafts()
  @State private var launchDraft = ""
  @State private var launchLoaded = ""
  @State private var launchError: String?
  @State private var launchSaved = false
  @State private var threads = ThreadChoices.Listing.unreadable
  @State private var generalNote = ""
  @AppStorage("showDockIcon") private var showDock = false
  /// A test seam: type this into the launch command box and press Return when the window appears, to look at the error state.
  var typedLaunchLine: String?

  init(model: SupervisorController, typedLaunchLine: String? = nil) {
    _model = ObservedObject(wrappedValue: model)
    self.typedLaunchLine = typedLaunchLine
  }

  var body: some View {
    VStack(spacing: 0) {
      if !model.configured {
        Text(BlockedText.notSetUpLine)
          .font(.caption).foregroundStyle(.orange)
          .fixedSize(horizontal: false, vertical: true)
          .padding(.horizontal).padding(.top, 8)
          .frame(maxWidth: .infinity, alignment: .leading)
          .accessibilityIdentifier("settings-not-set-up")
      }
      TabView(selection: $nav.selected) {
        session.tabItem { Label("Session", systemImage: "terminal") }.tag(SettingsNavigator.Tab.session)
        connection.tabItem { Label(MacSettingsText.connectionTab, systemImage: "network") }.tag(SettingsNavigator.Tab.connection)
        PermissionsView().tabItem { Label("Permissions", systemImage: "lock.shield") }.tag(SettingsNavigator.Tab.permissions)
        HotkeyView(model: model).tabItem { Label("Hotkeys", systemImage: "keyboard") }.tag(SettingsNavigator.Tab.hotkeys)
        CompanionSettingsView().tabItem { Label(MacSettingsText.companionName, systemImage: "figure.stand") }.tag(SettingsNavigator.Tab.companion)
        general.tabItem { Label("General", systemImage: "gearshape") }.tag(SettingsNavigator.Tab.general)
      }
    }
    .frame(minWidth: 640, minHeight: 520)
    .onAppear {
      cfg = model.supervisor.currentConfig()
      drafts.load(cfg)
      loadLaunch()
      loadThreads()
      loaded = true
      login.refresh()
      if let t = typedLaunchLine {
        launchDraft = t
        commitLaunch()
      }
    }
    .onDisappear { commitDrafts() }
    // Import and Adopt rewrite desktop.json while this window is open; the boxes follow (unless he is typing in one).
    .onChange(of: model.configRevision) {
      cfg = model.supervisor.currentConfig()
      drafts.follow(cfg)
      // Only when the config's line is not already the one on screen: our own save bumps the revision too, and reloading then
      // would wipe the "Saved" note it just set.
      if LaunchEdit.shouldReload(draft: launchDraft, loaded: launchLoaded, current: LaunchEdit.line(for: cfg)) { loadLaunch() }
    }
    .onChange(of: nav.selected) { if nav.selected == .session { loadThreads() } }
  }

  // MARK: saving

  private func save(_ edit: @escaping @Sendable (inout DesktopConfig) -> Void) {
    guard loaded else { return }
    model.saveSetting(edit)
    cfg = model.supervisor.currentConfig()
  }

  private func commitDrafts() {
    guard loaded else { return }
    // Against the live config, not this window's copy: an Adopt or Import since the box was typed in must not be undone.
    let p = drafts.pending(against: model.supervisor.currentConfig())
    if let d = p.dir { save { $0.agentDir = d } }
    if let c = p.cli { save { $0.talosAppCommand = c } }
    if let r = p.relay {
      save { $0.relayUrl = r }
      web.configure(relayUrl: r)
    }
    drafts.saved(model.supervisor.currentConfig())
  }

  private func bind<T: Sendable>(_ kp: WritableKeyPath<DesktopConfig, T> & Sendable) -> Binding<T> {
    Binding(get: { cfg[keyPath: kp] }, set: { v in save { $0[keyPath: kp] = v } })
  }

  private func loadLaunch() {
    launchLoaded = LaunchEdit.line(for: model.supervisor.currentConfig())
    launchDraft = launchLoaded
    launchError = nil
    launchSaved = false
  }

  private func loadThreads() {
    let c = model.supervisor.currentConfig()
    let path = ThreadChoices.configPath(
      configEnv: c.env, processEnv: ProcessInfo.processInfo.environment, home: NSHomeDirectory())
    threads = ThreadChoices.read(FileManager.default.contents(atPath: path))
  }

  private func commitLaunch() {
    guard loaded else { return }
    switch model.editLaunchLine(launchDraft) {
    case .unchanged:
      launchError = nil
      launchSaved = false
    case .updated:
      launchError = nil
      launchSaved = true
      cfg = model.supervisor.currentConfig()
      launchLoaded = LaunchEdit.line(for: cfg)
      launchDraft = launchLoaded
    case .refused(let why):
      // The old value stays saved and on screen's source of truth; the box keeps what was typed so it can be fixed.
      launchError = why
      launchSaved = false
    }
  }

  private func chooseFolder() {
    let panel = NSOpenPanel()
    panel.canChooseDirectories = true
    panel.canChooseFiles = false
    panel.canCreateDirectories = true
    panel.allowsMultipleSelection = false
    panel.prompt = "Choose"
    panel.message = "Choose the agent's folder"
    let start = PathUtil.expandTilde(drafts.dir, home: NSHomeDirectory())
    if FileManager.default.fileExists(atPath: start) { panel.directoryURL = URL(fileURLWithPath: start) }
    guard panel.runModal() == .OK, let url = panel.url else { return }
    drafts.dir = url.path
    commitDrafts()
  }

  // MARK: Session

  private var folderCheck: AgentFolderCheck.Result { AgentFolderCheck.check(drafts.dir, home: NSHomeDirectory()) }

  private var session: some View {
    ScrollView {
      VStack(alignment: .leading, spacing: 10) {
        hostSection
        Divider()
        Text("Agent folder").font(.headline)
        HStack {
          TextField("~/talos-agent", text: $drafts.dir).textFieldStyle(.roundedBorder).onSubmit { commitDrafts() }
            .accessibilityLabel("Agent folder")
          Button("Choose\u{2026}") { chooseFolder() }
        }
        Text(folderCheck.text)
          .font(.caption).foregroundStyle(folderCheck.isProblem ? Color.orange : Color.secondary)
          .fixedSize(horizontal: false, vertical: true)
        AppliesNote(setting: .agentFolder)
        Divider()
        launchSection
        Divider()
        Toggle("Restart the agent after a crash", isOn: bind(\.autoRestart))
        AppliesNote(setting: .autoRestart)
        Toggle(MacSettingsText.autoConfirmTitle, isOn: bind(\.autoConfirmRestart))
        Text(MacSettingsText.autoConfirmHelp).font(.caption).foregroundStyle(.secondary).fixedSize(horizontal: false, vertical: true)
        AppliesNote(setting: .autoConfirmRestart)
        Toggle(MacSettingsText.startOnOpenTitle, isOn: bind(\.startSessionOnLaunch))
        Text(MacSettingsText.startOnOpenHelp).font(.caption).foregroundStyle(.secondary).fixedSize(horizontal: false, vertical: true)
        AppliesNote(setting: .startSessionOnLaunch)
        Toggle("Open the terminal when the agent needs you", isOn: bind(\.openTerminalOnDialog))
        AppliesNote(setting: .openTerminalOnDialog)
        Divider()
        notifyThreadSection
        Divider()
        SessionView(model: model)
      }
      .padding()
    }
  }

  private var hostSection: some View {
    VStack(alignment: .leading, spacing: 6) {
      Text("Terminal host").font(.headline)
      Picker(
        "Terminal host",
        selection: Binding(get: { cfg.host }, set: { v in save { $0.host = v } })
      ) {
        ForEach(HostChoice.all, id: \.self) { Text(HostChoice.label($0)).tag($0) }
      }
      .labelsHidden()
      .pickerStyle(.menu)
      .frame(maxWidth: 420, alignment: .leading)
      .disabled(!HostChoice.canChange(sessionUp: model.sessionIsUp, workersRunning: model.workersRunning))
      .accessibilityLabel("Terminal host")
      if !HostChoice.canChange(sessionUp: model.sessionIsUp, workersRunning: model.workersRunning) {
        Text(HostChoice.lockedNote).font(.caption).foregroundStyle(.orange).fixedSize(horizontal: false, vertical: true)
      }
      Text(HostChoice.runningLine(tmux: model.hostKind == .tmux)).font(.caption).foregroundStyle(.secondary)
      if let p = HostChoice.startBlock(saved: cfg.host, runningTmux: model.hostKind == .tmux, tmuxUsable: model.tmuxUsable) {
        Text(p).font(.caption).foregroundStyle(.orange).fixedSize(horizontal: false, vertical: true)
          .accessibilityIdentifier("host-change-pending")
      }
      if let c = HostChoice.caveat(choice: cfg.host, tmuxUsable: model.tmuxUsable) {
        Text(c).font(.caption).foregroundStyle(.orange).fixedSize(horizontal: false, vertical: true)
      }
      AppliesNote(setting: .host)
    }
  }

  private var launchSection: some View {
    VStack(alignment: .leading, spacing: 6) {
      Text("Launch command").font(.headline)
      if model.configured {
        HStack {
          TextField("claude --dangerously-skip-permissions …", text: $launchDraft)
            .textFieldStyle(.roundedBorder)
            .font(.system(.body, design: .monospaced))
            .onSubmit { commitLaunch() }
            .accessibilityLabel("Launch command")
          Button("Save") { commitLaunch() }.disabled(launchDraft == launchLoaded)
          Button("Revert") { loadLaunch() }.disabled(launchDraft == launchLoaded && launchError == nil)
        }
        Text("The program and its arguments, as Import reads them. The folder, the environment and the conversation are kept as they are.")
          .font(.caption).foregroundStyle(.secondary).fixedSize(horizontal: false, vertical: true)
        Text(LaunchEdit.envLine(cfg)).font(.caption).foregroundStyle(.secondary).fixedSize(horizontal: false, vertical: true)
        if let e = launchError {
          Text(e).font(.caption).foregroundStyle(.red).fixedSize(horizontal: false, vertical: true)
            .accessibilityIdentifier("launch-error")
        }
        if launchSaved {
          Text(LaunchEdit.coldNote).font(.caption).foregroundStyle(.secondary).fixedSize(horizontal: false, vertical: true)
            .accessibilityIdentifier("launch-saved")
        }
      } else {
        Text(SetupText.launchNeedsSetup).font(.caption).foregroundStyle(.secondary).fixedSize(horizontal: false, vertical: true)
      }
      AppliesNote(setting: .launchCommand)
    }
  }

  private var notifyThreadSection: some View {
    VStack(alignment: .leading, spacing: 6) {
      Text("Thread for crash posts").font(.headline)
      Picker(
        "Thread for crash posts",
        selection: Binding<String>(
          get: { cfg.notifyThread ?? "" },
          set: { v in
            let pick = ThreadChoices.stored(v)
            save { $0.notifyThread = pick }
          })
      ) {
        ForEach(ThreadChoices.options(threads, current: cfg.notifyThread)) { o in Text(o.label).tag(o.value ?? "") }
      }
      .labelsHidden()
      .pickerStyle(.menu)
      .frame(maxWidth: 420, alignment: .leading)
      .accessibilityLabel("Thread for crash posts")
      Text(ThreadChoices.note(threads)).font(.caption).foregroundStyle(threads.readable ? Color.secondary : Color.orange)
        .fixedSize(horizontal: false, vertical: true)
      AppliesNote(setting: .notifyThread)
    }
  }

  // MARK: Connection

  private var connection: some View {
    ScrollView {
      VStack(alignment: .leading, spacing: 12) {
        let why = MacSettingsText.connectionNotice(model.liveNotice, hasRelay: web.hasRelay)
        if !why.isEmpty {
          Text(why).foregroundStyle(.orange).fixedSize(horizontal: false, vertical: true)
            .accessibilityIdentifier("connection-notice")
        }
        LabeledContent("Relay address") {
          TextField(MacSettingsText.relayHint, text: $drafts.relay)
            .textFieldStyle(.roundedBorder)
            .onSubmit { commitDrafts() }
        }
        Text(MacSettingsText.relayUsing(web.relay?.url.absoluteString))
          .font(.caption).foregroundStyle(.secondary)
        AppliesNote(setting: .relayAddress)
        LabeledContent("talos-app command") {
          TextField("auto (PATH, then the agent folder's .mcp.json)", text: $drafts.cli)
            .textFieldStyle(.roundedBorder)
            .onSubmit { commitDrafts() }
        }
        Text("Used by Sign in and Forget this Mac. Leave empty unless Sign in can't find it, then enter e.g. bun run /path/to/talos-app/apps/bridge/src/cli.ts")
          .font(.caption).foregroundStyle(.secondary).fixedSize(horizontal: false, vertical: true)
        AppliesNote(setting: .talosAppCommand)
        Divider()
        SignInPanel(model: model, beforeSignIn: { commitDrafts() })
        HStack {
          if web.pageState == .signedIn { Button("Sign out") { Task { await web.signOut() } } }
          Button("Forget this Mac…") {
            commitDrafts()
            web.forgetThisMac(config: model.supervisor.currentConfig())
          }
          .disabled(!web.hasRelay)
        }
      }
      .padding()
    }
  }

  // MARK: General

  private var general: some View {
    ScrollView {
      VStack(alignment: .leading, spacing: 12) {
        Toggle(
          "Start Talos when I log in",
          isOn: Binding(get: { login.isOn }, set: { login.set($0) }))
        if !login.message.isEmpty {
          Text(login.message).font(.caption)
            .foregroundStyle(login.message == MacSettingsText.loginPending ? Color.orange : Color.secondary)
            .fixedSize(horizontal: false, vertical: true)
        }
        AppliesNote(setting: .startAtLogin)
        Toggle(
          "Show a Dock icon",
          isOn: Binding(
            get: { showDock },
            set: {
              showDock = $0
              ActivationPolicyController.shared.refresh()
            }))
        AppliesNote(setting: .dockIcon)
        Toggle(
          "Keep this Mac awake while plugged in",
          isOn: Binding(
            get: { cfg.keepAwakeOnAC },
            set: { on in
              save { $0.keepAwakeOnAC = on }
              KeepAwake.shared.setEnabled(on)
            }))
        Text(KeepAwake.caption(awake.status)).font(.caption).foregroundStyle(.secondary)
        AppliesNote(setting: .keepAwake)
        Toggle(
          "Open the Talos window at launch",
          isOn: Binding(
            get: { cfg.openWindowAtLaunch },
            set: { on in save { $0.openWindowAtLaunch = on } }))
        AppliesNote(setting: .openWindowAtLaunch)
        Divider()
        Text("About").font(.headline)
        Text(MacAbout.versionLine(version: WebController.version, build: WebController.build))
          .font(.callout).textSelection(.enabled)
        HStack {
          Button("Show the Mac app's log") { reveal(SupervisorController.auditPath, what: "Mac app log", madeBy: MacAbout.logMissing) }
          Button("Show desktop.json") {
            reveal(SupervisorController.configPath, what: "desktop.json", madeBy: MacAbout.configMissing)
          }
        }
        if !generalNote.isEmpty {
          Text(generalNote).font(.caption).foregroundStyle(.orange).fixedSize(horizontal: false, vertical: true)
            .accessibilityIdentifier("general-note")
        }
      }
      .padding()
    }
  }

  private func reveal(_ path: String, what: String, madeBy: String) {
    switch MacAbout.reveal(path: path, exists: FileManager.default.fileExists(atPath: path), what: what, madeBy: madeBy) {
    case .show(let p):
      generalNote = ""
      NSWorkspace.shared.activateFileViewerSelecting([URL(fileURLWithPath: p)])
    case .missing(let m):
      generalNote = m
    }
  }
}
