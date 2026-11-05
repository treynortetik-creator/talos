import AppKit
import SwiftUI
import TalosDesktopCore
import TalosSupervisor

/// First-run checklist (DESKTOP-SPEC 6.6): each row green or a one-line fix, nothing blocks. Opens by itself when
/// `desktop.json` doesn't exist yet, and from the menu.
@MainActor
final class OnboardingModel: ObservableObject {
  @Published var rows: [FirstRun.Row] = []
  @Published var checking = false
  /// Whether Claude is signed in, from the last check (nil = couldn't tell). Create, Adopt and Choose start nothing when false.
  @Published var auth: Bool?

  func refresh(config: DesktopConfig, setupDone: Bool) {
    checking = true
    let home = NSHomeDirectory()
    Task.detached {
      let probe = LiveSystem()
      let env = LoginShellEnv.build(shellEnv: probe.loginShellEnv() ?? [:], overrides: config.env)
      let exec = FileManager.default.isExecutableFile
      let claudeName = config.claudePath == "auto" ? "claude" : config.claudePath
      let claude = LoginShellEnv.which(claudeName, path: env["PATH"], isExecutable: exec)
      let version = claude.flatMap { probe.cliVersion(claude: $0, env: env) }
      var auth: Bool?
      if let claude {
        let r = ProcessRunner.run([claude, "auth", "status"], env: env, timeout: 10)
        auth = r.ok ? true : (r.timedOut ? nil : false)
      }
      let bunPath = env["PATH"].flatMap { LoginShellEnv.which("bun", path: $0 + ":\(home)/.bun/bin", isExecutable: exec) }
      var tmuxOut: String?
      if let t = LoginShellEnv.which("tmux", path: (env["PATH"] ?? "") + ":/opt/homebrew/bin:/usr/local/bin", isExecutable: exec) {
        let r = ProcessRunner.run([t, "-V"], timeout: 5)
        if r.ok { tmuxOut = r.out.trimmingCharacters(in: .whitespacesAndNewlines) }
      }
      let appHome = env["TALOS_APP_HOME"].flatMap { $0.isEmpty ? nil : $0 } ?? home + "/.config/talos/app"
      let cliFound = TalosAppCLI.resolve(config: config) != nil
      let folder = AgentFolderCheck.check(config.agentDir, home: home)
      let rows = FirstRun.rows(
        .init(
          claudeVersion: version ?? (claude != nil ? "" : nil), authSignedIn: auth, bunPath: bunPath, tmuxVersionOutput: tmuxOut,
          bridgeEnvPresent: FileManager.default.fileExists(atPath: appHome + "/bridge.env"), agentDir: config.agentDir,
          agentDirTrusted: FirstRun.trust(setupDone: setupDone, confirmedAt: config.session.confirmedAt), home: home,
          talosAppFound: cliFound, setupDone: setupDone, agentFolderProblem: folder.isProblem ? folder.text : nil))
      await MainActor.run {
        self.rows = rows
        self.auth = auth
        self.checking = false
      }
    }
  }
}

struct OnboardingView: View {
  @ObservedObject var model: SupervisorController
  @StateObject private var ob = OnboardingModel()
  @StateObject private var flow: AgentFolderFlow
  @Environment(\.openWindow) private var openWindow
  @AppStorage(CompanionController.Key.enabled) private var companionOn = false
  @AppStorage("showDockIcon") private var showDock = false

  init(model: SupervisorController) {
    _model = ObservedObject(wrappedValue: model)
    _flow = StateObject(wrappedValue: AgentFolderFlow(model: model))
  }

  var body: some View {
    ScrollView {
    VStack(alignment: .leading, spacing: 10) {
      Text("Set up Talos").font(.title2)
      Text("Nothing here blocks you. Each row is green or has a one-line fix.").foregroundStyle(.secondary)
      if ob.rows.isEmpty { ProgressView().controlSize(.small) }
      ForEach(ob.rows) { r in
        VStack(alignment: .leading, spacing: 6) {
        HStack(alignment: .firstTextBaseline, spacing: 8) {
          switch r.state {
          case .ok: Image(systemName: "checkmark.circle.fill").foregroundStyle(.green)
          case .fix: Image(systemName: "exclamationmark.circle.fill").foregroundStyle(.orange)
          case .unknown: Image(systemName: "questionmark.circle").foregroundStyle(.secondary)
          }
          VStack(alignment: .leading, spacing: 2) {
            Text(r.title)
            switch r.state {
            case .ok: EmptyView()
            case .fix(let m), .unknown(let m): Text(m).font(.caption).foregroundStyle(.secondary).fixedSize(horizontal: false, vertical: true)
            }
          }
        }
        if r.id == "agentfolder" { AgentFolderPanel(flow: flow).padding(.leading, 24) }
        }
      }
      Divider()
      SignInPanel(model: model)
      Divider()
      // The character is easy to miss: a switch right here, on the first screen the owner sees.
      Toggle("Show Companion", isOn: $companionOn)
      Text("A small character that shows what your agent is doing. You can turn it off any time here, in the Window menu, or in \(MacSettingsText.companionPath).")
        .font(.caption).foregroundStyle(.secondary).fixedSize(horizontal: false, vertical: true)
      Divider()
      // O7: the Dock icon is offered here, off until he turns it on. With it on, the menu at the top of the screen is always there.
      Toggle(
        "Show a Dock icon",
        isOn: Binding(
          get: { showDock },
          set: {
            showDock = $0
            ActivationPolicyController.shared.refresh()
          }))
      Text("Off keeps Talos in the menu bar only. On adds it to the Dock and keeps the menu at the top of the screen. Change it any time in \(MacSettingsText.generalPath).")
        .font(.caption).foregroundStyle(.secondary).fixedSize(horizontal: false, vertical: true)
      Divider()
      HStack {
        Button("Check again") { ob.refresh(config: model.supervisor.currentConfig(), setupDone: model.configured) }.disabled(ob.checking)
        Button("Find a running session…") { SettingsRouter.openAdopt(model: model) { openWindow(id: $0) } }
        Button("Permissions…") { SettingsRouter.open(.permissions) { openWindow(id: $0) } }
        Button("Settings…") { SettingsRouter.open(.session) { openWindow(id: $0) } }
        Button("Help") { HelpRouter.open(model: model) { openWindow(id: $0) } }
      }
    }
    .padding()
    }
    .frame(minWidth: 520, minHeight: 480, alignment: .topLeading)
    .onAppear { ob.refresh(config: model.supervisor.currentConfig(), setupDone: model.configured) }
    .onChange(of: ob.auth) { flow.signedIn = ob.auth }
    // Import or Adopt just made the setup: the first row turns green without pressing Check again.
    .onChange(of: model.configRevision) { ob.refresh(config: model.supervisor.currentConfig(), setupDone: model.configured) }
  }
}
