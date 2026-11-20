import AppKit
import Foundation
import SwiftUI
import TalosDesktopCore
import TalosSupervisor

/// The phone step's pairing, as the coordinator needs it. The live one is `PairingController` (the same `talos-app enroll` run, the
/// same four words, the same real-click rule); a test hands in a fake that refuses what the real one refuses.
@MainActor
protocol PhonePairing: AnyObject {
  /// What happened, as flow events (`pairLink`, `pairWords`, `pairConnected`, `pairFailed`).
  var onEvent: ((OnboardingFlow.Event) -> Void)? { get set }
  /// A fresh one-use code. Anything already running is ended first.
  func start()
  /// The owner's yes. false: it was refused (not a real click, no whole question on screen) and nothing was written.
  func approve(event: NSEvent?, button: NSButton) -> Bool
  /// The owner's no: the question is answered no, the code is cancelled, nothing is connected.
  func decline()
  func cancel()
}

/// What running the whole "Getting Talos ready" came to.
enum ProvisionOutcome: Equatable, Sendable {
  case ok
  /// Stopped at a step; `message` is the existing plain-words reason and `onTools` says it stopped at Apple's install window.
  case failed(message: String, onTools: Bool)
}

/// Drives the new first-run screens: it owns an `OnboardingFlow`, turns its effects into the app's existing machinery (the Talos
/// download and the agent's folder, Claude's sign-in, the phone pairing, starting the agent) and feeds what happens back in as
/// events. It re-implements none of them.
@MainActor
final class OnboardingCoordinator: ObservableObject {
  struct Deps {
    var home: String = NSHomeDirectory()
    var now: () -> Date = Date.init
    /// Fetches Talos, makes the agent's folder, adds the scheduler. Reports the bar (0...100) and Apple's-tools states as it goes.
    var provision: (_ progress: @escaping @Sendable (Int) -> Void, _ tools: @escaping @Sendable (ToolsSignal) -> Void) async -> ProvisionOutcome =
      { _, _ in .ok }
    /// Whether the internet answers (any reply at all from GitHub counts).
    var isOnline: () async -> Bool = { true }
    /// The scheduler could not be added: said plainly, never fatal.
    var schedulerNote: (String) -> Void = { _ in }
    /// Claude's state on this Mac after the download: signed in, or not (nil: could not tell), with what sign-in needs.
    var checkSignIn: () async -> SignInCheck = { SignInCheck(claude: nil, env: [:], signedIn: nil) }
    var signIn: ClaudeSignInCoordinator = .shared
    var openURL: (URL) -> Void = { NSWorkspace.shared.open($0) }
    /// "I don't see Apple's window": asks macOS for it again.
    var askAppleAgain: () -> Void = {}
    var pairing: any PhonePairing
    /// The agent starts; true when it was started. Setup's end.
    var startAgent: () -> Bool = { false }
    /// Whether a phone link can be made on this Mac now (the Mac already has somewhere to connect phones through).
    var hasRelay: () -> Bool = { false }
    /// Asks the bridge for the agent's first hello (kept pending until the bridge takes it): `true` when the phone was connected.
    var requestHello: (Bool) -> Void = { _ in }
    var showTalos: () -> Void = {}
    var closeWindow: () -> Void = {}
    /// How often the internet is looked for while offline, and how often Apple's install is looked at.
    var offlinePoll: TimeInterval = 4
    var toolsPoll: TimeInterval = 3
    /// Whether macOS is installing Apple's tools now (as opposed to still showing its question).
    var toolsInstalling: () -> Bool = { FileManager.default.fileExists(atPath: "/Library/Developer/CommandLineTools") }
  }

  enum ToolsSignal: Sendable { case asking, done }
  struct SignInCheck: Sendable {
    var claude: String?
    var env: [String: String]
    var signedIn: Bool?
  }

  @Published private(set) var flow = OnboardingFlow()
  @Published private(set) var extras = OnboardingExtras()
  /// Every effect the flow asked for, in order (tests read it; nothing else does).
  private(set) var performed: [OnboardingFlow.Effect] = []

  private var deps: Deps
  private var downloadTask: Task<Void, Never>?
  private var offlineTask: Task<Void, Never>?
  private var toolsTask: Task<Void, Never>?
  private var downloadStart = Date()
  private var signInToken: UUID?
  private var signInCheck = SignInCheck(claude: nil, env: [:], signedIn: nil)
  private var ended = false

  init(deps: Deps) {
    self.deps = deps
    self.deps.pairing.onEvent = { [weak self] e in self?.send(e) }
  }

  func setCloseWindow(_ f: @escaping () -> Void) { deps.closeWindow = f }

  // MARK: events in

  func send(_ e: OnboardingFlow.Event) {
    var next = flow
    let effects = next.apply(e)
    flow = next
    perform(effects)
  }

  var actions: OnboardingActions {
    OnboardingActions(
      getStarted: { [weak self] in self?.send(.getStarted) },
      tryAgain: { [weak self] in self?.send(.tryAgain) },
      continuePressed: { [weak self] in self?.send(.continuePressed) },
      signIn: { [weak self] in self?.send(.signInPressed) },
      openSignInPage: { [weak self] in self?.openSignInPage() },
      submitCode: { [weak self] c in self?.deps.signIn.submit(code: c) },
      back: { [weak self] in self?.send(.back) },
      choosePhone: { [weak self] in self?.choosePhone() },
      chooseThisMacOnly: { [weak self] in self?.chooseThisMacOnly() },
      wordsMatch: { [weak self] e, b in self?.wordsMatch(event: e, button: b) },
      wordsDontMatch: { [weak self] in self?.send(.wordsDontMatch) },
      retryPairing: { [weak self] in self?.retryPairing() },
      showAppleWindow: { [weak self] in self?.deps.askAppleAgain() })
  }

  /// "The words match": only a real click goes through. The pairing refuses an agent's synthetic click or key; then nothing changes.
  func wordsMatch(event: NSEvent?, button: NSButton) {
    guard case .confirm = flow.pair, flow.step == .pair else { return }
    guard deps.pairing.approve(event: event, button: button) else { return }
    send(.wordsMatch)
  }

  /// "Yes, on my phone too": with somewhere to connect phones, the code and the four words; on a fresh Mac straight on, and the agent
  /// leads the phone setup after its hello.
  func choosePhone() {
    send(.phoneLinkKnown(deps.hasRelay()))
    send(.choosePhone)
  }

  var isActive: Bool { flow.isActive }

  /// "Just this Mac for now", also from a pairing that failed: the code in flight is cancelled first.
  func chooseThisMacOnly() {
    if flow.step == .pair {
      deps.pairing.cancel()
      var next = flow
      next.apply(.back)
      flow = next
    }
    send(.chooseThisMacOnly)
  }

  func retryPairing() {
    var next = flow
    let effects = next.retryPairing()
    flow = next
    perform(effects)
  }

  // MARK: effects out

  private func perform(_ effects: [OnboardingFlow.Effect]) {
    for e in effects {
      performed.append(e)
      switch e {
      case .startDownload: runDownload()
      case .startSignIn: beginSignIn()
      case .cancelSignIn:
        deps.signIn.cancel()
        stopWatchingSignIn()
      case .startPairing: deps.pairing.start()
      case .cancelPairing: deps.pairing.cancel()
      case .confirmWords: break  // already written by `wordsMatch`, on the real click
      case .declineWords: deps.pairing.decline()
      case .finish: finish()
      }
    }
  }

  // MARK: 1 and 2: Getting Talos ready

  private func runDownload() {
    guard downloadTask == nil else { return }
    offlineTask?.cancel()
    offlineTask = nil
    downloadStart = deps.now()
    extras.downloadElapsed = 0
    OnboardingMarker.set(home: deps.home)  // the folder is about to be made: a quit from here on reopens this setup
    let progress: @Sendable (Int) -> Void = { pct in DispatchQueue.main.async { MainActor.assumeIsolated { self.send(.downloadProgress(pct: pct)) } } }
    let tools: @Sendable (ToolsSignal) -> Void = { s in DispatchQueue.main.async { MainActor.assumeIsolated { self.toolsSignal(s) } } }
    downloadTask = Task { [weak self] in
      guard let self else { return }
      let outcome = await self.deps.provision(progress, tools)
      self.downloadTask = nil
      self.toolsTask?.cancel()
      self.toolsTask = nil
      guard !self.ended else { return }
      switch outcome {
      case .ok:
        self.signInCheck = await self.deps.checkSignIn()
        guard !self.ended else { return }
        self.extras.downloadElapsed = self.deps.now().timeIntervalSince(self.downloadStart)
        self.send(.downloadDone(signedIn: self.signInCheck.signedIn))
      case .failed(let message, let onTools):
        if !onTools, await !self.deps.isOnline() {
          self.send(.downloadOffline)
          self.watchForInternet()
        } else {
          self.extras.failureDetail = message
          self.send(.downloadFailed(onTools ? OnboardingCopy.appleClosed : message))
        }
      }
    }
  }

  private func toolsSignal(_ s: ToolsSignal) {
    switch s {
    case .asking:
      send(.toolsAsked)
      toolsTask?.cancel()
      let poll = deps.toolsPoll
      toolsTask = Task { [weak self] in
        while !Task.isCancelled {
          try? await Task.sleep(nanoseconds: UInt64(poll * 1_000_000_000))
          guard let self, !Task.isCancelled else { return }
          if self.deps.toolsInstalling() { self.send(.toolsInstalling(pct: nil)) }
        }
      }
    case .done:
      toolsTask?.cancel()
      send(.toolsDone)
    }
  }

  /// While offline, the internet is looked for every few seconds; when it answers the download goes on by itself (what was already
  /// downloaded is kept). "Try again now" does the same at once.
  private func watchForInternet() {
    offlineTask?.cancel()
    let poll = deps.offlinePoll
    offlineTask = Task { [weak self] in
      while !Task.isCancelled {
        try? await Task.sleep(nanoseconds: UInt64(poll * 1_000_000_000))
        guard let self, !Task.isCancelled else { return }
        if await self.deps.isOnline() {
          if case .offline = self.flow.download { self.send(.tryAgain) }
          return
        }
      }
    }
  }

  /// Run by the clock a screen shows ("about 1 minute left"), once a second while the download goes.
  func tick() {
    if case .running = flow.download, flow.step == .ready { extras.downloadElapsed = deps.now().timeIntervalSince(downloadStart) }
  }

  // MARK: 3: Sign in to Claude

  private func beginSignIn() {
    watchSignIn()
    let c = signInCheck
    deps.signIn.reset()
    if !deps.signIn.start(claude: c.claude, env: c.env), !deps.signIn.isRunning {
      send(.signInEnded(success: false, message: OnboardingCopy.signInCouldNot))
    }
  }

  private func watchSignIn() {
    stopWatchingSignIn()
    let c = deps.signIn
    signInToken = c.observe { [weak self] in
      Task { @MainActor in self?.signInChanged() }
    }
  }

  private func stopWatchingSignIn() {
    if let t = signInToken { deps.signIn.unobserve(t) }
    signInToken = nil
    extras.signInLink = nil
    extras.signInWantsCode = false
  }

  private func signInChanged() {
    switch deps.signIn.state {
    case .idle: break
    case .waiting(let screen):
      extras.signInLink = screen.url
      extras.signInWantsCode = screen.wantsCode
    case .finished(let o):
      extras.signInLink = nil
      extras.signInWantsCode = false
      if o.isSuccess {
        stopWatchingSignIn()
        send(.signInEnded(success: true, message: nil))
      } else if o == .cancelled {
        // the owner went Back, or closed the window: the flow already left the waiting state
        if flow.signIn == .waiting { send(.signInEnded(success: false, message: nil)) }
      } else {
        send(.signInEnded(success: false, message: OnboardingCopy.signInMessage(for: o)))
      }
    }
  }

  private func openSignInPage() {
    // the link was read from Claude's own screen and already limited to Claude's hosts (`ClaudeLoginScreen.parse`)
    if let s = extras.signInLink, let u = URL(string: s) { deps.openURL(u) }
  }

  // MARK: 5: the end

  private func finish() {
    OnboardingMarker.clear(home: deps.home)
    ended = true
    _ = deps.startAgent()
    deps.requestHello(flow.phoneConnected)
    deps.showTalos()
    deps.closeWindow()
  }

  /// The window went away before the end: nothing it started keeps running. A sign-in the owner already began is left to finish
  /// (it is one app-wide run); the download is not interrupted either, so the next open finds the work done.
  func windowClosed() {
    offlineTask?.cancel()
    toolsTask?.cancel()
    if flow.step == .pair { deps.pairing.cancel() }
    if flow.step == .signIn, flow.signIn == .waiting { deps.signIn.cancel() }
    stopWatchingSignIn()
  }
}
