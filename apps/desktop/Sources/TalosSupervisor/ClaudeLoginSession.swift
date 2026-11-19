import Foundation
import TalosDesktopCore

/// `claude auth login` in a pty of its own (the CLI may open the browser, print a link, or wait for a pasted code, so it needs a
/// real terminal), owned by the app. `claude` is an absolute path. The screen is read as text for `ClaudeLoginScreen` and is never
/// logged; what `submit(code:)` types (the code, then Return as a write of its own) is never kept. `stop()` ends the child and its whole process group: SIGTERM, up to 2 seconds,
/// then SIGKILL (what `ProcessRunner` does for one child).
public final class ClaudeLoginSession: @unchecked Sendable {
  private let claude: String
  private let env: [String: String]
  private let host: SwiftTermPtyHost
  private let signaller: GroupSignaller
  private let lock = NSLock()
  private var started = false
  private var stopped = false

  public init(claude: String, env: [String: String], cols: Int = 600) {
    self.claude = claude
    self.env = env
    host = SwiftTermPtyHost(cols: cols, rows: 40)
    signaller = GroupSignaller(probe: LiveSystem())
    host.signaller = signaller
  }

  deinit { stop() }

  public func start() throws {
    guard claude.hasPrefix("/") else { throw PtyHostError.startFailed("not an absolute path") }
    // A quit that came first wins: nothing is launched after stop().
    guard !lock.withLock({ stopped }) else { throw PtyHostError.startFailed("stopped") }
    var e = env
    if e["TERM"] == nil { e["TERM"] = "xterm-256color" }
    try host.start(executable: claude, args: ["auth", "login"], env: e, cwd: NSHomeDirectory())
    if let pid = host.childPid { signaller.own(pid, leaderStart: ProcessInspect.snapshot(pid)?.startTime ?? 0) }
    let late: Bool = lock.withLock {
      started = true
      return stopped
    }
    if late { host.terminate(graceSeconds: 2) }  // stop() landed while the child was starting
  }

  public func screen() -> ClaudeLoginScreen { ClaudeLoginScreen.parse(rows: host.visibleRows() ?? []) }

  /// How long after the code its Return goes, as a write of its own. Claude Code takes a burst of more than about 64 characters
  /// as a paste and drops an Enter inside it, and a real code is longer than that: in one write it is never submitted (OBSERVED on
  /// Titan, 2.1.322: 89 characters, no answer in 45 s; the code, then a lone Return, answered in 2 to 6 s).
  public static let returnDelay: TimeInterval = 0.5

  /// Types the code into the pty, then Return on its own `returnDelay` later. Returns at once (the Return is not waited for):
  /// whether the code was written. The Return is not sent once the session is stopped or the child has ended.
  @discardableResult
  public func submit(code: String) -> Bool {
    let clean = code.trimmingCharacters(in: .whitespacesAndNewlines)
    guard !clean.isEmpty, isRunning else { return false }
    guard host.send(keys: Array(clean.utf8)) == .sent else { return false }
    DispatchQueue.global(qos: .userInitiated).asyncAfter(deadline: .now() + Self.returnDelay) { [weak self] in
      guard let self, !self.lock.withLock({ self.stopped }), self.isRunning else { return }
      _ = self.host.send(keys: [0x0d])
    }
    return true
  }

  /// Ends the child and its group. Safe to call twice, from any thread; returns when the group is gone (at most about 2 seconds).
  public func stop() {
    let go: Bool = lock.withLock {
      defer { stopped = true }
      return started && !stopped
    }
    guard go else { return }
    host.terminate(graceSeconds: 2)
  }

  public var pid: Int32? { host.childPid }
  public var isRunning: Bool { host.attachIfRunning() }
}
