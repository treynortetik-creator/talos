import AppKit
import SwiftUI
import TalosDesktopCore

/// Mac settings (DESKTOP-SPEC 6.6, redrawn 2026-11-20 from the owner-approved mock): Your agent, Phone & Mac, Privacy & access,
/// General and Advanced. One line per setting, at most one caption per section, and no engineer words outside Advanced
/// (`MacWordsGuardTests`). Each change is written to `desktop.json` at once through the supervisor (atomic, 0600); fields that
/// change the start-up command make the next start a cold one. Before setup there is no `desktop.json` and a change is held (see `PreSetup`).
/// Which tab is showing, so any opener (the menus, the setup checklist, a link on another tab) can land on the matching one.
@MainActor
final class SettingsNavigator: ObservableObject {
  static let shared = SettingsNavigator()
  /// The old Session, Connection, Permissions, Hotkeys and Companion tabs are gone: their settings moved to these five (see
  /// docs/mac-label-map-2026-11-20.md).
  enum Tab: String, CaseIterable {
    case agent, phone, access, general, advanced
    var title: String {
      switch self {
      case .agent: return MacWords.tabAgent
      case .phone: return MacWords.tabPhone
      case .access: return MacWords.tabAccess
      case .general: return MacWords.tabGeneral
      case .advanced: return MacWords.tabAdvanced
      }
    }
    var symbol: String {
      switch self {
      case .agent: return "cpu"
      case .phone: return "iphone"
      case .access: return "lock.shield"
      case .general: return "gearshape"
      case .advanced: return "slider.horizontal.3"
      }
    }
  }
  @Published var selected: Tab = .agent
}

struct SettingsView: View {
  @ObservedObject var nav = SettingsNavigator.shared
  @ObservedObject var model: SupervisorController
  @ObservedObject var web = WebController.shared
  @ObservedObject var login = LoginItemController.shared
  @ObservedObject var awake = KeepAwake.shared
  @ObservedObject var updates = UpdateController.shared
  @ObservedObject var status = StatusCoordinator.shared
  @State var cfg = DesktopConfig.defaults
  @State var loaded = false
  // Text fields are saved on Return or when this window goes away, never per keystroke: a half-typed folder must not be the
  // live config (and each save can make the next restart cold).
  @State var drafts = SettingsDrafts()
  @State var launchDraft = ""
  @State var launchLoaded = ""
  @State var launchError: String?
  @State var launchSaved = false
  @State var pendingMode: PermissionMode?
  @State var confirmRestart = false
  @State var modeNote = ""
  @State var threads = ThreadChoices.Listing.unreadable
  @State var generalNote = ""
  @AppStorage("showDockIcon") var showDock = false
  @AppStorage(CompanionController.Key.replyBanners) var replyBanners = false
  /// A test seam: type this into the start-up command box and press Return when the window appears, to look at the error state.
  var typedLaunchLine: String?
  /// A test seam: the headline Your agent shows, for a picture of the running state (the real one comes from `StatusCoordinator`).
  var headlineForTest: HealthSummary.Headline?

  init(model: SupervisorController, typedLaunchLine: String? = nil) {
    _model = ObservedObject(wrappedValue: model)
    self.typedLaunchLine = typedLaunchLine
  }

  var body: some View {
    VStack(spacing: 0) {
      if !model.configured {
        Text(BlockedText.notSetUpLine)
          .font(OB.body(13)).foregroundStyle(SP.orange)
          .fixedSize(horizontal: false, vertical: true)
          .padding(.horizontal).padding(.top, 8)
          .frame(maxWidth: .infinity, alignment: .leading)
          .background(SP.cream)
          .accessibilityIdentifier("settings-not-set-up")
      }
      HStack(spacing: 0) {
        sidebar
        SP.line.frame(width: 1)
        Group {
          switch nav.selected {
          case .agent: agentTab
          case .phone: phoneTab
          case .access: PermissionsView()
          case .general: generalTab
          case .advanced: advancedTab
          }
        }
        .frame(maxWidth: .infinity, maxHeight: .infinity)
      }
    }
    .frame(minWidth: 820, idealWidth: SP.width, minHeight: 560, idealHeight: SP.height)
    .background(SP.cream)
    .environment(\.colorScheme, .light)  // cream either way: the text is fixed ink, like the About and update windows
    .onAppear {
      cfg = model.configNow
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
      cfg = model.configNow
      drafts.follow(cfg)
      // Only when the config's line is not already the one on screen: our own save bumps the revision too, and reloading then
      // would wipe the "Saved" note it just set.
      if LaunchEdit.shouldReload(draft: launchDraft, loaded: launchLoaded, current: LaunchEdit.line(for: cfg)) { loadLaunch() }
    }
    .onChange(of: nav.selected) { if nav.selected == .agent { loadThreads() } }
  }

  /// The left list. Advanced sits apart at the bottom, quieter: nothing in it is needed to use Talos.
  private var sidebar: some View {
    VStack(alignment: .leading, spacing: 4) {
      ForEach(SettingsNavigator.Tab.allCases.filter { $0 != .advanced }, id: \.self) { tabButton($0) }
      Spacer(minLength: 12)
      tabButton(.advanced)
    }
    .padding(.horizontal, 12).padding(.vertical, 20)
    .frame(width: SP.sidebarWidth)
    .frame(maxHeight: .infinity)
    .background(SP.nav)
    .accessibilityElement(children: .contain)
    .accessibilityLabel("Settings sections")
  }

  private func tabButton(_ tab: SettingsNavigator.Tab) -> some View {
    let on = nav.selected == tab
    return Button {
      nav.selected = tab
    } label: {
      HStack(spacing: 10) {
        Image(systemName: tab.symbol).frame(width: 18)
        Text(tab.title).font(OB.body(tab == .advanced ? 13 : 14, on ? .semibold : .regular))
        Spacer(minLength: 0)
      }
      .foregroundStyle(on ? SP.ink : (tab == .advanced ? SP.muted : SP.ink))
      .padding(.horizontal, 12)
      .frame(minHeight: 40)
      .background(RoundedRectangle(cornerRadius: 10).fill(on ? SP.accent : Color.clear))
      .contentShape(RoundedRectangle(cornerRadius: 10))
    }
    .buttonStyle(.plain)
    .accessibilityLabel(tab.title)
    .accessibilityAddTraits(on ? [.isButton, .isSelected] : .isButton)
    .accessibilityIdentifier("settings-tab-\(tab.rawValue)")
  }

  // MARK: saving

  func save(_ edit: @escaping @Sendable (inout DesktopConfig) -> Void) {
    guard loaded else { return }
    model.saveSetting(edit)
    cfg = model.configNow  // the save does not wait for the supervisor: this is the config with the edit laid on
  }

  func commitDrafts() {
    guard loaded else { return }
    // Against the live config, not this window's copy: an Adopt or Import since the box was typed in must not be undone.
    let p = drafts.pending(against: model.configNow)
    if let d = p.dir { save { $0.agentDir = d } }
    if let c = p.cli { save { $0.talosAppCommand = c } }
    if let r = p.relay {
      save { $0.relayUrl = r }
      web.configure(relayUrl: r, configEnv: model.configNow.env)
    }
    drafts.saved(model.configNow)
  }

  func bind<T: Sendable>(_ kp: WritableKeyPath<DesktopConfig, T> & Sendable) -> Binding<T> {
    Binding(get: { cfg[keyPath: kp] }, set: { v in save { $0[keyPath: kp] = v } })
  }

  func loadLaunch() {
    launchLoaded = LaunchEdit.line(for: model.configNow)
    launchDraft = launchLoaded
    launchError = nil
    launchSaved = false
  }

  func loadThreads() {
    let c = model.configNow
    let path = ThreadChoices.configPath(
      configEnv: c.env, processEnv: ProcessInfo.processInfo.environment, home: NSHomeDirectory())
    threads = ThreadChoices.read(FileManager.default.contents(atPath: path))
  }

  func commitLaunch() {
    guard loaded else { return }
    switch model.editLaunchLine(launchDraft) {
    case .unchanged:
      launchError = nil
      launchSaved = false
    case .updated:
      launchError = nil
      launchSaved = true
      cfg = model.configNow
      launchLoaded = LaunchEdit.line(for: cfg)
      launchDraft = launchLoaded
    case .refused(let why):
      // The old value stays saved and on screen's source of truth; the box keeps what was typed so it can be fixed.
      launchError = why
      launchSaved = false
    }
  }

  func chooseFolder() {
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
}
