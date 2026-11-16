import Foundation
import TalosDesktopCore

/// Signs the Claude Code CLI in (not Talos): `claude auth login` in a pty (`ClaudeLoginSession`), then `claude auth status --json`
/// until it says signed in. `claude` is always an absolute path the caller resolved through the login environment. Nothing the CLI
/// prints is kept or logged: the screen goes to `onScreen` as a `ClaudeLoginScreen` (link and "wants a code"), status is a yes or a no.
public enum ClaudeSignIn {
  /// `claude auth status --json`: `loggedIn` decides when the JSON has it, else the exit code; a timeout or a failure to run is unknown.
  public static func check(claude: String, env: [String: String], timeout: Double = ClaudeSignInPlan.statusTimeout) -> ClaudeSignInPlan.Check {
    guard claude.hasPrefix("/") else { return .unknown }
    let r = ProcessRunner.run([claude, "auth", "status", "--json"], env: env, timeout: timeout)
    return ClaudeSignInPlan.check(status: r.status == 127 ? nil : r.status, timedOut: r.timedOut, json: r.stdout)
  }

  /// The same, but a cancel of the calling task returns `.unknown` at once instead of waiting out a running check.
  static func checkCancellable(claude: String, env: [String: String], timeout: Double) async -> ClaudeSignInPlan.Check {
    final class Gate: @unchecked Sendable {
      let lock = NSLock()
      var cont: CheckedContinuation<ClaudeSignInPlan.Check, Never>?
      var done = false
      func finish(_ v: ClaudeSignInPlan.Check) {
        let c: CheckedContinuation<ClaudeSignInPlan.Check, Never>? = lock.withLock {
          if done { return nil }
          done = true
          defer { cont = nil }
          return cont
        }
        c?.resume(returning: v)
      }
    }
    let gate = Gate()
    return await withTaskCancellationHandler {
      await withCheckedContinuation { (c: CheckedContinuation<ClaudeSignInPlan.Check, Never>) in
        let early: Bool = gate.lock.withLock {
          if gate.done { return true }
          gate.cont = c
          return false
        }
        if early { c.resume(returning: .unknown); return }
        Thread.detachNewThread { gate.finish(check(claude: claude, env: env, timeout: timeout)) }
      }
    } onCancel: {
      gate.finish(.unknown)
    }
  }

  /// Already signed in: done. Otherwise start `claude auth login` in a pty and poll status every `interval` seconds, for at most
  /// `limit` seconds, handing the screen to `onScreen` about four times a second. Cancelling the calling task, the time limit and
  /// every other way out end the login and its process group.
  public static func run(
    claude: String?, env: [String: String], interval: Double = ClaudeSignInPlan.defaultInterval,
    limit: Double = ClaudeSignInPlan.defaultLimit, statusTimeout: Double = ClaudeSignInPlan.statusTimeout,
    session: ClaudeLoginSession? = nil, onScreen: (@Sendable (ClaudeLoginScreen) -> Void)? = nil
  ) async -> ClaudeSignInPlan.Outcome {
    guard let claude, claude.hasPrefix("/"), FileManager.default.isExecutableFile(atPath: claude) else { return .noClaude }
    let first = await checkCancellable(claude: claude, env: env, timeout: statusTimeout)
    if first == .signedIn { return .alreadySignedIn }
    if Task.isCancelled { return .cancelled }

    let login = session ?? ClaudeLoginSession(claude: claude, env: env)
    do { try login.start() } catch { return .couldNotRun }
    defer { login.stop() }

    let deadline = Date().addingTimeInterval(limit)
    var answered = first != .unknown
    var nextCheck = Date().addingTimeInterval(interval)
    var checkedAfterEnd = false
    let slice = min(0.25, interval)
    while true {
      if Task.isCancelled { return .cancelled }
      // A login that ended shows no link or code box: nothing would read the code.
      onScreen?(login.isRunning ? login.screen() : ClaudeLoginScreen())
      if Date() >= deadline { return ClaudeSignInPlan.timeoutOutcome(everAnswered: answered) }
      try? await Task.sleep(nanoseconds: UInt64(min(slice, max(0, deadline.timeIntervalSinceNow)) * 1_000_000_000))
      if Task.isCancelled { return .cancelled }
      let ended = !login.isRunning
      guard (ended && !checkedAfterEnd) || Date() >= nextCheck else { continue }
      if ended { checkedAfterEnd = true }
      nextCheck = Date().addingTimeInterval(interval)
      let c = await checkCancellable(claude: claude, env: env, timeout: statusTimeout)
      if Task.isCancelled { return .cancelled }
      if c != .unknown { answered = true }
      if c == .signedIn { return .signedIn }
      // The login ended (the owner closed the page, a wrong code, or it failed) and status still says no: say so now. A status that
      // did not answer is not a no: keep asking until the time is up.
      if ended && c == .notSignedIn { return .loginEndedNotSignedIn }
    }
  }
}

/// One sign-in for the whole app, outliving the setup window: reopening the window finds the same run and never starts a second
/// login. `stopNow()` (quit, deinit) ends the login's process group before returning.
public final class ClaudeSignInCoordinator: @unchecked Sendable {
  public static let shared = ClaudeSignInCoordinator()

  public enum State: Equatable, Sendable {
    case idle
    case waiting(ClaudeLoginScreen)
    case finished(ClaudeSignInPlan.Outcome)
  }

  private let lock = NSLock()
  private var _state: State = .idle
  private var task: Task<Void, Never>?
  private var session: ClaudeLoginSession?
  private var _onChange: (@Sendable () -> Void)?

  public init() {}
  deinit { stopNow() }

  public var state: State { lock.withLock { _state } }
  public var isRunning: Bool { lock.withLock { task != nil } }
  /// The latest window's refresh; a new window replaces it.
  public var onChange: (@Sendable () -> Void)? {
    get { lock.withLock { _onChange } }
    set { lock.withLock { _onChange = newValue } }
  }

  private func set(_ s: State) {
    let cb: (@Sendable () -> Void)? = lock.withLock {
      guard _state != s else { return nil }
      _state = s
      return _onChange
    }
    cb?()
  }

  /// false when a sign-in is already running (nothing new is started).
  @discardableResult
  public func start(
    claude: String?, env: [String: String], interval: Double = ClaudeSignInPlan.defaultInterval,
    limit: Double = ClaudeSignInPlan.defaultLimit, statusTimeout: Double = ClaudeSignInPlan.statusTimeout
  ) -> Bool {
    let ok: Bool = lock.withLock {
      guard task == nil else { return false }
      if let claude, claude.hasPrefix("/") { session = ClaudeLoginSession(claude: claude, env: env) }
      let s = session
      task = Task { [weak self] in
        let outcome = await ClaudeSignIn.run(
          claude: claude, env: env, interval: interval, limit: limit, statusTimeout: statusTimeout, session: s,
          onScreen: { [weak self] screen in self?.set(.waiting(screen)) })
        self?.finish(outcome)
      }
      return true
    }
    if ok { set(.waiting(ClaudeLoginScreen())) }
    return ok
  }

  private func finish(_ o: ClaudeSignInPlan.Outcome) {
    lock.withLock {
      task = nil
      session = nil
    }
    set(.finished(o))
  }

  /// The code the owner typed goes into the login's pty; it is not kept.
  @discardableResult
  public func submit(code: String) -> Bool { (lock.withLock { session })?.submit(code: code) ?? false }

  public func cancel() { lock.withLock { task }?.cancel() }

  /// Quit: cancel and end the login's process group now, before returning.
  public func stopNow() {
    let (t, s): (Task<Void, Never>?, ClaudeLoginSession?) = lock.withLock { (task, session) }
    t?.cancel()
    s?.stop()
  }

  public func reset() { if !isRunning { set(.idle) } }
}
