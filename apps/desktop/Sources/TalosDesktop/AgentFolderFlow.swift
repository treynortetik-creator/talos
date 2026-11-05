import Foundation
import TalosDesktopCore
import TalosSupervisor

/// The checklist's Agent folder row: Create, Adopt or Choose. Each ends the same way: the folder is on disk, then
/// `desktop.json` names it (the last step, so an app that quits half way leaves nothing to undo), then the session starts if
/// Claude is signed in. Nothing here deletes; every refusal says why and leaves the folder as it was.
@MainActor
final class AgentFolderFlow: ObservableObject {
  enum Step: Equatable {
    case idle
    case working(String)
    /// Adopt's card: what would change, from `talos-app adopt --dry-run`. Connect or Cancel.
    case confirmAdopt(dir: String, plan: String, repoint: Bool)
    /// Adopt found a talos-app server that runs another clone: replace it, or leave it.
    case confirmRepoint(dir: String, why: String)
    /// A kit 1.x folder: the update path, shown and run (as a preview) only on yes.
    case offerUpgrade(dir: String, version: String, command: String, note: String)
    case upgradePreview(text: String, command: String, note: String)
    case done(String)
    case failed(String)
  }

  /// What the flow needs from the world. The defaults are the app's own; tests hand in a scratch clone and environment.
  struct Deps: Sendable {
    /// The clone this Talos was built from (`build-app.sh` stamps it). It holds install.sh, the bridge and the mod.
    var repoRoot: @Sendable () -> String? = { Bundle.main.object(forInfoDictionaryKey: "TalosCheckout") as? String }
    /// The environment the tools run in: the login shell's, as the checklist's other checks use. Blocks; called off the main thread.
    var environment: @Sendable () -> [String: String] = {
      LoginShellEnv.build(shellEnv: LiveSystem().loginShellEnv() ?? ProcessInfo.processInfo.environment, overrides: [:])
    }
  }

  @Published private(set) var step: Step = .idle
  /// The folder box.
  @Published var path: String
  /// Whether Claude is signed in, from the checklist's last check. false keeps the session from starting; nil does not.
  var signedIn: Bool?
  var busy: Bool { if case .working = step { return true } else { return false } }

  private let model: SupervisorController
  private let deps: Deps

  init(model: SupervisorController, deps: Deps = Deps()) {
    self.model = model
    self.deps = deps
    path = model.supervisor.currentConfig().agentDir
  }

  // MARK: the three ways

  /// A new agent from this clone's install.sh. The installer refuses a folder that is not empty and not a Talos agent, and a
  /// synced folder; it warns about Desktop, Documents and Downloads. A Talos agent that is already there is not touched.
  func create() async {
    guard let (dir, repo) = target() else { return }
    step = .working("Creating your agent in \(dir). This can take a few minutes.")
    let env = deps.environment
    let outcome = await Task.detached { Self.runInstall(repo: repo, dir: dir, env: env()) }.value
    switch outcome {
    case .done: finish(dir, repo: repo)
    case .failed(let why), .needsConfirm(let why): step = .failed(why)
    }
  }

  /// Connect a Claude Code folder you already use: `talos-app adopt`, run through the pty human-only commands need. First the
  /// dry run, which becomes the card; the owner's yes runs it for real.
  func adopt() async {
    guard let (dir, repo) = target(mustExist: true) else { return }
    step = .working("Reading \(dir)…")
    switch await runAdopt(repo: repo, dir: dir, mode: .dryRun) {
    case .done(let text): step = .confirmAdopt(dir: dir, plan: text, repoint: false)
    case .needsConfirm(let why): step = .confirmRepoint(dir: dir, why: why)
    case .failed(let why): step = .failed(why)
    }
  }

  /// A Talos agent folder that is already set up. Nothing is written to it. A folder wired to another clone or another home is
  /// judged by the same dry run Adopt shows, and sent to Adopt, which asks before pointing it here.
  func choose() async {
    guard let repo = cloneRoot() else { return }
    let cfg = model.supervisor.currentConfig()
    switch AgentFolderSetup.choose(path, home: NSHomeDirectory(), currentAgentDir: model.configured ? cfg.agentDir : nil) {
    case .refused(let why): step = .failed(why)
    case .ok(let dir):
      step = .working("Checking \(dir)…")
      switch await runAdopt(repo: repo, dir: dir, mode: .dryRun) {
      case .done: finish(dir, repo: repo)
      case .needsConfirm(let why): step = .failed("\(why)\nUse Adopt for this folder: it asks before pointing it at this Talos.")
      case .failed(let why): step = .failed(why)
      }
    }
  }

  // MARK: the cards

  /// Connect (Adopt's card) or Replace (the other-clone card).
  func confirm() async {
    let dir: String
    let repoint: Bool
    switch step {
    case .confirmAdopt(let d, _, let r): (dir, repoint) = (d, r)
    case .confirmRepoint(let d, _): (dir, repoint) = (d, true)
    default: return
    }
    guard let repo = cloneRoot() else { return }
    step = .working("Connecting \(dir)…")
    switch await runAdopt(repo: repo, dir: dir, mode: repoint ? .repoint : .connect) {
    case .done: finish(dir, repo: repo, kitUpdate: true)
    case .needsConfirm(let why): step = .confirmRepoint(dir: dir, why: why)
    case .failed(let why): step = .failed(why)
    }
  }

  func cancel() { step = .idle }

  /// Yes to the kit update card: run the update as a preview. It changes nothing; the real update is a command for Terminal.
  func showUpgrade() async {
    guard case .offerUpgrade(let dir, _, let command, let note) = step, let repo = cloneRoot() else { return }
    step = .working("Reading what the update would change…")
    let env = deps.environment
    let text = await Task.detached { () -> String in
      let r = ProcessRunner.run(
        ["/bin/bash"] + AgentFolderSetup.upgradeArguments(repo: repo, dir: dir), env: env(), timeout: 120)
      return (r.out + r.err).replacingOccurrences(of: "\u{1B}\\[[0-9;]*m", with: "", options: .regularExpression)
    }.value
    step = .upgradePreview(text: String(text.split(separator: "\n").suffix(40).joined(separator: "\n")), command: command, note: note)
  }

  func declineUpgrade() {
    if case .offerUpgrade(_, _, _, let note) = step { step = .done(note) }
  }

  // MARK: shared

  /// The clone Talos was built from, once it is whole. Create, Adopt and Choose all ask here; a partial one is said plainly.
  private func cloneRoot() -> String? {
    let r = deps.repoRoot() ?? ""
    if let why = AgentFolderSetup.cloneProblem(r) {
      step = .failed(why)
      return nil
    }
    return r
  }

  /// The folder box as an absolute path, and the clone. A failure is already on the card.
  private func target(mustExist: Bool = false) -> (dir: String, repo: String)? {
    let home = NSHomeDirectory()
    let dir = PathUtil.expandTilde(path.trimmingCharacters(in: .whitespaces), home: home)
    if dir.isEmpty || !dir.hasPrefix("/") {
      step = .failed("Type the folder as a full path starting with / or ~.")
      return nil
    }
    if mustExist {
      let c = AgentFolderCheck.check(dir, home: home)
      if c.isProblem {
        step = .failed(c.text)
        return nil
      }
    }
    guard let repo = cloneRoot() else { return nil }
    return (dir, repo)
  }

  /// The folder is ready: name it in `desktop.json`, start the session if Claude is signed in, and say what happened. A kit 1.x
  /// folder that was adopted (`kitUpdate`) also gets the update card; one Create just installed is current.
  private func finish(_ dir: String, repo: String, kitUpdate: Bool = false) {
    let wasConfigured = model.configured
    if let why = model.useAgentFolder(dir, launchArgs: AgentFolderSetup.launchArgs(repo: repo)) {
      step = .failed(why)
      return
    }
    var note: String
    if wasConfigured {
      note = "\(dir) is now the agent folder. It applies the next time the agent starts (Restart session in the menu bar item)."
    } else if signedIn == false {
      note =
        "Set up. Claude isn't signed in, so nothing has started: run claude in Terminal, type /login, then choose Start session in the menu bar item."
    } else {
      note =
        model.beginSession(model)
        ? "Set up, and the session is starting. The first time, Claude asks you to confirm a few things: open Show Terminal in the menu bar item and answer them there."
        : "Set up, but the session did not start (the menu bar item says why). Choose Start session when you are ready."
    }
    if let f = FirstRun.protectedFolder(dir, home: NSHomeDirectory()) {
      note += " The folder is inside \(f), which macOS protects, so macOS asks Talos once."
    }
    if kitUpdate, let v = AgentFolderSetup.kit1Version(in: dir) {
      let command = (["bash"] + AgentFolderSetup.upgradeArguments(repo: repo, dir: dir)).map(LaunchSpec.shellQuote).joined(separator: " ")
      step = .offerUpgrade(dir: dir, version: v, command: command, note: note)
    } else {
      step = .done(note)
    }
  }

  // MARK: running things (off the main thread)

  nonisolated static func runInstall(repo: String, dir: String, env: [String: String]) -> AgentFolderSetup.Outcome {
    let r = ProcessRunner.run(
      ["/bin/bash"] + AgentFolderSetup.installArguments(repo: repo, dir: dir), env: env, cwd: repo, timeout: 1800)
    if r.timedOut {
      return .failed("The installer took too long and was stopped. \(dir) may hold a partial copy: move it aside, then press Create again.")
    }
    return AgentFolderSetup.createOutcome(status: r.status, stderr: r.err)
  }

  enum AdoptMode { case dryRun, connect, repoint }
  enum AdoptResult { case done(String), needsConfirm(String), failed(String) }

  /// `talos-app adopt` through the pty (`TalosAppCLI.run`): it refuses without a terminal, and this is how the checklist gives
  /// it one. The clone's own bridge runs, the one that Create and `install.sh` register.
  private func runAdopt(repo: String, dir: String, mode: AdoptMode) async -> AdoptResult {
    let env = deps.environment
    let args =
      ["adopt", "--agent-dir", dir]
      + (mode == .dryRun ? ["--dry-run"] : ["--yes"]) + (mode == .repoint ? ["--repoint"] : [])
    let out = await Task.detached { () -> TalosAppCLI.Output? in
      let e = env()
      let home = NSHomeDirectory()
      guard let bun = TalosAppLocator.findProgram("bun", searchPath: e["PATH"], home: home, isExecutable: FileManager.default.isExecutableFile)
      else { return nil }
      return TalosAppCLI.run(
        .init(command: [bun, "--no-env-file", "run", repo + "/apps/bridge/src/cli.ts"], env: e), args, timeout: 120)
    }.value
    let text = out?.text ?? ""
    switch AgentFolderSetup.adoptOutcome(status: out?.status, output: text) {
    case .done: return .done(text.trimmingCharacters(in: .whitespacesAndNewlines))
    case .needsConfirm(let why): return .needsConfirm(why)
    case .failed(let why):
      return .failed(out == nil ? "Talos couldn't run talos-app. Is bun installed? Run ./install.sh in the clone Talos was built from." : why)
    }
  }
}
