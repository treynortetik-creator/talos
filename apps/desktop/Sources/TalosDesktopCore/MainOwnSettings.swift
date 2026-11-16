import Foundation

/// Main's own `--settings`: the one in the owner's arguments for the main session, which then runs under it and not under the guards'
/// file. Flag settings outrank the project's and the user's, so its `permissions.defaultMode` is the mode main runs in, and its
/// `permissions.deny` are rules main runs under: both belong in the ceiling a thread session is checked against (`PrivilegeCeiling`).
///
/// Nothing here is guessed. A value that cannot be read (no such file, not a regular file, not a JSON object, a `permissions`, a
/// `defaultMode` or a `deny` of the wrong kind) is `unreadable`, and the caller refuses the start: neither main's mode nor its deny
/// rules are known then, and a guess can be wider than main. Read only.
public enum MainOwnSettings: Equatable, Sendable {
  /// Main's arguments carry no `--settings`.
  case none
  /// Read: the mode it names, if any, and its deny rules, made absolute where they were defined.
  /// `bypassOff`: it turns bypass off for main (`disableBypassPermissionsMode`).
  case readable(mode: String?, deny: [String], bypassOff: Bool = false)
  /// `what` is the path as the arguments have it, or `inlineName`: never the inline text itself (it can hold anything).
  case unreadable(what: String)

  public static let inlineName = "the settings given inline"
  /// More than any settings file is; a bigger one is not read into memory.
  static let maxBytes = 8 << 20

  /// The value of the last `--settings` (a later flag overrides an earlier one), nil when there is none: read as Claude Code reads
  /// its arguments (`MainArgs`), so one after `--` or inside another flag's value is not main's.
  public static func value(in args: [String]) -> String? { MainArgs.lastValue(args, "--settings") }

  /// A regular file's bytes, never anything else: a FIFO or a device would block or never end, and is not settings. Opened without
  /// blocking and checked on the open descriptor, so what is checked is what is read.
  static func regularFile(_ path: String) -> Data? {
    let fd = open(path, O_RDONLY | O_NONBLOCK | O_CLOEXEC)
    guard fd >= 0 else { return nil }
    defer { close(fd) }
    var st = stat()
    guard fstat(fd, &st) == 0, st.st_mode & S_IFMT == S_IFREG, st.st_size <= off_t(maxBytes) else { return nil }
    var out = Data()
    var buf = [UInt8](repeating: 0, count: 64 * 1024)
    while true {
      let n = buf.withUnsafeMutableBytes { Darwin.read(fd, $0.baseAddress, $0.count) }
      if n == 0 { return out }
      if n < 0 {
        if errno == EINTR { continue }
        return nil
      }
      out.append(contentsOf: buf[0..<n])
      if out.count > maxBytes { return nil }
    }
  }

  static func real(_ path: String) -> String? {
    guard let r = realpath(path, nil) else { return nil }
    defer { free(r) }
    return String(cString: r)
  }

  /// The folders the `/` rules of settings given inline are rooted at. Claude Code writes them to a file under `claude-<uid>` in its
  /// temp folder (seen in 2.1.322). Which temp folder main has is its environment's business, and another version may write them
  /// elsewhere, so every candidate is rooted (a superset; an extra deny rule opens nothing): `CLAUDE_CODE_TMPDIR`, `TMPDIR` and
  /// `/tmp`, each as given and where it really is, each with and without `claude-<uid>`; and the agent folder, as the Linux port does.
  static func inlineFolders(env: [String: String], uid: UInt32, agentDir: String) -> [String] {
    var out: [String] = []
    func add(_ f: String) { if !out.contains(f) { out.append(f) } }
    for base in [env["CLAUDE_CODE_TMPDIR"], env["TMPDIR"], "/tmp"] {
      guard var b = base, b.hasPrefix("/") else { continue }
      while b.count > 1, b.hasSuffix("/") { b.removeLast() }
      for f in [b, real(b)].compactMap({ $0 }) {
        add((f == "/" ? "" : f) + "/claude-\(uid)")
        add(f)
      }
    }
    for f in [agentDir, real(agentDir)].compactMap({ $0 }) { add(f) }
    return out
  }

  /// Claude Code reads `* ? [ ] { }` in a rule as a glob, and `(` `)` end the pattern, so a folder with one of them cannot be named
  /// by a rule (`WorkerFence.isSafe` says the same of the Talos home).
  static func nameable(_ folder: String) -> Bool {
    !folder.unicodeScalars.contains { "*?[]{}()".unicodeScalars.contains($0) || $0.value < 0x20 || $0.value == 0x7f }
  }

  /// What main's own `--settings` says. A file is relative to main's folder (the agent folder) and is the one Claude Code reads:
  /// through its links, so its `/` rules are rooted at the folder it really is in. Settings given inline (text that starts with `{`
  /// and ends with `}`, as Claude Code takes it) root their `/` rules where Claude Code writes them (`inlineFolders`). Relative
  /// rules are rooted at the agent folder as the kernel has it (its real path).
  public static func read(args: [String], agentDir: String, env: [String: String], uid: UInt32 = getuid()) -> MainOwnSettings {
    guard let value = value(in: args) else { return .none }
    // as JavaScript's trim, which takes a byte-order mark for white space too
    let trimmed = value.trimmingCharacters(in: CharacterSet.whitespacesAndNewlines.union(CharacterSet(charactersIn: "\u{FEFF}")))
    let inline = trimmed.hasPrefix("{") && trimmed.hasSuffix("}")
    // text that starts like JSON and is not closed is a file name to Claude Code, but it is still settings somebody typed (they can
    // hold a key): it is never shown as a path
    let what = trimmed.hasPrefix("{") ? inlineName : value
    var slashRoots: [String]
    let data: Data
    if inline {
      data = Data(value.utf8)
      slashRoots = inlineFolders(env: env, uid: uid, agentDir: agentDir)
    } else {
      let given = value.hasPrefix("/") ? value : agentDir + "/" + value
      guard !value.isEmpty, let file = real(given), let d = regularFile(file) else { return .unreadable(what: what) }
      data = d
      // where the file really is (its links followed), and where the arguments say it is: both, so whichever Claude Code roots at
      slashRoots = [(file as NSString).deletingLastPathComponent]
      let asGiven = ((given as NSString).standardizingPath as NSString).deletingLastPathComponent
      if !slashRoots.contains(asGiven) { slashRoots.append(asGiven) }
    }
    guard let root = SettingsJSON.object(data) else { return .unreadable(what: what) }
    guard let rawPerms = root["permissions"] else { return .readable(mode: nil, deny: []) }
    guard let perms = rawPerms as? [String: Any] else { return .unreadable(what: what) }
    var deny: [String] = []
    if let rawDeny = perms["deny"] {
      guard let list = rawDeny as? [Any] else { return .unreadable(what: what) }
      let cwd = real(agentDir) ?? agentDir
      for case let rule as String in list {
        // a `/` rule under a folder no rule can name cannot be given to the worker: not known, so not guessed
        let rooted = PrivilegeCeiling.absolutize(rule, slashAnchor: "/a", cwdAnchor: cwd) != PrivilegeCeiling.absolutize(rule, slashAnchor: "/b", cwdAnchor: cwd)
        if rooted, !slashRoots.allSatisfy(nameable) { return .unreadable(what: what) }
        for base in slashRoots {
          let a = PrivilegeCeiling.absolutize(rule, slashAnchor: base, cwdAnchor: cwd)
          if !deny.contains(a) { deny.append(a) }
        }
      }
    }
    let bypassOff = MainManagedSettings.bypassLocked(perms)
    guard let rawMode = perms["defaultMode"] else { return .readable(mode: nil, deny: deny, bypassOff: bypassOff) }
    guard let mode = rawMode as? String else { return .unreadable(what: what) }
    return .readable(mode: mode, deny: deny, bypassOff: bypassOff)
  }

  /// What main has, for the ceiling.
  public struct Ceiling: Equatable, Sendable {
    /// Main's arguments as they count for its mode: without the bypass flags when bypass is ruled out for it.
    public var permissionArgs: [String]
    public var defaultMode: String?
    public var denyRules: [String]
    /// Bypass is ruled out for main (managed settings, restricted mode or a settings file it loads): a worker gets no bypass flag.
    public var noBypass: Bool
    /// For the audit log: managed documents that could not be read, and a mode name from main's own chain nobody knows.
    public var managedUnreadable: Int
    public var unknownMode: String?
  }

  /// What main has for the ceiling, from one read of its own `--settings` (never `unreadable`: that start is refused before this).
  /// - The deny rules: the guards' (always, even when they are not main's: stricter), the project's it loads, its own and the
  ///   managed ones.
  /// - The mode main starts in when its arguments name none: its own settings' first; with none there, the project's and the
  ///   user's it loads (`--setting-sources`), and the guards' file only when that really is main's `--settings`. A name nobody
  ///   knows is `plan`. Managed settings outrank all of those, but a higher managed source this cannot see (server-managed, MDM)
  ///   can set the files aside: so the narrowest of every managed document's mode and that chain's, never wider than main runs.
  /// - Bypass ruled out (a managed or loaded `disableBypassPermissionsMode`, or `--restricted`): main falls through its bypass
  ///   flags and a bypass mode from settings, so neither counts.
  /// `managedDir` is Claude Code's managed settings folder (the system's in the app; nil reads none).
  public static func ceiling(
    _ own: MainOwnSettings, args: [String], agentDir: String, talosHome: String, claudeDir: String, managedDir: String?
  ) -> Ceiling {
    let sources = MainArgs.settingSources(args)
    let managed = MainManagedSettings.read(dir: managedDir, agentDir: agentDir)
    var deny = PrivilegeCeiling.mainDenyRules(agentDir: agentDir, talosHome: talosHome, sources: sources)
    var ownMode: String?
    var ownBypassOff = false
    switch own {
    case .none: break
    case .readable(let mode, let rules, let off):
      ownMode = mode
      ownBypassOff = off
      for r in rules where !deny.contains(r) { deny.append(r) }
    case .unreadable: ownMode = PrivilegeCeiling.Mode.narrowestName  // never asked (the start is refused); never wider if it is
    }
    for r in managed.deny where !deny.contains(r) { deny.append(r) }
    // the guards' file is main's --settings only when the app really added it as one: no --settings in the arguments as the app
    // looks for it (`GuardsSettings.applying`), and nothing that would make the added flag a prompt or another flag's value
    let guardsActive = own == .none && !args.contains { $0 == "--settings" || $0.hasPrefix("--settings=") } && !MainArgs.swallowsAppended(args)
    var chain = ownMode ?? PrivilegeCeiling.mainDefaultMode(
      agentDir: agentDir, talosHome: talosHome, claudeDir: claudeDir, guardsActive: guardsActive, sources: sources)
    var unknown: String?
    if let c = chain, !PrivilegeCeiling.Mode.isKnown(c) {
      unknown = c
      chain = PrivilegeCeiling.Mode.narrowestName
    }
    let mode = managed.modes.isEmpty ? chain : MainManagedSettings.narrowest(managed.modes + [chain ?? "default"])
    let noBypass = managed.bypassDisabled || MainArgs.hasFlag(args, "--restricted") || ownBypassOff
      || PrivilegeCeiling.chainBypassLocked(
        agentDir: agentDir, talosHome: talosHome, claudeDir: claudeDir, guardsActive: guardsActive, sources: sources)
    return Ceiling(
      permissionArgs: noBypass ? MainArgs.withoutBypass(args) : args,
      defaultMode: noBypass && mode == "bypassPermissions" ? "default" : mode, denyRules: deny, noBypass: noBypass,
      managedUnreadable: managed.unreadable, unknownMode: unknown)
  }

  /// The one line the thread gets while starts are refused: the file and the fix.
  public static func unreadableLine(what: String) -> String {
    let named = what == inlineName ? "Main's --settings given inline" : "Main's --settings file \(what)"
    return "\(named) can't be read, so this thread's own session can't start with limits that match the main session's. Fix the file or take --settings out of the main session's command (Talos Settings on the Mac), then open this thread's settings in the app and press Restart. Messages go to the main session until then."
  }

  /// The failure detail `workers.json` carries.
  public static let detailPrefix = "Main's own --settings can't be read"
  public static func unreadableDetail(what: String) -> String {
    "\(detailPrefix) (\(what)), so this session's limits can't be matched to Main's"
  }
}
