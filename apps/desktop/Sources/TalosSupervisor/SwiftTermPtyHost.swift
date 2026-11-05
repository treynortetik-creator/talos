import Foundation
import SwiftTerm

/// Fallback host (DESKTOP-SPEC D15, 4.6): the app owns the pty through SwiftTerm's `LocalProcess` (forkpty, so the child
/// is its own session leader and process group). A headless `Terminal` keeps the screen for `visibleRows()`. The agent
/// dies with the app; the menu says so ("Quit Talos (stops the agent)").
public final class SwiftTermPtyHost: PtyHost, LocalProcessDelegate, TerminalDelegate, @unchecked Sendable {
  public let kind = HostKind.direct
  let cols: Int
  let rows: Int
  let q: DispatchQueue
  private let lock = NSLock()
  private var process: LocalProcess?
  private var terminal: Terminal?
  private var _childPid: Int32?
  private var _lastOutput: Date?
  private var _onExit: (@Sendable (ExitInfo) -> Void)?
  private var markers: [String: String] = [:]
  /// Our own descriptor on the pty, for `send(keys:)`. Held under `lock`, so it can't be closed, or its number reused, in the
  /// middle of a write: `LocalProcess.childfd` can be.
  private var keysFd: Int32 = -1
  public var signaller: GroupSignaller?

  public init(cols: Int = 120, rows: Int = 40) {
    self.cols = cols
    self.rows = rows
    self.q = DispatchQueue(label: "talos.pty.\(UUID().uuidString.prefix(8))")
  }

  deinit { closeKeysFd() }

  private func closeKeysFd() {
    if keysFd >= 0 { Darwin.close(keysFd) }
    keysFd = -1
  }

  public var childPid: Int32? { lock.withLock { _childPid } }

  public var onExit: (@Sendable (ExitInfo) -> Void)? {
    get { lock.withLock { _onExit } }
    set { lock.withLock { _onExit = newValue } }
  }

  public func start(executable: String, args: [String], env: [String: String], cwd: String) throws {
    if let p = lock.withLock({ process }), p.running { throw PtyHostError.alreadyRunning }
    var opts = TerminalOptions.default
    opts.cols = cols
    opts.rows = rows
    opts.scrollback = 2000
    let term = Terminal(delegate: self, options: opts)
    let proc = LocalProcess(delegate: self, dispatchQueue: q)
    lock.withLock {
      terminal = term
      process = proc
      _lastOutput = nil
    }
    let envList = env.keys.sorted().map { "\($0)=\(env[$0] ?? "")" }
    switch proc.startProcessChecked(
      executable: executable, args: args, environment: envList, execName: nil, currentDirectory: cwd)
    {
    case .success:
      lock.withLock {
        _childPid = proc.shellPid
        closeKeysFd()
        keysFd = fcntl(proc.childfd, F_DUPFD_CLOEXEC, 0)
      }
    case .failure(let e):
      throw PtyHostError.startFailed("\(e)")
    }
  }

  public func restart(executable: String, args: [String], env: [String: String], cwd: String) throws {
    try start(executable: executable, args: args, env: env, cwd: cwd)
  }

  public func attachIfRunning() -> Bool { lock.withLock { process?.running ?? false } }

  @discardableResult
  public func send(keys: [UInt8]) -> SendOutcome {
    // Straight to the pty, not `LocalProcess.send`, whose DispatchIO write runs at default QoS. The kernel stops serving
    // that once every cooperative thread is blocked, which parallel tests in `usleep` do (OBSERVED: an Enter queued for 12 s,
    // then cancelled unsent). The app never blocks that pool, but a dialog's Enter has no reason to depend on it. The pty is
    // O_NONBLOCK (SwiftTerm's reader sets it on the shared file description), so this can't hold `lock`: past about 1 KB
    // unread the rest is dropped.
    lock.withLock {
      guard keysFd >= 0 else { return .failed }
      return keys.withUnsafeBytes { raw -> SendOutcome in
        var done = 0
        while done < raw.count {
          let n = write(keysFd, raw.baseAddress! + done, raw.count - done)
          if n > 0 {
            done += n
          } else if errno != EINTR {
            return .failed
          }
        }
        return .sent
      }
    }
  }

  public func visibleRows() -> [String]? {
    guard let t = lock.withLock({ terminal }) else { return nil }
    var out: [String] = t.terminalLock.withLock {
      (0..<t.rows).map { t.getLine(row: $0)?.translateToString(trimRight: true) ?? "" }
    }
    while let last = out.last, last.trimmingCharacters(in: .whitespaces).isEmpty { out.removeLast() }
    return out
  }

  public func lastOutputAt() -> Date? { lock.withLock { _lastOutput } }

  public func terminate(graceSeconds: Double) {
    guard let pid = childPid else { return }
    if let sig = signaller {
      sig.signal(pid, SIGTERM)
      let until = Date().addingTimeInterval(graceSeconds)
      while sig.alive(pid), Date() < until { usleep(100_000) }
      if sig.alive(pid) { sig.signal(pid, SIGKILL) }
    } else {
      lock.withLock { process }?.terminate()
    }
  }

  public func close() {}

  /// The owned child can't outlive the app; detaching stops it (SIGTERM via LocalProcess, our own child).
  public func detach() { lock.withLock { process }?.terminate() }

  public func setMarker(_ key: String, _ value: String) { lock.withLock { markers[key] = value } }
  public func marker(_ key: String) -> String? { lock.withLock { markers[key] } }

  // MARK: LocalProcessDelegate

  public func processTerminated(_ source: LocalProcess, exitCode: Int32?) {
    let rows = visibleRows() ?? []
    let (pid, cb): (Int32?, (@Sendable (ExitInfo) -> Void)?) = lock.withLock {
      guard source === process else { return (nil, nil) }
      closeKeysFd()
      return (_childPid, _onExit)
    }
    guard let pid else { return }
    // LocalProcess reports nil for a signal death (it doesn't say which signal).
    cb?(ExitInfo(pid: pid, code: exitCode, signal: exitCode == nil ? 0 : nil, lastRows: rows))
  }

  public func processFailedToStart(_ source: LocalProcess, error: LocalProcessError) {}

  public func dataReceived(slice: ArraySlice<UInt8>) {
    guard let t = lock.withLock({ terminal }) else { return }
    t.terminalLock.withLock { t.feed(buffer: slice) }
    lock.withLock { _lastOutput = Date() }
  }

  public func getWindowSize() -> winsize {
    winsize(ws_row: UInt16(rows), ws_col: UInt16(cols), ws_xpixel: 0, ws_ypixel: 0)
  }

  // MARK: TerminalDelegate

  public func send(source: Terminal, data: ArraySlice<UInt8>) {
    // Replies the terminal itself generates (cursor position reports and the like) go back to the child.
    lock.withLock { process }?.send(data: data)
  }
}
