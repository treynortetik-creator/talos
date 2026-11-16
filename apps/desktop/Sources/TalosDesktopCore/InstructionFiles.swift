import Foundation

/// The built-in plugin that loads a folder's `AGENTS.md` next to its `CLAUDE.md`, and the one setting that turns that on for a launch.
/// A session started here is told to read both files; the MCP allow list never switches this plugin off, whatever it names.
public enum InstructionFiles {
  /// The plugin's current id and its older one: both are written, so either name works in the Claude Code version that is installed.
  public static let pluginIds = ["cc-plugin-agents-md@builtin", "agents-md@builtin"]
  public static let instructionFiles = "claude-md-and-agents-md"

  /// `<name>@<marketplace>` is one of the plugins above.
  public static func isPlugin(key: String) -> Bool { pluginIds.contains(key) }

  /// `settings` with `pluginConfigs[<id>].options.instructionFiles` set for each id, next to whatever `pluginConfigs` already holds.
  public static func merged(_ settings: [String: Any]) -> [String: Any] {
    var out = settings
    var configs = out["pluginConfigs"] as? [String: Any] ?? [:]
    for id in pluginIds {
      var plugin = configs[id] as? [String: Any] ?? [:]
      var options = plugin["options"] as? [String: Any] ?? [:]
      options["instructionFiles"] = instructionFiles
      plugin["options"] = options
      configs[id] = plugin
    }
    out["pluginConfigs"] = configs
    return out
  }
}
