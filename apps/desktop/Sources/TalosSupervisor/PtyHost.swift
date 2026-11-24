import Foundation
import TalosDesktopCore

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
  /// The key guard sent nothing (`KeyGuard`: the pane shows something other than what the sender meant to press, or could not be read).
  /// Like `failed`, no key went; a caller that owes the owner a message says why. Hosts never return it: only `Supervisor.sendKey` does.
  case refused

  /// No key went (failed or refused). `unknown` is not here: it may have landed.
  public var notSent: Bool { self == .failed || self == .refused }
}

public enum HostKind: String, Sendable {
  case tmux
  case direct
}

public enum PtyHostError: Error, Equatable, CustomStringConvertible {
  case startFailed(String)
  /// The agent was gone before its pid could be read. `rows` is its dead pane's last screen: a `--resume` of a conversation
  /// that no longer exists prints its error line and exits at once, and that line is the only thing that says why.
  case exitedImmediately(rows: [String])
  case alreadyRunning
  /// tmux did not answer (a timeout, a refused socket) when the start looked at the agent's pane, within the bounded wait. The agent may be
  /// running: it is neither dead nor to be started again. Its pane is kept and a later tick adopts it (`adoptPending`).
  /// `launched`: the launch command ran or may have (a timeout, a refusal after it was sent): its launch file stays and the pane is looked for
  /// by session. Not launched: nothing was created, killed or respawned; the start is decided again on later ticks.
  case paneUnreadable(launched: Bool)
  public var description: String {
    switch self {
    case .startFailed(let s): return "start failed: \(s)"
    case .exitedImmediately: return "start failed: the agent exited immediately"
    case .alreadyRunning: return "a session is already running"
    case .paneUnreadable: return "The agent may be running, but Talos could not check it. Trying again."
    }
  }
}

/// What `attachState` found: the agent is running (attached), nothing is running (tmux said so), or tmux did not answer, which says nothing.
public enum AttachState: Equatable, Sendable {
  case running, notRunning, unknown
}

/// The result of `adoptPending` for a start whose pane could not be read: adopted (its pid is set), gone (tmux said so, or the pane is dead),
/// or still unknown (ask again on a later tick).
public enum AdoptOutcome: Equatable, Sendable {
  case adopted(pid: Int32), gone(rows: [String]), unknown
  /// The launch command never ran (a new-window that timed out, with every pane answering and none new, long after): launch again.
  case notLaunched
  /// The pane runs an agent that started BEFORE this launch: the launch did not take effect. Attach to it; never mark it as this launch's.
  case olderAgent(pid: Int32)
}

/// DESKTOP-SPEC 4.6. One host = one session (tmux session `agent`, or one owned pty). Option C makes one per thread.
/// Hosts never signal process groups themselves; the supervisor does that through `GroupSignaller`.
public protocol PtyHost: AnyObject, Sendable {
  var kind: HostKind { get }
  func start(executable: String, args: [String], env: [String: String], cwd: String) throws
  /// tmux: true if the session exists and its pane is alive (then `childPid` is set and exit watching runs).
  func attachIfRunning() -> Bool
  /// Like `attachIfRunning`, but a tmux that does not answer is `.unknown`, never "nothing running": nothing is started over it.
  func attachState() -> AttachState
  /// Kills the session like `close()`, and says whether tmux confirmed it (the session is gone or already was). False: tmux did not answer, the
  /// session may still run.
  func closeChecked() -> Bool
  /// Consecutive unanswered reads of the agent's pane (any look, the poll included); 0 after an answer. Hosts with no tmux say 0.
  var unansweredStreak: Int { get }
  /// The owner chose Start anyway while tmux does not answer: the next start goes ahead over an unknown session (once).
  func allowStartOverUnknown()
  /// After a start threw `paneUnreadable`: look at the pane again (one bounded read). Hosts with no such state say gone.
  func adoptPending() -> AdoptOutcome
  @discardableResult
  func send(keys: [UInt8]) -> SendOutcome
  /// One of the three keys a tap on a dialog may send (`DialogKey`), by name, so the pane gets the bytes its own cursor-key mode wants.
  @discardableResult
  func sendDialogKey(_ key: DialogKey) -> SendOutcome
  /// The number key of a numbered Select row (a tool permission or the agent's question: `PaneSelect`), and the owner's typed words for a question's
  /// free-text row. Only the gate sends them (`Supervisor.sendKey` and `WorkerManager.sendKey`, with `.pane`). A host that cannot says `.failed`.
  @discardableResult
  func sendSelectNumber(_ n: SelectNumber) -> SendOutcome
  @discardableResult
  func sendAnswerText(_ t: AnswerText) -> SendOutcome
  /// Escape, for the computer-use permission dialog only (`ComputerUseDismiss`).
  @discardableResult
  func sendEscape() -> SendOutcome
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
  /// When an attached client last typed (seconds since 1970); nil when none is attached or it can't be read. Only tmux has clients.
  func clientActivity() -> Double?
  /// When each attached client last typed (seconds since 1970, whole seconds). Empty when none is attached; nil when the clients could
  /// not be read, which is not "nobody is typing". Only tmux has clients: the app-owned pty has none, so the default says "none" and
  /// the owner typing into the embedded terminal is never seen by the dev-channels typing guard.
  func clientActivities() -> [Double]?
  /// The pane pid / owned child pid = its process group id.
  var childPid: Int32? { get }
  var onExit: (@Sendable (ExitInfo) -> Void)? { get set }
  /// Small values that must survive an app restart (tmux session user options; memory for the owned pty).
  func setMarker(_ key: String, _ value: String)
  func marker(_ key: String) -> String?
}

extension PtyHost {
  public func attachState() -> AttachState { attachIfRunning() ? .running : .notRunning }
  public func closeChecked() -> Bool {
    close()
    return true
  }
  public var unansweredStreak: Int { 0 }
  public func allowStartOverUnknown() {}
  public func adoptPending() -> AdoptOutcome { .gone(rows: []) }
  /// An app-owned pty has no key names: Claude's Select runs with application cursor keys (`ESC O A`, `ESC O B`), Enter is a return.
  public func sendDialogKey(_ key: DialogKey) -> SendOutcome {
    switch key {
    case .up: return send(keys: [0x1b, 0x4f, 0x41])
    case .down: return send(keys: [0x1b, 0x4f, 0x42])
    case .enter: return send(keys: [0x0d])
    }
  }
  /// An app-owned pty: the digit itself, and the typed words as UTF-8 bytes.
  public func sendSelectNumber(_ n: SelectNumber) -> SendOutcome { send(keys: [UInt8(0x30 + n.value)]) }
  public func sendAnswerText(_ t: AnswerText) -> SendOutcome { send(keys: Array(t.text.utf8)) }
  /// An app-owned pty: the one byte. Claude reads a lone ESC as the Escape key once nothing follows it.
  public func sendEscape() -> SendOutcome { send(keys: [0x1b]) }
  public func clientActivity() -> Double? { nil }
  public func clientActivities() -> [Double]? { [] }
}
