import Foundation

/// Runs one short-lived command with an argv (never a shell string), stdin from /dev/null, and a timeout. On timeout it
/// terminates only the child it started. Used for tmux commands, `claude --version`, `claude agents --json`, the login
/// shell's `env` and `talos-app post`.
public struct RunResult: Equatable, Sendable {
  public var status: Int32
  public var stdout: Data
  public var stderr: Data
  public var timedOut: Bool

  public var ok: Bool { status == 0 && !timedOut }
  public var out: String { String(decoding: stdout, as: UTF8.self) }
  public var err: String { String(decoding: stderr, as: UTF8.self) }
}

public enum ProcessRunner {
  public static func run(
    _ argv: [String], env: [String: String]? = nil, cwd: String? = nil, timeout: Double = 10
  ) -> RunResult {
    guard let exe = argv.first else { return RunResult(status: 127, stdout: Data(), stderr: Data(), timedOut: false) }
    let p = Process()
    p.executableURL = URL(fileURLWithPath: exe)
    p.arguments = Array(argv.dropFirst())
    if let env { p.environment = env }
    if let cwd { p.currentDirectoryURL = URL(fileURLWithPath: cwd) }
    p.standardInput = FileHandle.nullDevice
    let outPipe = Pipe()
    let errPipe = Pipe()
    p.standardOutput = outPipe
    p.standardError = errPipe

    let done = DispatchSemaphore(value: 0)
    p.terminationHandler = { _ in done.signal() }
    do {
      try p.run()
    } catch {
      return RunResult(status: 127, stdout: Data(), stderr: Data("\(error)".utf8), timedOut: false)
    }

    let box = OutputBox()
    let readers = DispatchGroup()
    for (pipe, isOut) in [(outPipe, true), (errPipe, false)] {
      readers.enter()
      DispatchQueue.global(qos: .userInitiated).async {
        let data = pipe.fileHandleForReading.readDataToEndOfFile()
        box.set(data, isOut: isOut)
        readers.leave()
      }
    }

    var timedOut = false
    if done.wait(timeout: .now() + timeout) == .timedOut {
      timedOut = true
      p.terminate()  // SIGTERM to our own child only
      if done.wait(timeout: .now() + 2) == .timedOut {
        kill(p.processIdentifier, SIGKILL)
        _ = done.wait(timeout: .now() + 2)
      }
    }
    // A grandchild may keep a pipe open after the child exits; don't wait on it forever.
    if readers.wait(timeout: .now() + 2) == .timedOut {
      try? outPipe.fileHandleForReading.close()
      try? errPipe.fileHandleForReading.close()
    }
    let status = p.isRunning ? -1 : p.terminationStatus
    let (o, e) = box.get()
    return RunResult(status: status, stdout: o, stderr: e, timedOut: timedOut)
  }
}

final class OutputBox: @unchecked Sendable {
  private let lock = NSLock()
  private var out = Data()
  private var err = Data()
  func set(_ d: Data, isOut: Bool) {
    lock.lock()
    defer { lock.unlock() }
    if isOut { out = d } else { err = d }
  }
  func get() -> (Data, Data) {
    lock.lock()
    defer { lock.unlock() }
    return (out, err)
  }
}
