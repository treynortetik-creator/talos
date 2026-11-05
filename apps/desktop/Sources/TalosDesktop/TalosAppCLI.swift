import Foundation
import TalosDesktopCore
import TalosSupervisor

/// Runs the owner's own `talos-app` CLI (the bridge's command line) as our child: `devices`, `devices revoke <id>`.
/// Argument vectors only, never a shell. The same command the crash-loop post uses (`talos_app_command` in desktop.json,
/// else `talos-app` on the login PATH).
enum TalosAppCLI {
  struct Resolved {
    var command: [String]
    var env: [String: String]
  }

  /// Blocks (up to 5 s for the login shell); call off the main thread.
  static func resolve(config: DesktopConfig) -> Resolved? {
    let probe = LiveSystem()
    let env = LoginShellEnv.build(shellEnv: probe.loginShellEnv() ?? ProcessInfo.processInfo.environment, overrides: config.env)
    let home = NSHomeDirectory()
    if !config.talosAppCommand.isEmpty {
      // The typed command must be runnable as written; nil means "not found", never a green row that fails at exec.
      guard
        let cmd = TalosAppLocator.runnable(
          config.talosAppCommand, searchPath: env["PATH"], home: home, isExecutable: FileManager.default.isExecutableFile)
      else { return nil }
      return Resolved(command: cmd, env: env)
    }
    if let t = LoginShellEnv.which("talos-app", path: env["PATH"], isExecutable: FileManager.default.isExecutableFile) {
      return Resolved(command: [t], env: env)
    }
    // Not on the PATH (on a fresh checkout it is a shell alias): ask the agent folder's .mcp.json (audit D7).
    let mcp = FileManager.default.contents(atPath: config.expandedAgentDir(home: home) + "/.mcp.json")
    guard
      let f = TalosAppLocator.fromMcpJson(
        mcp, searchPath: env["PATH"], home: home, isExecutable: FileManager.default.isExecutableFile,
        fileExists: { FileManager.default.fileExists(atPath: $0) })
    else { return nil }
    return Resolved(command: f.command, env: f.env.merging(env) { _, mine in mine })
  }

  struct Output {
    var status: Int32
    var text: String
  }

  /// The owner-only commands (`devices`, `devices revoke`) refuse unless stdin and stdout are a terminal, so the child gets a
  /// pty, the way Pairing.swift gives `enroll` one. Output comes back through the pty's master side (lines end in \r\n).
  static func run(_ r: Resolved, _ args: [String], timeout: Double = 30) -> Output? {
    var master: Int32 = -1
    var slave: Int32 = -1
    guard openpty(&master, &slave, nil, nil, nil) == 0 else { return nil }
    let tty = FileHandle(fileDescriptor: slave, closeOnDealloc: false)
    let p = Process()
    p.executableURL = URL(fileURLWithPath: r.command[0])
    p.arguments = Array(r.command.dropFirst()) + args
    p.environment = r.env
    p.standardInput = tty
    p.standardOutput = tty
    p.standardError = tty
    do { try p.run() } catch {
      close(slave)
      close(master)
      return nil
    }
    let fd = master  // a constant the reader closure can capture
    close(slave)  // our copy; the child holds its own, so the master reads EOF (or EIO) when the child is gone
    final class Box: @unchecked Sendable { var data = Data() }
    let box = Box()
    let reader = DispatchQueue(label: "talos.cli.read")
    let done = DispatchSemaphore(value: 0)
    // The reader owns the master fd and closes it when it stops. Closing it from this thread while the reader may still be
    // inside read() would race (the number can be reused), so this thread never does.
    reader.async {
      var buf = [UInt8](repeating: 0, count: 4096)
      while true {
        let n = read(fd, &buf, buf.count)
        if n < 0 && errno == EINTR { continue }  // a signal landed mid-read; not the end of the output
        if n <= 0 { break }
        box.data.append(contentsOf: buf[0..<n])
      }
      close(fd)
      done.signal()
    }
    if done.wait(timeout: .now() + timeout) == .timedOut {
      p.terminate()  // our own child, by its Process handle; its pty closing ends the reader
      if done.wait(timeout: .now() + 2) == .timedOut {
        kill(p.processIdentifier, SIGKILL)  // still holding the pty: our own child, by its pid
        _ = done.wait(timeout: .now() + 2)
      }
      return nil
    }
    p.waitUntilExit()
    let text = String(decoding: box.data, as: UTF8.self).replacingOccurrences(of: "\r\n", with: "\n")
    return Output(status: p.terminationStatus, text: text)
  }
}
