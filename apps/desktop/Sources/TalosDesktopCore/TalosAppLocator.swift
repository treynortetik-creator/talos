import Foundation

/// Finds the `talos-app` command line when it is not an executable on the login PATH (audit D7). On a fresh checkout
/// `talos-app` is a shell alias (`docs/SETUP.md`), which `which` can never see. What always exists is the agent folder's
/// `.mcp.json`: its `talos-app` entry names `bun run --cwd <bridge folder> --silent start`, and `<bridge folder>/src/cli.ts`
/// is the same CLI the alias runs. Pure: the file system is passed in.
public enum TalosAppLocator {
  public struct Found: Equatable, Sendable {
    public var command: [String]
    /// The entry's own `env` (TALOS_APP_HOME). The owner's desktop.json `env` still wins.
    public var env: [String: String]
  }

  /// `data` is the agent folder's `.mcp.json`. nil when there is no usable `talos-app` entry, no `--cwd`, no `src/cli.ts`
  /// there, or no `bun` to run it.
  public static func fromMcpJson(
    _ data: Data?, searchPath: String?, home: String, isExecutable: (String) -> Bool, fileExists: (String) -> Bool
  ) -> Found? {
    guard let data, let root = (try? JSONSerialization.jsonObject(with: data)) as? [String: Any],
      let servers = root["mcpServers"] as? [String: Any], let entry = servers["talos-app"] as? [String: Any],
      let command = entry["command"] as? String, !command.isEmpty, let args = entry["args"] as? [String],
      let cwdAt = args.firstIndex(of: "--cwd"), cwdAt + 1 < args.count
    else { return nil }
    let bridgeDir = PathUtil.expandTilde(args[cwdAt + 1], home: home)
    let cli = bridgeDir + "/src/cli.ts"
    guard fileExists(cli) else { return nil }
    guard let runner = findProgram(command, searchPath: searchPath, home: home, isExecutable: isExecutable) else { return nil }
    var env: [String: String] = [:]
    for (k, v) in (entry["env"] as? [String: Any]) ?? [:] { if let s = v as? String { env[k] = s } }
    return Found(command: [runner, "run", cli], env: env)
  }

  /// An absolute path for a program name: `~` expanded, a bare name looked up on the login PATH and the usual install
  /// folders. The processes we start (`Process`, SwiftTerm's execve) do no PATH search of their own, so `bun run ...` typed
  /// in Settings must be resolved here (audit review: it threw "bun doesn't exist").
  public static func findProgram(_ name: String, searchPath: String?, home: String, isExecutable: (String) -> Bool) -> String? {
    let n = PathUtil.expandTilde(name, home: home)
    if n.contains("/") { return isExecutable(n) ? n : nil }
    return LoginShellEnv.which(n, path: searchPath, isExecutable: isExecutable)
      ?? ["\(home)/.bun/bin", "/opt/homebrew/bin", "/usr/local/bin"].map { "\($0)/\(n)" }.first(where: isExecutable)
  }

  /// The owner's typed command made runnable: first word resolved by `findProgram`, `~` expanded in the rest. nil when the
  /// program can't be found, so callers say so instead of failing at exec.
  public static func runnable(_ command: [String], searchPath: String?, home: String, isExecutable: (String) -> Bool) -> [String]? {
    guard let first = command.first,
      let program = findProgram(first, searchPath: searchPath, home: home, isExecutable: isExecutable)
    else { return nil }
    return [program] + command.dropFirst().map { PathUtil.expandTilde($0, home: home) }
  }

  /// One plain sentence for when nothing is found, naming the Settings field (audit D7).
  public static let notFoundMessage =
    "Talos couldn't find the talos-app command. Open \(MacSettingsText.connectionPath) and fill in “talos-app command”, "
    + "for example: bun run /path/to/talos-app/apps/bridge/src/cli.ts (the first word is looked up on your PATH)"

  /// Settings stores the command as one line; desktop.json stores an argument list. Quotes group words with spaces.
  public static func parseCommandLine(_ s: String) -> [String] {
    var out: [String] = []
    var cur = ""
    var quote: Character?
    var has = false
    for ch in s {
      if let q = quote {
        if ch == q { quote = nil } else { cur.append(ch) }
      } else if ch == "\"" || ch == "'" {
        quote = ch
        has = true
      } else if ch == " " || ch == "\t" {
        if has || !cur.isEmpty { out.append(cur) }
        cur = ""
        has = false
      } else {
        cur.append(ch)
      }
    }
    if has || !cur.isEmpty { out.append(cur) }
    return out
  }

  public static func formatCommandLine(_ a: [String]) -> String {
    a.map { $0.contains(" ") || $0.isEmpty ? "\"\($0)\"" : $0 }.joined(separator: " ")
  }
}
