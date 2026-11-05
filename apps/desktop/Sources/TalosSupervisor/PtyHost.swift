import Foundation

/// How the agent's process ended.
public struct ExitInfo: Equatable, Sendable {
  public var pid: Int32
  public var code: Int32?
  public var signal: Int32?
  /// The tmux server or session vanished under us (killed externally). The next start is cold.
  public var hostLost: Bool
  /// The last screen, read right after the exit (for the resume-missing check and the audit).
  public var lastRows: [String]

  public init(pid: Int32, code: Int32?, signal: Int32?, hostLost: Bool = false, lastRows: [String] = []) {
    self.pid = pid
    self.code = code
    self.signal = signal
    self.hostLost = hostLost
    self.lastRows = lastRows
  }
}

/// What `send(keys:)` can say about the bytes it was given.
public enum SendOutcome: Equatable, Sendable {
  /// The host accepted them (tmux exited 0 / the pty write finished).
  case sent
  /// Definitely not delivered (no pane, tmux exited non-zero, the pty write failed). Safe to send again.
  case failed
  /// The call timed out: the bytes may or may not have landed. A caller that must never send twice treats it as sent.
  case unknown
}

public enum HostKind: String, Sendable {
  case tmux
  case direct
}

public enum PtyHostError: Error, Equatable, CustomStringConvertible {
  case startFailed(String)
  case alreadyRunning
  public var description: String {
    switch self {
    case .startFailed(let s): return "start failed: \(s)"
    case .alreadyRunning: return "a session is already running"
    }
  }
}

/// DESKTOP-SPEC 4.6. One host = one session (tmux session `agent`, or one owned pty). Option C makes one per thread.
/// Hosts never signal process groups themselves; the supervisor does that through `GroupSignaller`.
public protocol PtyHost: AnyObject, Sendable {
  var kind: HostKind { get }
  func start(executable: String, args: [String], env: [String: String], cwd: String) throws
  /// tmux: true if the session exists and its pane is alive (then `childPid` is set and exit watching runs).
  func attachIfRunning() -> Bool
  @discardableResult
  func send(keys: [UInt8]) -> SendOutcome
  /// Bottom-anchored screen text. nil when the screen could not be read (a failed or timed-out capture): that says nothing
  /// about what is on it, and a caller must not take it for an empty screen.
  func visibleRows() -> [String]?
  func lastOutputAt() -> Date?
  func restart(executable: String, args: [String], env: [String: String], cwd: String) throws
  /// Blocking stop: SIGTERM the child's group, SIGKILL after `graceSeconds`, then host clean-up. The supervisor uses
  /// its own non-blocking path; this exists for callers outside a supervision loop.
  func terminate(graceSeconds: Double)
  /// Host clean-up once the group is gone (tmux: kill-session). Never signals.
  func close()
  /// Stop watching. tmux: the agent keeps running. Owned pty: the agent dies with the app.
  func detach()
  /// The pane pid / owned child pid = its process group id.
  var childPid: Int32? { get }
  var onExit: (@Sendable (ExitInfo) -> Void)? { get set }
  /// Small values that must survive an app restart (tmux session user options; memory for the owned pty).
  func setMarker(_ key: String, _ value: String)
  func marker(_ key: String) -> String?
}
