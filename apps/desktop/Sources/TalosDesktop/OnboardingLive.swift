import AppKit
import Combine
import Foundation
import SwiftUI
import TalosDesktopCore
import TalosSupervisor

/// The setup's wiring to the app's real machinery. Nothing here decides anything the flow or the machinery does not: it maps their
/// states to the flow's events.
@MainActor
enum OnboardingLive {
  static func coordinator(model: SupervisorController, agent: AgentFolderFlow, web: WebController = .shared) -> OnboardingCoordinator {
    let home = NSHomeDirectory()
    agent.holdStart = true
    var deps = OnboardingCoordinator.Deps(pairing: LivePhonePairing(config: { model.supervisor.currentConfig() }, web: web))
    deps.home = home
    deps.provision = { progress, tools, ignoreSpace in
      await provision(agent: agent, progress: progress, tools: tools, ignoreSpace: ignoreSpace, schedulerNote: { model.notice = $0 })
    }
    deps.isOnline = { await Reachability.githubAnswers() }
    deps.checkSignIn = { await signInCheck(model: model) }
    deps.appleApps = LiveApps()
    deps.askAppleAgain = { _ = ProcessRunner.run(["/usr/bin/xcode-select", "--install"], timeout: 15) }
    deps.hasRelay = { web.hasRelay }
    deps.startAgent = { model.beginSession(model) }
    deps.showTalos = { if web.hasRelay { web.show() } else { model.notice = MacSettingsText.noRelayYet } }
    // the hello is asked of the bridge, never typed into a chat: pending until the bridge has taken it (HelloDelivery)
    deps.requestHello = { phone in
      HelloDelivery.save(HelloDelivery.Pending(phoneConnected: phone), home: home)
      HelloDeliveryTimer.shared.start(model: model)
    }
    return OnboardingCoordinator(deps: deps)
  }

  /// Talos's code and tools, then the agent's folder (its one installer run adds the scheduler too). Each step is the existing one; this reports how far it is.
  static func provision(
    agent: AgentFolderFlow, progress: @escaping @Sendable (Int) -> Void, tools: @escaping @Sendable (OnboardingCoordinator.ToolsSignal) -> Void,
    ignoreSpace: Bool = false, schedulerNote: @MainActor (String) -> Void
  ) async -> ProvisionOutcome {
    // Apple's installer refuses when the Mac is short of room (it asked for 19.18 GB on macOS 26): ask the owner to make room BEFORE
    // triggering it, never after it has put its own error on screen
    if !ignoreSpace, !CloneProvisioner.commandLineToolsInstalled(),
      let have = ToolsSpace.shortfall(available: ToolsSpace.availableBytes(home: NSHomeDirectory()))
    {
      return .needSpace(have: have)
    }
    let ok = await agent.ensureCheckout { step, state in
      progress(ProvisionProgress.percent(step: step, state: state))
      guard step == .developerTools else { return }
      switch state {
      case .waiting: tools(.asking)
      case .done: tools(.done)
      default: break
      }
    }
    guard ok else { return failure(agent.step) }
    progress(ProvisionProgress.agentFolder.0)
    guard await agent.ensureAgentFolder() else { return failure(agent.step) }
    progress(ProvisionProgress.agentFolder.1)
    if let why = agent.schedulerNote { schedulerNote(why) }
    progress(100)
    return .ok
  }

  /// A failed step as the flow reports it.
  static func failure(_ step: AgentFolderFlow.Step) -> ProvisionOutcome {
    switch step {
    case .provisionFailed(let lines, let message):
      let onTools = lines.contains { l in
        guard l.step == .developerTools, case .failed = l.state else { return false }
        return true
      }
      return .failed(message: message, onTools: onTools)
    case .failed(let message): return .failed(message: message, onTools: false)
    case .confirmClone:
      return .failed(message: "Talos found a copy of itself that it did not make, so it did not use it.", onTools: false)
    default: return .failed(message: "Talos couldn't finish setting up.", onTools: false)
    }
  }

  static func signInCheck(model: SupervisorController) async -> OnboardingCoordinator.SignInCheck {
    let config = model.supervisor.currentConfig()
    let home = NSHomeDirectory()
    return await Task.detached {
      let env = LoginShellEnv.build(shellEnv: LiveSystem().loginShellEnv() ?? [:], overrides: config.env)
      let found = PrereqProbe.probe(env: env, claudeName: config.claudePath == "auto" ? "claude" : config.claudePath, home: home)
      guard let claude = found.claude else { return .init(claude: nil, env: env, signedIn: nil) }
      switch ClaudeSignIn.check(claude: claude.path, env: env) {
      case .signedIn: return .init(claude: claude.path, env: env, signedIn: true)
      case .notSignedIn: return .init(claude: claude.path, env: env, signedIn: false)
      case .unknown: return .init(claude: claude.path, env: env, signedIn: nil)
      }
    }.value
  }
}

/// Apple's installer helper, found and raised through the system's own running-app list. `activate` also opens the helper's bundle again,
/// which raises a window that is behind another app's even where a plain activate is not allowed to take the front.
struct LiveApps: AppActivating {
  func isRunning(bundleID: String) -> Bool { !NSRunningApplication.runningApplications(withBundleIdentifier: bundleID).isEmpty }

  func activate(bundleID: String) -> Bool {
    guard let app = NSRunningApplication.runningApplications(withBundleIdentifier: bundleID).first else { return false }
    DispatchQueue.main.async {
      app.activate(options: [.activateAllWindows])
      if let url = app.bundleURL { NSWorkspace.shared.openApplication(at: url, configuration: NSWorkspace.OpenConfiguration()) { _, _ in } }
    }
    return true
  }
}

/// Whether the internet answers: one quick request to GitHub (where Talos downloads from). Any HTTP reply, even an error page, means
/// the network is up; only "no connection", a timeout or a failed lookup mean offline.
enum Reachability {
  static func githubAnswers(timeout: TimeInterval = 6) async -> Bool {
    guard let url = URL(string: "https://github.com") else { return true }
    var r = URLRequest(url: url, cachePolicy: .reloadIgnoringLocalCacheData, timeoutInterval: timeout)
    r.httpMethod = "HEAD"
    do {
      _ = try await URLSession(configuration: .ephemeral).data(for: r)
      return true
    } catch {
      return !isOffline(error)
    }
  }

  static func isOffline(_ error: Error) -> Bool {
    let code = (error as? URLError)?.code
    return [.notConnectedToInternet, .networkConnectionLost, .timedOut, .cannotFindHost, .cannotConnectToHost, .dnsLookupFailed, .internationalRoamingOff, .dataNotAllowed]
      .contains { $0 == code }
  }
}

/// The phone step on the real `PairingController`: the same `talos-app enroll` run as the Mac's own sign-in, named "Phone", with the
/// code shown only as the QR and the four words answered on the setup screen. The controller keeps every safety rule (the click must be
/// the owner's real one, once, after the read delay, never after the question was withdrawn).
@MainActor
final class LivePhonePairing: PhonePairing {
  var onEvent: ((OnboardingFlow.Event) -> Void)?
  private let config: () -> DesktopConfig
  private let web: WebController
  private let controller: PairingController
  private var bag = Set<AnyCancellable>()
  private var starting: Task<Void, Never>?

  init(config: @escaping () -> DesktopConfig, web: WebController, controller: PairingController = .shared) {
    self.config = config
    self.web = web
    self.controller = controller
    controller.$link.removeDuplicates().compactMap { $0 }.sink { [weak self] l in self?.onEvent?(.pairLink(l)) }.store(in: &bag)
    controller.$phase.sink { [weak self] p in self?.phaseChanged(p) }.store(in: &bag)  // every set, so a second failure is told again
    controller.$confirmedExit.compactMap { $0 }.sink { [weak self] code in
      self?.onEvent?(code == 0 ? .pairConnected : .pairFailed(OnboardingCopy.pairFailed))
    }.store(in: &bag)
  }

  private func phaseChanged(_ p: PairingPhase) {
    guard controller.purpose == .phone else { return }
    switch p {
    case .confirm(let words): onEvent?(.pairWords(words))
    case .failed: onEvent?(.pairFailed(OnboardingCopy.pairFailed))
    default: break
    }
  }

  /// How long the last run's program may take to end before it is ended by force (tests shorten it).
  var endWait: TimeInterval = 5

  func start() {
    starting?.cancel()
    // nothing to connect a phone through: said at once, never a code that cannot come (the setup does not offer this, this is the floor)
    guard web.relay != nil else {
      onEvent?(.pairFailed(OnboardingCopy.pairFailed))
      return
    }
    // the old run's program ends a moment after a "no"; a new code waits for it, ends it by force after `endWait`, and never spins
    starting = Task { [weak self] in
      guard let self else { return }
      var waited: TimeInterval = 0
      while self.controller.isRunning, waited < self.endWait, !Task.isCancelled {
        try? await Task.sleep(nanoseconds: 100_000_000)
        waited += 0.1
      }
      guard !Task.isCancelled else { return }
      if self.controller.isRunning {
        self.controller.killChild()
        for _ in 0..<20 where self.controller.isRunning { try? await Task.sleep(nanoseconds: 100_000_000) }
        if self.controller.isRunning {
          self.onEvent?(.pairFailed(OnboardingCopy.pairFailed))
          return
        }
      }
      self.controller.start(config: self.config(), web: self.web, purpose: .phone)
    }
  }

  func approve(event: NSEvent?, button: NSButton) -> Bool { controller.approve(clickedBy: event, on: button) }
  func decline() { controller.mismatch() }
  func cancel() {
    starting?.cancel()
    controller.cancel()
  }
}

/// Asks the bridge for the hello until it has taken it: each few seconds, while the note is pending, `HelloDelivery.tick` writes the request
/// when the agent's connection is up and clears the note once the bridge has read it. Started at the end of setup, and again at every launch
/// (a hello that could not be asked for yet is still pending).
@MainActor
final class HelloDeliveryTimer {
  static let shared = HelloDeliveryTimer()
  private var task: Task<Void, Never>?

  func start(model: SupervisorController, home: String = NSHomeDirectory(), every: TimeInterval = 5) {
    guard HelloDelivery.read(home: home) != nil, task == nil else { return }
    task = Task { [weak self] in
      while !Task.isCancelled {
        let up = FirstStartCheck.state(model.status) == .done
        HelloDelivery.tick(home: home, talosHome: model.workersHome, bridgeUp: up)
        if HelloDelivery.read(home: home) == nil { break }
        try? await Task.sleep(nanoseconds: UInt64(every * 1_000_000_000))
      }
      self?.task = nil
    }
  }
}

/// One setup per app run: the window opening again finds the same download and the same coordinator, never a second one.
@MainActor
enum OnboardingShared {
  private static var coordinator: OnboardingCoordinator?
  /// The setup screens already opened since this launch (in memory: every launch starts again).
  static var openedThisRun = false
  static func get(model: SupervisorController) -> OnboardingCoordinator {
    if let c = coordinator { return c }
    let c = OnboardingLive.coordinator(model: model, agent: AgentFolderFlow(model: model))
    coordinator = c
    return c
  }
  static var isActive: Bool { coordinator?.isActive ?? false }
}
