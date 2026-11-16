import Foundation
import TalosDesktopCore

/// Finds claude, bun, tmux and Homebrew by ABSOLUTE path (the login environment's PATH, then the usual install folders) and reads
/// their versions. Never a bare name: a process Talos starts does no PATH search of its own. Blocks; call off the main thread.
public enum PrereqProbe {
  public struct Tool: Equatable, Sendable {
    public var path: String
    public var version: String?
    public init(path: String, version: String?) {
      self.path = path
      self.version = version
    }
  }

  public struct Found: Equatable, Sendable {
    public var claude: Tool?
    public var bun: Tool?
    public var tmux: Tool?
    public var brew: String?
  }

  /// `claudeName` is `desktop.json` `claude_path` ("claude" for auto).
  public static func probe(
    env: [String: String], claudeName: String = "claude", home: String,
    isExecutable: (String) -> Bool = FileManager.default.isExecutableFile, versionTimeout: Double = 10
  ) -> Found {
    func find(_ name: String, extra: [String]) -> String? {
      if let p = TalosAppLocator.findProgram(name, searchPath: env["PATH"], home: home, isExecutable: isExecutable) { return p }
      return extra.map { "\($0)/\(name)" }.first(where: isExecutable)
    }
    func tool(_ id: String, _ path: String?, _ args: [String]) -> Tool? {
      guard let path else { return nil }
      let r = ProcessRunner.run([path] + args, env: env, timeout: versionTimeout)
      return Tool(path: path, version: r.ok ? PrereqPlan.version(id, output: r.out) : nil)
    }
    let local = ["\(home)/.local/bin"]
    return Found(
      claude: tool("claude", find(claudeName, extra: local), ["--version"]),
      bun: tool("bun", find("bun", extra: ["\(home)/.bun/bin"]), ["--version"]),
      tmux: tool("tmux", find("tmux", extra: TalosAppLocator.tmuxFolders(home: home)), ["-V"]),
      brew: ["/opt/homebrew/bin/brew", "/usr/local/bin/brew"].first(where: isExecutable)
        ?? TalosAppLocator.findProgram("brew", searchPath: env["PATH"], home: home, isExecutable: isExecutable))
  }

  /// The fix the owner pressed. A page opens in the app (the caller); a command runs here, as the owner, never as root.
  public static func runFix(_ fix: PrereqPlan.Fix, env: [String: String], uid: UInt32 = getuid(), timeout: Double = 900) -> String? {
    switch PrereqPlan.argv(for: fix, uid: uid) {
    case .refused(let why): return why
    case .argv(let a):
      let r = ProcessRunner.run(a, env: env, timeout: timeout)
      return r.ok ? nil : OnboardingText.brewFailed
    }
  }
}
