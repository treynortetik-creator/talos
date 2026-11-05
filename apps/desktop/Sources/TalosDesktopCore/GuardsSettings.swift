import Foundation

/// The optional guards that `talos-app install-guards` writes to `<talosHome>/guards/settings.json`: a PreToolUse hook and
/// permission deny rules. Claude Code reads one `--settings` per run, so a launch that already carries its own settings
/// gets the guards merged into them (workers, hand-opened sessions) or is told they are off (the main session).
public enum GuardsSettings {
  public static func path(talosHome: String) -> String { talosHome + "/guards/settings.json" }

  public enum Loaded {
    case absent
    case rules(hooks: Any?, permissions: Any?)
    /// The file is there but is not a JSON object: the guards are installed and cannot be applied.
    case unreadable
  }

  public static func load(
    talosHome: String, read: (String) -> Data? = { FileManager.default.contents(atPath: $0) }
  ) -> Loaded {
    guard let data = read(path(talosHome: talosHome)) else { return .absent }
    guard let obj = (try? JSONSerialization.jsonObject(with: data)) as? [String: Any] else { return .unreadable }
    return .rules(hooks: obj["hooks"], permissions: obj["permissions"])
  }

  /// `settings` with the guards' `hooks` and `permissions` added; nil when the file exists but cannot be read.
  public static func merged(
    _ settings: [String: Any], talosHome: String, read: (String) -> Data? = { FileManager.default.contents(atPath: $0) }
  ) -> [String: Any]? {
    switch load(talosHome: talosHome, read: read) {
    case .absent: return settings
    case .unreadable: return nil
    case .rules(let hooks, let permissions):
      var out = settings
      if let hooks { out["hooks"] = hooks }
      if let permissions { out["permissions"] = permissions }
      return out
    }
  }

  /// The main session's args: the guards' file added as `--settings` when installed. When the configured args already carry
  /// a `--settings`, they are left alone and `warning` says the guards are off for this launch.
  public static func applying(
    to args: [String], talosHome: String, fileExists: (String) -> Bool = { FileManager.default.fileExists(atPath: $0) }
  ) -> (args: [String], warning: String?) {
    let file = path(talosHome: talosHome)
    guard fileExists(file) else { return (args, nil) }
    if args.contains(where: { $0 == "--settings" || $0.hasPrefix("--settings=") }) {
      return (args, "guards installed (\(file)) but the launch args already include --settings: the guards are NOT active")
    }
    return (args + ["--settings", file], nil)
  }
}
