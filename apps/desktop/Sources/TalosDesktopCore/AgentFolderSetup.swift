import Foundation

/// The checklist's Agent folder row: Create a new agent, Adopt a Claude Code folder you already use, or Choose a Talos agent
/// folder you have. The pure pieces: what to run, what a result means, and which folders Choose refuses. The app runs the
/// processes (`AgentFolderFlow`).
public enum AgentFolderSetup {
  /// What Talos starts claude with for a folder it set up: the Talos mod and the channel, the same flags `install.sh` gives
  /// `desktop.json`.
  public static func launchArgs(repo: String) -> [String] {
    ["--plugin-dir", "\(repo)/plugins/talos-app-mod", "--dangerously-load-development-channels", "server:talos-app"]
  }

  /// Create runs the clone's own `install.sh`: no Mac app step (this app is already running), no question (the owner
  /// pressed Create). It never deletes, and it refuses a folder that is not empty and not a Talos agent.
  public static func installArguments(repo: String, dir: String) -> [String] {
    ["\(repo)/install.sh", "--agent-dir", dir, "--no-app", "--yes"]
  }

  /// The kit update path for a kit 1.x folder, as a preview: it changes nothing.
  public static func upgradeArguments(repo: String, dir: String) -> [String] {
    ["\(repo)/kit/scripts/upgrade.sh", "--into", dir, "--dry-run"]
  }

  /// The stamped version of a kit 1.x install (`.talos-version` starting "1."), else nil.
  public static func kit1Version(in dir: String) -> String? {
    guard let d = FileManager.default.contents(atPath: dir + "/.talos-version") else { return nil }
    let v = String(decoding: d, as: UTF8.self).trimmingCharacters(in: .whitespacesAndNewlines)
    return v.hasPrefix("1.") ? v : nil
  }

  /// Whether the folder's `.mcp.json` has a `talos-app` server, which is what the channel flag in `launchArgs` needs.
  static func connectedToTalos(_ dir: String) -> Bool {
    guard let d = FileManager.default.contents(atPath: dir + "/.mcp.json"),
      let root = (try? JSONSerialization.jsonObject(with: d)) as? [String: Any],
      let servers = root["mcpServers"] as? [String: Any]
    else { return false }
    return servers["talos-app"] != nil
  }

  /// Why the clone this app was built from can't be used, in plain words; nil when it is whole.
  public static func cloneProblem(_ repo: String) -> String? {
    let fm = FileManager.default
    let tail = "Rebuild Talos from a whole clone (apps/desktop/scripts/build-app.sh), or run ./install.sh in Terminal."
    var isDir: ObjCBool = false
    guard repo.hasPrefix("/"), fm.fileExists(atPath: repo, isDirectory: &isDir), isDir.boolValue else {
      return "Talos can't find the clone it was built from\(repo.isEmpty ? "" : " (\(repo))"). \(tail)"
    }
    if (try? fm.destinationOfSymbolicLink(atPath: repo)) != nil {
      return "The clone Talos was built from (\(repo)) is a link, which Talos will not run scripts through. \(tail)"
    }
    for (path, what) in [
      ("install.sh", "install.sh"), ("apps/bridge/src/cli.ts", "the bridge (apps/bridge)"),
      ("plugins/talos-app-mod", "the Talos mod (plugins/talos-app-mod)"),
    ] where !fm.fileExists(atPath: repo + "/" + path) {
      return "The clone Talos was built from (\(repo)) is missing \(what). \(tail)"
    }
    return nil
  }

  public enum Pick: Equatable, Sendable {
    case ok(String)
    case refused(String)
  }

  /// Choose: a folder that is already a Talos agent. Refuses one that is gone, unreadable, a link, part of the agent
  /// `desktop.json` already names (`currentAgentDir`, nil before setup), or not connected to Talos yet (that is Adopt).
  public static func choose(_ path: String, home: String, currentAgentDir: String?) -> Pick {
    let full = PathUtil.expandTilde(path.trimmingCharacters(in: .whitespaces), home: home)
    let check = AgentFolderCheck.check(path, home: home)
    if check.isProblem { return .refused(check.text) }
    if (try? FileManager.default.destinationOfSymbolicLink(atPath: URL(fileURLWithPath: full).path)) != nil {
      return .refused("\(full) is a link to another folder. Choose the folder it points to.")
    }
    // Real folders, not text: a trailing slash or a link in a parent folder names the same folder.
    let real = PathUtil.canonical(full)
    if let current = currentAgentDir.map({ PathUtil.canonical(PathUtil.expandTilde($0, home: home)) }), current != real {
      if real.hasPrefix(current + "/") || current.hasPrefix(real + "/") {
        return .refused("\(full) belongs to your current agent folder, \(current). Choose that folder itself, or one outside it.")
      }
    }
    if !connectedToTalos(real) { return .refused("\(full) is not connected to Talos yet. Use Adopt to connect it.") }
    return .ok(real)
  }

  public enum Outcome: Equatable, Sendable {
    case done
    /// Adopt found a talos-app server that runs another clone. The owner decides; the text says which.
    case needsConfirm(String)
    case failed(String)
  }

  /// What the installer's exit means. Its own words are passed on (it says what it did and what to do), with its advice to run
  /// it again turned into this app's button.
  public static func createOutcome(status: Int32?, stderr: String) -> Outcome {
    guard let status else { return .failed("Talos couldn't run the installer.") }
    if status == 0 { return .done }
    let lines = stderr.split(separator: "\n").map(String.init).filter { !$0.trimmingCharacters(in: .whitespaces).isEmpty }
    if status == 3 {
      let missing = lines.filter { $0.hasPrefix("  - ") }.map { $0.dropFirst(4) }
      if !missing.isEmpty {
        return .failed("Something Talos needs is missing. Install it, then press Create again. Nothing was changed.\n" + missing.joined(separator: "\n"))
      }
    }
    let said = appWording(lines.suffix(6).joined(separator: "\n"))
    return .failed(said.isEmpty ? "The installer stopped (exit \(status)) without saying why." : said)
  }

  /// The installer talks to someone in Terminal. These are its sentences with the flags and commands swapped for this app's buttons.
  static func appWording(_ text: String) -> String {
    let swaps: [(String, String)] = [
      ("To point the agent at this clone, run ./install.sh --repoint; otherwise run the install.sh in the clone it points at.", "To point it at this clone, use Adopt, which asks first."),
      ("(the default ~/talos-agent), or pass --allow-synced-folder if you know why.", "(for example ~/talos-agent)."),
      ("Pick a new folder with --agent-dir.", "Pick a new folder."),
      ("run ./install.sh again", "press Create again"),
    ]
    return swaps.reduce(text) { $0.replacingOccurrences(of: $1.0, with: $1.1) }
  }

  /// What `talos-app adopt` exit means: 0 done, 3 a talos-app server that runs another clone, anything else a refusal. The
  /// output is a terminal's, so its refusal is the line that starts "talos-app:".
  public static func adoptOutcome(status: Int32?, output: String) -> Outcome {
    guard let status else { return .failed("Talos couldn't run talos-app adopt.") }
    if status == 0 { return .done }
    let said =
      output.split(separator: "\n").map(String.init).last { $0.hasPrefix("talos-app: ") }?.dropFirst("talos-app: ".count)
      ?? Substring(output.trimmingCharacters(in: .whitespacesAndNewlines))
    if status == 3 { return .needsConfirm(said.replacingOccurrences(of: " Run again with --repoint to point it here.", with: "")) }
    return .failed(said.isEmpty ? "talos-app adopt stopped (exit \(status)) without saying why." : String(said))
  }
}
