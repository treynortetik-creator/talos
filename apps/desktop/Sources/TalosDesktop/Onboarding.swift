import AppKit
import SwiftUI
import TalosDesktopCore
import TalosSupervisor

/// The old setup checklist (DESKTOP-SPEC 6.6), now the Advanced route "Use a folder I already have": each row green or a one-line fix,
/// nothing blocks. It is reached from the menu only. The first-run screens are `OnboardingWindowView`.
@MainActor
final class OnboardingModel: ObservableObject {
  @Published var rows: [FirstRun.Row] = []
  @Published var checking = false
  /// Whether Claude is signed in, from the last check (nil = couldn't tell). Create, Adopt and Choose start nothing when false.
  @Published var auth: Bool?

  /// The tools as found (absolute paths, versions), and the login environment they were found with. The sign-in step and the fixes use these.
  @Published var found: PrereqProbe.Found?
  @Published var fixNote = ""
  @Published var fixing = false
  private(set) var loginEnv: [String: String] = [:]
  private var lastConfig: DesktopConfig?
  private var lastSetupDone = false
  private var generation = 0

  /// The same check again, after a sign-in or a fix finished.
  func recheck() { if let c = lastConfig { refresh(config: c, setupDone: lastSetupDone) } }

  func fix(for id: String) -> PrereqPlan.Fix? {
    PrereqPlan.fix(for: id, brew: found?.brew, existingPath: id == "tmux" ? found?.tmux?.path : nil)
  }

  func runFix(_ fix: PrereqPlan.Fix) {
    switch fix {
    case .openPage(_, let url): if let u = URL(string: url) { NSWorkspace.shared.open(u) }
    case .brewInstall:
      fixing = true
      fixNote = OnboardingText.brewNeedsUser
      let env = loginEnv
      Task.detached {
        let failure = PrereqProbe.runFix(fix, env: env)
        await MainActor.run {
          self.fixing = false
          self.fixNote = failure ?? ""
          self.recheck()
        }
      }
    }
  }

  func refresh(config: DesktopConfig, setupDone: Bool) {
    checking = true
    lastConfig = config
    lastSetupDone = setupDone
    generation += 1
    let mine = generation
    let home = NSHomeDirectory()
    Task.detached {
      let probe = LiveSystem()
      let env = LoginShellEnv.build(shellEnv: probe.loginShellEnv() ?? [:], overrides: config.env)
      let found = PrereqProbe.probe(env: env, claudeName: config.claudePath == "auto" ? "claude" : config.claudePath, home: home)
      var auth: Bool?
      if let claude = found.claude {
        switch ClaudeSignIn.check(claude: claude.path, env: env) {
        case .signedIn: auth = true
        case .notSignedIn: auth = false
        case .unknown: auth = nil
        }
      }
      let tmuxOut = found.tmux.map { t in
        ProcessRunner.run([t.path, "-V"], env: env, timeout: 5).out.trimmingCharacters(in: .whitespacesAndNewlines)
      }
      let appHome = env["TALOS_APP_HOME"].flatMap { $0.isEmpty ? nil : $0 } ?? home + "/.config/talos/app"
      let cliFound = TalosAppCLI.resolve(config: config) != nil
      let folder = AgentFolderCheck.check(config.agentDir, home: home)
      var paths: [String: String] = [:]
      for (k, t) in [("claude", found.claude), ("bun", found.bun), ("tmux", found.tmux)] { if let t { paths[k] = t.path } }
      let rows = FirstRun.rows(
        .init(
          claudeVersion: found.claude.map { $0.version ?? "" }, authSignedIn: auth, bunPath: found.bun?.path, tmuxVersionOutput: tmuxOut,
          bridgeEnvPresent: FileManager.default.fileExists(atPath: appHome + "/bridge.env"), agentDir: config.agentDir,
          agentDirTrusted: FirstRun.trust(setupDone: setupDone, confirmedAt: config.session.confirmedAt), home: home,
          talosAppFound: cliFound, setupDone: setupDone, agentFolderProblem: folder.isProblem ? folder.text : nil,
          paths: paths, bunVersion: found.bun?.version))
      await MainActor.run {
        guard mine == self.generation else { return }  // a newer check already landed
        self.rows = rows
        self.auth = auth
        if case .finished(let o) = ClaudeSignInCoordinator.shared.state, ClaudeSignInPlan.isStale(outcome: o, authSignedIn: auth) {
          ClaudeSignInCoordinator.shared.reset()
        }
        self.found = found
        self.loginEnv = env
        self.checking = false
      }
    }
  }
}

struct AdvancedSetupView: View {
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
      Text(OnboardingCopy.advancedTitle).font(.title2)
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
            if let d = r.detail { Text(d).font(.caption).foregroundStyle(.secondary).textSelection(.enabled) }
            if case .fix = r.state, let f = ob.fix(for: r.id) {
              Button(f.label) { ob.runFix(f) }.disabled(ob.fixing)
            }
          }
        }
        if r.id == "agentfolder" { AgentFolderPanel(flow: flow).padding(.leading, 24) }
        }
      }
      if !ob.fixNote.isEmpty { Text(ob.fixNote).font(.caption).foregroundStyle(.secondary) }
      Divider()
      SignInClaudePanel(ob: ob)
      Divider()
      FirstStartPanel(model: model)
      Divider()
      OwnerRulesPanel(model: model)
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
    .onChange(of: model.configRevision) {
      ob.refresh(config: model.supervisor.currentConfig(), setupDone: model.configured)
      // set up by this route: the new screens' in-progress marker is stale
      OnboardingLaunch.settle(configured: model.configured, flowActive: OnboardingShared.isActive, home: NSHomeDirectory())
    }
  }
}
