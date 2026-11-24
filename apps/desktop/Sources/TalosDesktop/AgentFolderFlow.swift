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
    /// A prebuilt app's recorded clone that the owner has not said yes to: shown with its path; Use this clone or Cancel. The yes
    /// binds this path: if the record names another one by then, nothing runs.
    case confirmClone(clone: String, then: CloneAction)
    /// The Talos code is being fetched for this app (`ensureCheckout`): each step with how it stands, errors included.
    case provisioning([ProvisionLine])
    /// The fetch stopped at a step; Retry runs it again (a finished clone is kept and reused).
    case provisionFailed([ProvisionLine], message: String)
    case done(String)
    case failed(String)
  }

  struct ProvisionLine: Equatable, Sendable {
    var step: CloneProvisioner.Step
    /// nil: not reached yet.
    var state: CloneProvisioner.State?
  }

  /// What the owner pressed that needed the clone, to run once the clone card is answered.
  enum CloneAction: Equatable { case create, adopt, choose, acceptOnly }

  /// What the flow needs from the world. The defaults are the app's own; tests hand in a scratch clone and environment.
  struct Deps: Sendable {
    /// The clone this Talos was built from (`build-app.sh` stamps it, inside the app's signature). It holds install.sh, the bridge
    /// and the mod. A prebuilt app has none: then `recordedRoot`.
    var repoRoot: @Sendable () -> String? = { Bundle.main.object(forInfoDictionaryKey: "TalosCheckout") as? String }
    /// The clone `install.sh --from-release` recorded, read fresh each time. Any program of the owner's can write the record, so it
    /// is judged (`AgentFolderSetup.recordedCloneProblem`) and the owner confirms it before it is used.
    var recordedRoot: @Sendable () -> String? = { AgentFolderSetup.recordedCheckout(in: AutoSetup.recordFolders(home: NSHomeDirectory()))?.clone }
    /// The record file to hold to the ownership rule. nil: the one `recordedRoot` read (the new folder's, else the old one's).
    var recordFile: String? = nil
    /// What fetches the Talos code when there is no stamped clone and no record. nil config: nothing can be fetched.
    var provision: @Sendable () -> CloneProvisioner.Config? = {
      let home = NSHomeDirectory()
      let env = LoginShellEnv.build(shellEnv: LiveSystem().loginShellEnv() ?? ProcessInfo.processInfo.environment, overrides: [:])
      let exec = FileManager.default.isExecutableFile
      var c = CloneProvisioner.Config(
        version: Bundle.main.infoDictionary?["CFBundleShortVersionString"] as? String,
        destination: AutoSetup.cloneFolder(home: home), recordFile: AutoSetup.appFolder(home: home) + "/checkout",
        git: nil,
        pnpm: TalosAppLocator.findProgram("pnpm", searchPath: env["PATH"], home: home, isExecutable: exec), env: env)
      c.expectedCommit = Bundle.main.object(forInfoDictionaryKey: "TalosSourceCommit") as? String
      c.expectedSourceSHA256 = Bundle.main.object(forInfoDictionaryKey: "TalosSourceSHA256") as? String
      c.bun = TalosAppLocator.findProgram("bun", searchPath: env["PATH"], home: home, isExecutable: exec)
      c.claudeFound = {
        let ok = FileManager.default.isExecutableFile
        return TalosAppLocator.findProgram("claude", searchPath: env["PATH"], home: home, isExecutable: ok) != nil || ok(home + "/.local/bin/claude")
      }
      c.claudeInstaller = ClaudeInstaller(
        env: env, home: home, workDir: AutoSetup.appFolder(home: home), scriptPath: Bundle.main.path(forResource: "claude-install", ofType: "sh"))
      return c
    }
    /// Runs the provisioner (a test hands in one that answers without a network). `madeHere`: this run cloned or downloaded and verified
    /// the tree itself; false when it reused a folder that was already there.
    var runProvisioner: @Sendable (CloneProvisioner.Config, @Sendable (CloneProvisioner.Step, CloneProvisioner.State) -> Void)
      -> (result: CloneProvisioner.Result, madeHere: Bool) = { config, progress in
        CloneProvisioner(config).runReportingOrigin(progress: progress)
      }
    /// The owner's home: where the app's own folder and its own clone are.
    var home: String = NSHomeDirectory()
    /// The recorded clone the owner said yes to.
    var acceptance: any CloneAcceptance = KeychainCloneAcceptance()
    /// Folders a recorded clone may not be in. nil: `AgentFolderSetup.sessionFolders` (the Talos home, the agent folder, each
    /// thread's folder, the temp roots and the app's own support folder).
    var unsafeFolders: (@Sendable () -> [String])? = nil
    /// The environment the tools run in: the login shell's, as the checklist's other checks use. Blocks; called off the main thread.
    var environment: @Sendable () -> [String: String] = {
      // the app's own bun and tmux are on the PATH last; with no pnpm the installer uses bun (TALOS_JS_RUNTIME), and no git hook
      // installer runs (it would run git, which on a Mac without the developer tools opens Apple's install dialog)
      var e = BundledTools.jsRuntimeEnv(
        LoginShellEnv.build(shellEnv: LiveSystem().loginShellEnv() ?? ProcessInfo.processInfo.environment, overrides: [:]))
      e["TALOS_NO_HOOKS"] = "1"
      if let p = BundledTools.appending(toPath: e["PATH"], dir: NSHomeDirectory() + "/.local/bin") { e["PATH"] = p }
      return e
    }
  }

  @Published private(set) var step: Step = .idle
  /// What the owner pressed when the Talos code had to be fetched first; Retry carries on with it.
  private var pending: CloneAction?
  private var autoTried = false
  /// The folder box.
  @Published var path: String
  /// Set by the last Create when the folder is fine but the installer left its "scheduler not added" marker: the plain words, once.
  /// The setup screens read it; the checklist's card carries it in its own note.
  private(set) var schedulerNote: String?
  /// Whether Claude is signed in, from the checklist's last check. false keeps the session from starting; nil does not.
  var signedIn: Bool?
  /// The new setup starts the agent itself once the owner reaches its end (sign-in and phone come first), so `finish` makes the folder
  /// and the setup file and starts nothing.
  var holdStart = false
  var busy: Bool {
    switch step {
    case .working, .provisioning: return true
    default: return false
    }
  }
  /// One fetch of the Talos code at a time, whoever asks (the automatic run, a button, a second press).
  private let fetch = SingleFlight<Provisioned?>()
  /// What a provisioner run answered, and whether that run made the tree itself (`CloneProvisioner.runReportingOrigin`).
  struct Provisioned: Sendable { var result: CloneProvisioner.Result; var madeHere: Bool }
  private var fetchSteps = LinesBox()

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
    guard await ensureCheckout(then: .create) else { return }
    guard let (dir, repo) = target(for: .create) else { return }
    step = .working("Creating your agent in \(dir). This can take a few minutes.")
    schedulerNote = nil
    let env = deps.environment
    let home = deps.home
    // ONE installer run does everything, the scheduler included; the app never runs it a second time
    let result = await Task.detached { Self.runInstall(repo: repo, dir: dir, env: env(), home: home) }.value
    switch result.outcome {
    case .done: finish(dir, repo: repo, schedulerLater: result.schedulerLater)
    case .failed(let why), .needsConfirm(let why): step = .failed(why)
    }
  }

  /// Connect a Claude Code folder you already use: `talos-app adopt`, run through the pty human-only commands need. First the
  /// dry run, which becomes the card; the owner's yes runs it for real.
  func adopt() async {
    guard await ensureCheckout(then: .adopt) else { return }
    guard let (dir, repo) = target(mustExist: true, for: .adopt) else { return }
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
    guard await ensureCheckout(then: .choose) else { return }
    guard let repo = cloneRoot(for: .choose) else { return }
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
    guard let repo = cloneRoot(for: .adopt) else { return }
    step = .working("Connecting \(dir)…")
    switch await runAdopt(repo: repo, dir: dir, mode: repoint ? .repoint : .connect) {
    case .done: finish(dir, repo: repo, kitUpdate: true)
    case .needsConfirm(let why): step = .confirmRepoint(dir: dir, why: why)
    case .failed(let why): step = .failed(why)
    }
  }

  func cancel() { step = .idle }

  // MARK: automatic setup (what the onboarding screen calls)

  /// Onboarding's one call: the Talos code, then the default agent folder, each only if it is not there. Tried once per window; a
  /// failure stays on the card with Retry (`retryProvision`).
  func autoSetup() async {
    guard !autoTried, !busy, !model.configured else { return }
    autoTried = true
    guard await ensureCheckout() else { return }
    _ = await ensureAgentFolder()
  }

  /// A clone to run scripts from: the one stamped in this app, the recorded one, or (a prebuilt app on a Mac with none) the public
  /// repository fetched at this app's tag into `AutoSetup.cloneFolder`, its dependencies checked, and recorded. `progress` is told
  /// each step as it happens (on the main thread); `step` carries the same for the built-in card. false: nothing usable yet, and
  /// `step` says why.
  @discardableResult
  func ensureCheckout(then action: CloneAction? = nil, progress: (@Sendable (CloneProvisioner.Step, CloneProvisioner.State) -> Void)? = nil)
    async -> Bool
  {
    if let s = deps.repoRoot(), !s.isEmpty { return true }
    if let r = deps.recordedRoot(), !r.isEmpty { return true }
    pending = action
    var lines = CloneProvisioner.Step.allCases.map { ProvisionLine(step: $0, state: nil) }
    step = .provisioning(lines)
    if !fetch.isRunning { fetchSteps = LinesBox() }
    let box = fetchSteps
    let make = deps.provision
    let run = deps.runProvisioner
    let outcome = await fetch.run {
      await Task.detached { () -> Provisioned? in
        guard let config = make() else { return nil }
        let report: @Sendable (CloneProvisioner.Step, CloneProvisioner.State) -> Void = { s, st in
          progress?(s, st)
          let snapshot = box.set(s, st)
          DispatchQueue.main.async { MainActor.assumeIsolated { self.showProvisioning(snapshot) } }
        }
        let r = run(config, report)
        return Provisioned(result: r.result, madeHere: r.madeHere)
      }.value
    }
    guard let result = outcome else {
      step = .failed("Talos has no way to download its code on this Mac. Use Choose… to point at a clone of the Talos repository.")
      return false
    }
    lines = box.lines
    switch result.result {
    case .ok(let clone):
      guard ownCloneAccepted(clone, madeHere: result.madeHere) else {
        CloneConfirmCenter.shared.request(clone)
        step = .confirmClone(clone: clone, then: pending ?? .acceptOnly)
        return false
      }
      guard deps.acceptance.accept(clone) else {
        step = .provisionFailed(lines, message: "Talos couldn't remember its new copy in the Keychain. Check that the login keychain is unlocked, then press Retry.")
        return false
      }
      step = .idle
      return true
    case .failed(_, let message):
      step = .provisionFailed(lines, message: message)
      return false
    }
  }

  /// The clone this app just made counts as accepted (no click) only when THIS run cloned or downloaded and verified the tree
  /// (`madeHere`: never a folder that was already there, whatever its marker says, since anything able to write the owner's files
  /// can plant one), it is provably the app's own fixed-place clone, named by the app's own record, and it passes every check a
  /// recorded clone passes (`AgentFolderSetup.ownCloneMayBeAccepted`). Anything else is asked about. This only decides;
  /// `ensureCheckout` writes the acceptance.
  func ownCloneAccepted(_ clone: String, madeHere: Bool) -> Bool {
    madeHere
      && AgentFolderSetup.ownCloneMayBeAccepted(
        clone: clone, record: AgentFolderSetup.recordedCheckout(in: AutoSetup.recordFolders(home: deps.home)), home: deps.home,
        unsafe: unsafeFolders())
  }

  private func showProvisioning(_ lines: [ProvisionLine]) {
    if case .provisioning = step { step = .provisioning(lines) }
  }

  /// Retry on the fetch card: run it again (a clone already made is reused), then whatever the owner had pressed.
  func retryProvision() async {
    guard case .provisionFailed = step else { return }
    let action = pending
    guard await ensureCheckout(then: action) else { return }
    pending = nil
    switch action {
    case .create: await create()
    case .adopt: await adopt()
    case .choose: await choose()
    case .acceptOnly: break
    case nil: _ = await ensureAgentFolder()
    }
  }

  /// The default agent folder, made with no question: Create on `AutoSetup.defaultAgentDir` unless an agent is already set up. An
  /// installer refusal (a folder that is not empty and not a Talos agent) stays on the card; nothing is deleted. true: set up.
  @discardableResult
  func ensureAgentFolder() async -> Bool {
    schedulerNote = nil
    if model.configured { return true }
    if path.trimmingCharacters(in: .whitespaces).isEmpty { path = AutoSetup.defaultAgentDir }
    await create()
    return model.configured
  }

  /// Yes to the kit update card: run the update as a preview. It changes nothing; the real update is a command for Terminal.
  func showUpgrade() async {
    guard case .offerUpgrade(let dir, _, let command, let note) = step, let repo = cloneRoot(for: .adopt) else { return }
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

  /// The clone Talos runs scripts from, once it is whole. Create, Adopt and Choose all ask here; a partial one is said plainly. The
  /// stamped clone is part of the signed app. A recorded one must pass the session-folder and ownership rules, and must be the one
  /// the owner said yes to; another puts the clone card up instead (and `useClone` runs `action` after the yes).
  private func cloneRoot(for action: CloneAction) -> String? {
    if let stamped = deps.repoRoot(), !stamped.isEmpty {
      if let why = AgentFolderSetup.cloneProblem(stamped) {
        step = .failed(why)
        return nil
      }
      return stamped
    }
    let recorded = deps.recordedRoot() ?? ""
    if let why = recordedProblem(recorded) {
      step = .failed(why)
      return nil
    }
    if deps.acceptance.accepted() != recorded {
      step = .confirmClone(clone: recorded, then: action)
      return nil
    }
    return recorded
  }

  private func unsafeFolders() -> [String] {
    deps.unsafeFolders?()
      ?? AgentFolderSetup.sessionFolders(
        talosHome: model.workersHome, agentDir: model.supervisor.currentConfig().expandedAgentDir(home: NSHomeDirectory()),
        configJSON: FileManager.default.contents(atPath: model.workersHome + "/config.json"), supportDir: SupervisorController.supportDir)
  }

  private func recordedProblem(_ recorded: String) -> String? {
    if recorded.isEmpty { return AgentFolderSetup.cloneProblem("") }
    let avoid = unsafeFolders()
    let file = deps.recordFile
      ?? AgentFolderSetup.recordedCheckout(in: AutoSetup.recordFolders(home: NSHomeDirectory()))?.file
      ?? AutoSetup.appFolder(home: NSHomeDirectory()) + "/checkout"
    return AgentFolderSetup.recordedCloneProblem(recorded, recordFile: file, unsafe: avoid)
      ?? AgentFolderSetup.cloneProblem(recorded)
  }

  /// Use this clone, on the clone card: remembered only if the record still names the clone that was shown and it still passes,
  /// then what the owner pressed runs.
  func useClone() async {
    guard case .confirmClone(let shown, let action) = step else { return }
    let now = deps.recordedRoot() ?? ""
    guard now == shown else {
      step = .failed("The recorded clone changed while this card was open (it now says \(now.isEmpty ? "nothing" : now)). Nothing ran.")
      return
    }
    if let why = recordedProblem(shown) {
      step = .failed(why)
      return
    }
    guard deps.acceptance.accept(shown) else {
      step = .failed("Talos couldn't remember this clone in the Keychain, so nothing ran. Try again; if it keeps failing, check that the login keychain is unlocked.")
      return
    }
    switch action {
    case .create: await create()
    case .adopt: await adopt()
    case .choose: await choose()
    case .acceptOnly: step = .done("Talos will use \(shown) and can keep itself up to date.")
    }
    CloneConfirmCenter.shared.clear()
  }

  /// The folder box as an absolute path, and the clone. A failure is already on the card.
  private func target(mustExist: Bool = false, for action: CloneAction) -> (dir: String, repo: String)? {
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
    guard let repo = cloneRoot(for: action) else { return nil }
    return (dir, repo)
  }

  /// The folder is ready: name it in `desktop.json`, start the session if Claude is signed in, and say what happened. A kit 1.x
  /// folder that was adopted (`kitUpdate`) also gets the update card; one Create just installed is current.
  private func finish(_ dir: String, repo: String, kitUpdate: Bool = false, schedulerLater: Bool = false) {
    let wasConfigured = model.configured
    if let why = model.useAgentFolder(dir, launchArgs: AgentFolderSetup.launchArgs(repo: repo)) {
      step = .failed(why)
      return
    }
    var note: String
    if wasConfigured {
      note = "\(dir) is now the agent folder. It applies the next time the agent starts (Restart your agent in the menu bar item)."
    } else if holdStart {
      note = "Set up."
    } else if signedIn == false {
      note =
        "Set up. Claude isn't signed in, so nothing has started: choose Sign in to Claude again in the menu bar item, then choose Start your agent."
    } else {
      note =
        model.beginSession(model)
        ? "Set up, and the session is starting. The first time, Claude asks you to confirm a few things: connector and permission questions come as a Talos popup with buttons; for the folder question, open \(MacWords.agentScreenPath)."
        : "Set up, but the session did not start (the menu bar item says why). Choose Start your agent when you are ready."
    }
    if let f = FirstRun.protectedFolder(dir, home: NSHomeDirectory()) {
      note += " The folder is inside \(f), which macOS protects, so macOS asks Talos once."
    }
    if schedulerLater {
      schedulerNote = AgentFolderSetup.chronosLater
      if !holdStart { note += " " + AgentFolderSetup.chronosLater }
    }
    if kitUpdate, let v = AgentFolderSetup.kit1Version(in: dir) {
      let command = (["bash"] + AgentFolderSetup.upgradeArguments(repo: repo, dir: dir)).map(LaunchSpec.shellQuote).joined(separator: " ")
      step = .offerUpgrade(dir: dir, version: v, command: command, note: note)
    } else {
      step = .done(note)
    }
  }

  // MARK: running things (off the main thread)

  /// The one installer run. The marker is looked for in the environment this very child gets (same HOME, same XDG_CONFIG_HOME).
  nonisolated static func runInstall(repo: String, dir: String, env: [String: String], home: String)
    -> (outcome: AgentFolderSetup.Outcome, schedulerLater: Bool)
  {
    let existed = AgentFolderSetup.agentExisted(dir: dir, repo: repo)
    let r = ProcessRunner.run(
      ["/bin/bash"] + AgentFolderSetup.installArguments(repo: repo, dir: dir), env: env, cwd: repo, timeout: 1800)
    if r.timedOut {
      return (.failed("The installer took too long and was stopped. \(dir) may hold a partial copy: move it aside, then press Create again."), false)
    }
    let marker = AgentFolderSetup.chronosMarkerPresent(at: AgentFolderSetup.chronosMarkerPath(env: env, fallbackHome: home))
    let res = AgentFolderSetup.installResult(
      status: r.status, stderr: r.err, agentExisted: existed, markerPresent: marker,
      connected: AgentFolderSetup.connectedToTalos(dir))
    return (res.outcome, res.schedulerLater)
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

/// The fetch's steps as they stand, written from the background thread and read on the main one.
private final class LinesBox: @unchecked Sendable {
  private let lock = NSLock()
  private var v = CloneProvisioner.Step.allCases.map { AgentFolderFlow.ProvisionLine(step: $0, state: nil) }
  var lines: [AgentFolderFlow.ProvisionLine] { lock.withLock { v } }
  func set(_ s: CloneProvisioner.Step, _ st: CloneProvisioner.State) -> [AgentFolderFlow.ProvisionLine] {
    lock.withLock {
      if let i = v.firstIndex(where: { $0.step == s }) { v[i].state = st }
      return v
    }
  }
}
