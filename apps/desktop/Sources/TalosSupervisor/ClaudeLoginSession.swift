import Foundation
import TalosDesktopCore

/// `claude auth login` in a pty of its own (the CLI may open the browser, print a link, or wait for a pasted code, so it needs a
/// real terminal), owned by the app. `claude` is an absolute path. The screen is read as text for `ClaudeLoginScreen` and is never
/// logged; what `submit(code:)` types is never kept. `stop()` ends the child and its whole process group: SIGTERM, up to 2 seconds,
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

  /// Types the code and Return into the pty.
  @discardableResult
  public func submit(code: String) -> Bool {
    let clean = code.trimmingCharacters(in: .whitespacesAndNewlines)
    guard !clean.isEmpty, isRunning else { return false }
    return host.send(keys: Array(clean.utf8) + [0x0d]) == .sent
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
