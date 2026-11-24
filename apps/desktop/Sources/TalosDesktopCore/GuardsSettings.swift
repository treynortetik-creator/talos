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
    // read as Claude Code reads it for main (the last of two same-named keys wins): the worker gets the hooks and rules main has
    guard let obj = SettingsJSON.object(data) else { return .unreadable }
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

  /// Main's own launch file when the guards are installed: the guards' settings with Claude Code's computer use denied added.
  /// It sits beside the guards' file, so a `/` rule in it means what it meant there.
  public static func mainLaunchPath(talosHome: String) -> String { talosHome + "/guards/main-launch.json" }

  /// What every miss below ends with; the Supervisor tells the owner's phone once when a launch carries it (review R1-4).
  public static let notDenied = "Claude Code's own computer use is NOT turned off for main"

  /// The owner's phone line when Main started without the deny: once per Supervisor run.
  public static let notDeniedPhoneLine =
    "Talos couldn't add the rule that turns off Claude Code's own computer use to Main's start. If Claude Code asks for screen access, say no; Talos's screen tools work without it."

  /// The deny as command-line permission rules: Claude Code adds `--disallowedTools` to every settings source (a tool denied at
  /// any level stays denied), and `mcp__<server>` covers every tool of that server and takes them out of the agent's context.
  public static var disallowedToolsArgs: [String] { ["--disallowedTools"] + WorkerMcp.alwaysDenied.map { "mcp__" + $0 } }

  /// `settings` with every name in `WorkerMcp.alwaysDenied` in its `deniedMcpServers` (a union: what was there stays).
  public static func denyingComputerUse(_ settings: [String: Any]) -> [String: Any] {
    var obj = settings
    var denied = (obj["deniedMcpServers"] as? [Any]) ?? []
    for n in WorkerMcp.alwaysDenied where !denied.contains(where: { ($0 as? [String: Any])?["serverName"] as? String == n }) {
      denied.append(["serverName": n])
    }
    obj["deniedMcpServers"] = denied
    return obj
  }

  /// The main session's args: one `--settings` (Claude Code reads one) that turns Claude Code's own computer use off
  /// (`WorkerMcp.alwaysDenied`; Talos's screen tools replace it) and carries the guards when installed. With the guards, their
  /// settings plus the deny are written to `mainLaunchPath` and that file is passed; without, the deny is passed as JSON text.
  ///
  /// The flag goes FIRST, so the session flag stays last (the restart and adopt checks read it there) and nothing the owner put
  /// at the end (a `--` and a prompt) can swallow it. When the owner's args already carry a `--settings`, theirs stays exactly
  /// where and what it is (review R2-4: a copy would change what its relative paths mean and stop later edits reaching Main);
  /// the deny goes in as `--disallowedTools` right before it, and the guards stay off for that launch, with a warning. When the
  /// guards' file cannot be read or the merged one written, the guards' file goes in as before, so the guards are never dropped
  /// for the deny's sake, and the warning ends with `notDenied` (the Supervisor tells the phone).
  ///
  /// With the OS sandbox switch on (`sandbox`, a closure the caller gives only then: it runs the preflight and builds the pieces, OsSandbox.swift),
  /// the sandbox block and its environment ride in the same one settings text. A launch that cannot carry it does not start (`refusal`: the
  /// preflight's line, or the settings file that could not be made), and the owner's own `--settings` is left alone with a warning that the lock
  /// is not active, as for the guards (os-sandbox.ts in main-launch.ts is the twin).
  public static func applyingToMain(
    to args: [String], talosHome: String, cwd: String? = nil,
    sandbox: (() -> OsSandbox.Prepared)? = nil,
    read: (String) -> Data? = { FileManager.default.contents(atPath: $0) },
    write: (Data, String) throws -> Void = { try AtomicFile.write($0, to: $1) }
  ) -> (args: [String], warnings: [String], refusal: String?) {
    let file = path(talosHome: talosHome)
    let guards = read(file)
    let launch = mainLaunchPath(talosHome: talosHome)
    let encode = { (o: [String: Any]) in try? JSONSerialization.data(withJSONObject: o, options: [.sortedKeys, .withoutEscapingSlashes]) }
    // only the owner's flags count: past the first `--` every word is the prompt (review R3-4)
    let flags = args.prefix(while: { $0 != "--" })
    if let i = flags.firstIndex(where: { $0 == "--settings" || $0.hasPrefix("--settings=") }) {
      var w: [String] = []
      if guards != nil { w.append("guards installed (\(file)) but the launch args already include --settings: the guards are NOT active") }
      if sandbox != nil { w.append("the launch args already include --settings: \(sandboxNotOn)") }
      // right before their --settings, so the next word is an option and the rule list ends there
      var out = args
      out.insert(contentsOf: disallowedToolsArgs, at: i)
      return (out, w, nil)
    }
    var pieces: OsSandbox.Pieces?
    if let sandbox {
      switch sandbox() {
      case .refused(let why): return (args, [], why)
      case .ready(let p): pieces = p
      }
    }
    let carrying = { (o: [String: Any]) in pieces.map { OsSandbox.with(o, $0) } ?? o }
    var obj: [String: Any] = [:]
    if let guards {
      guard let o = SettingsJSON.object(guards) else {
        let why = "the guards' file cannot be read: \(notDenied)"
        // with the switch on, a launch that cannot carry the sandbox does not start
        if pieces != nil { return (args, [], "\(why); and \(sandboxNotOn), so Main is not started") }
        return (["--settings", file] + args, [why], nil)
      }
      obj = o
    }
    guard let data = encode(carrying(denyingComputerUse(obj))) else {
      let why = "the main settings could not be made: \(notDenied)"
      if pieces != nil { return (args, [], "\(why); and \(sandboxNotOn), so Main is not started") }
      return (guards == nil ? args : ["--settings", file] + args, [why], nil)
    }
    guard guards != nil else { return (["--settings", String(decoding: data, as: UTF8.self)] + args, [], nil) }
    do { try write(data, launch) } catch {
      let why = "\(launch) could not be written (\(error)): \(notDenied)"
      if pieces != nil { return (args, [], "\(why); and \(sandboxNotOn), so Main is not started") }
      return (["--settings", file] + args, [why], nil)
    }
    return (["--settings", launch] + args, [], nil)
  }

  /// The words that say why the extra lock on protected files (the OS sandbox) is not on for a launch that has the switch on.
  public static let sandboxNotOn = "the extra lock on protected files (OS sandbox) is NOT active"
}
