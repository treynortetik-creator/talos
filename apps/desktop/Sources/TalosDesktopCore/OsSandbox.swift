import Foundation

/// The opt-in OS sandbox ("Extra lock on protected files", config.json `os_sandbox`), Mac half. With the switch on, Main and every thread
/// session start inside Claude Code's own sandbox (Seatbelt), locked: no command can leave it and a session does not start without it.
/// The sandbox's `denyWrite` makes the Talos home's protected files unwritable at the kernel, whatever way a command is written.
///
/// This file is the Swift twin of apps/bridge/src/guards/os-sandbox.ts and builds the same JSON for the same inputs (the golden test pair:
/// apps/bridge/test/os-sandbox-parity.test.ts and OsSandboxParityTests). The folder rules are OsSandboxFolder.swift (the twin of
/// os-sandbox-folder.ts). No flag is set on the files themselves (docs/SECURITY.md says why); the link-count preflight is the protection.
///
/// Two holes the builder and the preflight close (a hard link made before launch reaches a protected file through the sandbox; a rule whose
/// path is not the real path is silently not enforced): the preflight refuses a launch unless every protected file has link count 1 and is a
/// regular file, and every path in the settings is the real path and also its lower-case form (a Mac's disks compare names without case).
public enum OsSandbox {
  public static let dirName = "sandbox"
  public static let excludesName = "gitignore"

  /// What the sandbox mounts into a session's folder as placeholders on Linux; here they are only the names git is told to leave alone.
  public static let placeholders = [
    ".bashrc", ".bash_profile", ".profile", ".zshrc", ".zprofile", ".gitconfig", ".gitmodules", ".mcp.json", ".ripgreprc", ".idea", ".vscode",
  ]

  /// Names under the Talos home that are unwritable in the sandbox (HOME_WRITE_DENIED, HOME_READ_ONLY, the excludes folder, `workers`,
  /// `workers.json` in guards/os-sandbox.ts): the order is the TypeScript list's, since the settings text is compared byte for byte.
  public static let denyWriteNames = [
    "bridge.env", "mod.key", "apps/catalog.json", "auto-update", "enroll-pending", "bridge.key", "bridge.key.next", "bridge.key.prev", "guards",
    "tripwire.json", "tripwire.writing", "devices.json", "screen", "config.json", "owner-folders.json", "agent-request.json",
    "permission-mode-request.json", "main-restart-check.json", "last-good", "config-history", "relay-connect.json", "relay-auto.json",
    "relay-redeploy-request.json", "relay-redeploy-result.json", "secret-backend", "secrets", "supervisor-control", "supervisor-stopped",
    "restart-proofs-used.json", "restart-proof-mark.json", "restart-actor.json", "supervisor.json", "launch", dirName, "workers", "workers.json",
  ]
  /// Names under the Talos home no command may read (HOME_NEVER): the signing keys, the secret store, the supervisor's control files.
  public static let denyReadNames = [
    "mod.key", "bridge.key", "bridge.key.next", "bridge.key.prev", "enroll-pending", "guards", "guards.json", "tripwire.json", "tripwire.writing",
    "agent-request.json", "permission-mode-request.json", "main-restart-check.json", "relay-redeploy-request.json", "relay-redeploy-result.json",
    "secrets", "supervisor-control", "supervisor-stopped", "restart-proofs-used.json", "restart-proof-mark.json", "restart-actor.json",
  ]
  /// The files in each `workers/<thread>/` that pass between the supervisor and the bridge or configure the session (WORKER_FILES and the
  /// session's own settings, MCP config, project check and prompt).
  public static let workerControlNames = [
    "wake", "control", "nonce", "ready", "dialog-card.json", "dialog-answer.json", "main-dialog-answer.json", "dialog-result.json",
    "dialog-proofs-used.json", "main-dialog-proofs-used.json", "wake-written.json", "wake-state.json", "settings.json", "mcp.json",
    "project-check.json", "system-prompt.md",
  ]
  /// The cache folders a sandboxed session uses instead of the shared ones, which are outside the sandbox's writable area (CACHE_ENV).
  public static let cacheEnv: [(String, String)] = [
    ("npm_config_cache", "npm"), ("npm_config_store_dir", "pnpm-store"), ("BUN_INSTALL_CACHE_DIR", "bun"), ("XDG_CACHE_HOME", "xdg"),
    ("XDG_STATE_HOME", "state"), ("PNPM_HOME", "pnpm"), ("npm_config_devdir", "node-gyp"), ("PLAYWRIGHT_BROWSERS_PATH", "playwright"),
  ]
  /// Names checked by the preflight: the denied-write ones (the excludes folder is the app's own and written fresh each launch).
  static var preflightNames: [String] {
    denyWriteNames.filter { $0 != dirName && $0 != "workers" } + ["workers/_hook"]
  }

  /// The launch is refused: a path cannot be resolved, so nothing is emitted for it.
  public struct Failure: Error, Equatable, CustomStringConvertible {
    public let message: String
    public var description: String { message }
  }

  public struct Input: Sendable {
    public var talosHome: String
    public var userHome: String
    /// The session's own folder: its package caches live in `.cache` there.
    public var folder: String
    /// The session starts with its own `GIT_CONFIG_COUNT` (the owner's): the sandbox's entry is added after his, never in place of them.
    public var gitConfigCount: Int = 0
    /// The session loads the folder's project and local settings (Main and a thread in the agent folder); false: a thread outside it loads
    /// user settings only.
    public var loadsProject = true
    /// Claude Code's config folder (its user settings are checked for sandbox keys).
    public var claudeDir: String
    /// Entries of the owner's own git excludes file, appended to the sandbox's so his ignores still hold.
    public var ownerExcludes: [String] = []
    /// Where the kit release is (its real path is denied, and a command through the folder's kit links is the kit's own): from the session's login environment.
    public var kitDir: String?
    /// The bun and the bridge folder Talos recorded where the sandbox cannot write (real paths); nil: none, and a `talos-app` server entry refuses.
    public var trustedBridge: TrustedBridge?
    /// Main's launch arguments (`--add-dir` refuses the start); empty for a thread session.
    public var launchArgs: [String] = []
    public init(
      talosHome: String, userHome: String, folder: String, claudeDir: String, gitConfigCount: Int = 0, loadsProject: Bool = true,
      ownerExcludes: [String] = []
    ) {
      self.talosHome = talosHome
      self.userHome = userHome
      self.folder = folder
      self.claudeDir = claudeDir
      self.gitConfigCount = gitConfigCount
      self.loadsProject = loadsProject
      self.ownerExcludes = ownerExcludes
    }
  }

  /// What Talos itself recorded about its bridge: the bun it runs and `<clone>/apps/bridge`.
  public struct TrustedBridge: Equatable, Sendable {
    public var bun: String
    public var bridgeDir: String
    public init(bun: String, bridgeDir: String) { self.bun = bun; self.bridgeDir = bridgeDir }
    var asTrusted: OsSandboxFolder.Trusted { .init(bun: bun, bridgeDir: bridgeDir) }
  }

  public struct Pieces: Equatable, @unchecked Sendable {
    /// The `sandbox` block of the settings JSON.
    public var sandbox: [String: Any]
    /// Added to the settings' `env`: package caches in the folder, and git's excludes file.
    public var env: [String: String]
    /// The excludes file the app writes before the launch: where, and its lines.
    public var excludesPath: String
    public var excludesLines: [String]

    public static func == (a: Pieces, b: Pieces) -> Bool { a.canonicalJSON() == b.canonicalJSON() }

    /// `{env, excludes: {lines, path}, sandbox}` as `OsSandbox.canonical` writes it: the text the cross-language golden holds.
    public func canonicalJSON() -> String {
      OsSandbox.canonical(["sandbox": sandbox, "env": env, "excludes": ["path": excludesPath, "lines": excludesLines]])
    }
  }

  /// JSON text with the keys of every object in UTF-16 code unit order (what a JavaScript `sort()` gives, and what the TypeScript test writes) and
  /// no escaped slash: one spelling for one value, in both languages. Foundation's own `.sortedKeys` orders keys by locale rules (`PNPM_HOME`
  /// after `npm_config_*`), which is not the same order.
  public static func canonical(_ value: Any) -> String {
    switch value {
    case let d as [String: Any]:
      let keys = d.keys.sorted { Array($0.utf16).lexicographicallyPrecedes(Array($1.utf16)) }
      return "{" + keys.map { canonical($0) + ":" + canonical(d[$0] as Any) }.joined(separator: ",") + "}"
    case let a as [Any]:
      return "[" + a.map { canonical($0) }.joined(separator: ",") + "]"
    case let s as String:
      let d = (try? JSONSerialization.data(withJSONObject: s, options: [.fragmentsAllowed, .withoutEscapingSlashes])) ?? Data()
      return String(decoding: d, as: UTF8.self)
    case let n as NSNumber:
      if CFGetTypeID(n) == CFBooleanGetTypeID() { return n.boolValue ? "true" : "false" }
      return "\(n)"
    default:
      return "null"
    }
  }

  // MARK: the settings

  private static func resolveReal(_ p: String, _ what: String) throws -> String {
    do { return try OsSandboxPaths.real(OsSandboxPaths.resolve("/", p)) } catch let e as OsSandboxPaths.Failure {
      throw Failure(message: "the OS sandbox cannot be set up: \(what) (\(p)) cannot be resolved (\(e.message))")
    }
  }

  /// The real path of `name` under the real home: the entry itself when it exists (it must resolve), else where it would be.
  private static func protectedPath(_ realHome: String, _ name: String) throws -> String {
    let p = OsSandboxPaths.join(realHome, name)
    guard OsSandboxPaths.lstatOk(p) else { return p }  // not there yet: a rule for where it would be
    return try resolveReal(p, name)
  }

  /// A path as the rules carry it: the real spelling, and the lower-case one beside it when it differs.
  static func forms(_ p: String) -> [String] {
    let lower = p.lowercased()
    return lower == p ? [p] : [p, lower]
  }

  /// The sandbox block, the environment and the excludes file for one session. Every path is a real path (the home may be a symlink, the
  /// folder too), each also in lower case. A path that cannot be resolved throws `Failure`: nothing partial is returned.
  public static func settings(_ i: Input) throws -> Pieces {
    let home = try resolveReal(i.talosHome, "the Talos home")
    let folder = try resolveReal(i.folder, "the session's folder")
    func under(_ names: [String]) throws -> [String] { try names.flatMap { forms(try protectedPath(home, $0)) } }
    let excludesPath = OsSandboxPaths.join(OsSandboxPaths.join(home, dirName), excludesName)
    let n = max(i.gitConfigCount, 0)
    var env: [String: String] = [:]
    for (k, dir) in cacheEnv { env[k] = "\(folder)/.cache/\(dir)" }
    env["GIT_CONFIG_COUNT"] = String(n + 1)
    env["GIT_CONFIG_KEY_\(n)"] = "core.excludesFile"
    env["GIT_CONFIG_VALUE_\(n)"] = excludesPath
    var lines: [String] = []
    for l in placeholders + [".claude/", ".cache/"] + i.ownerExcludes where !lines.contains(l) { lines.append(l) }
    let sandbox: [String: Any] = [
      "enabled": true, "failIfUnavailable": true, "allowUnsandboxedCommands": false,
      // the two settings that open the sandbox to Apple Events and to a weaker network model, said off here so no lower level can turn them on
      "allowAppleEvents": false, "enableWeakerNetworkIsolation": false,
      // commands run inside the sandbox without asking is an owner choice, not the lock's: said off here, and a settings file may only say off too
      "autoAllowBashIfSandboxed": false,
      "filesystem": [
        // nothing is added to what Claude Code lets a session write by default (its folder and tmp): the Talos home is NOT writable from a
        // session. The agent's Talos work goes through the talos-app MCP server, which runs outside the sandbox.
        "allowWrite": [String](),
        "denyWrite": try under(denyWriteNames) + OsSandboxFolder.denyWrite(folder, userHome: i.userHome, kitDir: i.kitDir, clone: i.trustedBridge?.asTrusted.clone).flatMap(forms),
        "denyRead": try under(denyReadNames),
      ] as [String: Any],
    ]
    return Pieces(sandbox: sandbox, env: env, excludesPath: excludesPath, excludesLines: lines)
  }

  /// `settings` with the sandbox block and the environment added; any `sandbox` the settings had keeps only its `network` object.
  public static func with(_ settings: [String: Any], _ p: Pieces) -> [String: Any] {
    var out = settings
    var sb = p.sandbox
    if let net = (settings["sandbox"] as? [String: Any])?["network"] as? [String: Any] { sb["network"] = net }
    out["sandbox"] = sb
    var env = (settings["env"] as? [String: Any]) ?? [:]
    for (k, v) in p.env { env[k] = v }
    out["env"] = env
    return out
  }

  /// Do `settings` (a spec's, parsed) carry exactly the sandbox block `p` and each of its environment entries? The supervisor's own check of a
  /// spec it built with the switch on (validateSpec's `osSandbox` in worker-spec.ts).
  public static func carries(_ settings: [String: Any], _ p: Pieces) -> Bool {
    guard let have = settings["sandbox"], canonical(have) == canonical(p.sandbox) else { return false }
    let env = settings["env"] as? [String: Any] ?? [:]
    return p.env.allSatisfy { (env[$0.key] as? String) == $0.value }
  }

  /// Where the kit release is for a session whose login environment is `env` (never the app's own environment).
  public static func kitDir(userHome: String, env: [String: String]) -> String { OsSandboxFolder.defaultKitDir(userHome: userHome, env: env) }

  // MARK: the switch

  public enum Switch: Equatable, Sendable {
    case off
    case on
    /// config.json is there and cannot be read, or is not a JSON object: the switch keeps the state of its last good reading (`keptOn`), and is
    /// off when there never was one: the lock is off unless the owner chose it (the same rule as the bridge's). The line is what the audit log says.
    case unreadable(String, keptOn: Bool)

    /// Does a start carry the lock?
    public var isOn: Bool {
      switch self {
      case .off: return false
      case .on: return true
      case .unreadable(_, let keptOn): return keptOn
      }
    }
  }

  /// Where the last good reading of the switch is kept: a file inside `config-history`, a name the sandbox (denyWrite) and the guards both keep
  /// sessions from writing, as they do config.json itself. Only the app and the bridge write it, and only from a reading of config.json that worked.
  public static let switchRecordName = "config-history/os-sandbox-last"

  /// lstat of `path` as its mode bits, nil when it is not there (a link is reported as a link, never followed).
  private static func lmode(_ path: String) -> (mode: mode_t, links: nlink_t, size: off_t)? {
    var st = stat()
    guard lstat(path, &st) == 0 else { return nil }
    return (st.st_mode & S_IFMT, st.st_nlink, st.st_size)
  }

  /// The state kept by the last good reading; false (off) when there is none, or when the folder or the record is anything but what we write:
  /// the folder a real directory, the record a plain file with one name and a few bytes, checked before it is opened (a pipe is never opened).
  /// The TypeScript twin is lastKnownSwitch in guards/os-sandbox-record.ts.
  static func lastKnownSwitch(talosHome: String) -> Bool {
    guard lmode(talosHome + "/config-history")?.mode == S_IFDIR else { return false }
    let file = talosHome + "/" + switchRecordName
    guard let r = lmode(file), r.mode == S_IFREG, r.links == 1, r.size <= 16 else { return false }
    guard let d = FileManager.default.contents(atPath: file), let t = String(data: d, encoding: .utf8) else { return false }
    return t.trimmingCharacters(in: .whitespacesAndNewlines) == "on"
  }

  /// Keeps `on` as the last good reading (only when it changed). False when the record could not be put right (the folder is a link or a file,
  /// the write failed). A record entry that is not a plain file is removed first (only that one entry). No home: nothing is made, and that is fine.
  @discardableResult
  static func rememberSwitch(talosHome: String, on: Bool) -> Bool {
    var isDir: ObjCBool = false
    guard FileManager.default.fileExists(atPath: talosHome, isDirectory: &isDir), isDir.boolValue else { return true }
    if lastKnownSwitch(talosHome: talosHome) == on { return true }
    let dir = talosHome + "/config-history"
    if let m = lmode(dir) {
      if m.mode != S_IFDIR { return false }  // a link or a file where the folder belongs: never written through
    } else if (try? FileManager.default.createDirectory(atPath: dir, withIntermediateDirectories: false, attributes: [.posixPermissions: 0o700])) == nil {
      return false
    }
    let file = talosHome + "/" + switchRecordName
    if let r = lmode(file), !(r.mode == S_IFREG && r.links == 1) { try? FileManager.default.removeItem(atPath: file) }
    guard (try? Data((on ? "on\n" : "off\n").utf8).write(to: URL(fileURLWithPath: file), options: .atomic)) != nil else { return false }
    chmod(file, 0o600)
    return true
  }

  /// The switch as config.json's bytes say it. A file that is not there is off (nothing was ever set); `nil` bytes for a file that exists, and
  /// bytes that are not a JSON object, are `unreadable`: the state of the last good reading (`lastKnown`, asked only then), else off. Otherwise
  /// only `"os_sandbox": true`, the JSON literal, is on.
  public static func switchState(configJSON: Data?, exists: Bool = true, lastKnown: @autoclosure () -> Bool = false) -> Switch {
    guard exists else { return .off }
    let why = "config.json cannot be read (it is not a JSON object, or it cannot be opened); fix or restore the file"
    guard let d = configJSON, let root = (try? JSONSerialization.jsonObject(with: d)) as? [String: Any] else { return .unreadable(why, keptOn: lastKnown()) }
    guard let v = root["os_sandbox"] as? NSNumber else { return .off }
    return CFGetTypeID(v) == CFBooleanGetTypeID() && v === kCFBooleanTrue ? .on : .off
  }

  /// The switch from the Talos home's config.json, read again at every start; a good reading is kept as the last known state.
  /// `onNotRecorded` is told when the lock is on but that could not be written down (a later damaged file would then read as off).
  public static func switchState(talosHome: String, onNotRecorded: (() -> Void)? = nil) -> Switch {
    let path = talosHome + "/config.json"
    var st = stat()
    guard lstat(path, &st) == 0 else {
      return errno == ENOENT ? .off : switchState(configJSON: nil, lastKnown: lastKnownSwitch(talosHome: talosHome))
    }
    let s = switchState(configJSON: FileManager.default.contents(atPath: path), lastKnown: lastKnownSwitch(talosHome: talosHome))
    switch s {
    case .on: if !rememberSwitch(talosHome: talosHome, on: true) { onNotRecorded?() }
    case .off: rememberSwitch(talosHome: talosHome, on: false)
    case .unreadable: break
    }
    return s
  }

  // MARK: the preflight

  /// Entries looked at in a protected folder at most (a folder with more is refused, never skipped).
  static let walkCap = 5000

  /// Why `path` (named `shown`) cannot be protected, or nil: a link, a file with another name, or a thing that is neither file nor folder.
  static func entryProblem(_ path: String, _ shown: String, _ budget: inout Int) -> String? {
    var st = stat()
    guard lstat(path, &st) == 0 else {
      return errno == ENOENT ? nil : "\(shown) cannot be read (\(String(cString: strerror(errno)))); fix its permissions, then start again"
    }
    switch st.st_mode & S_IFMT {
    case S_IFLNK: return "\(shown) is a symbolic link; remove it, then start again"
    case S_IFDIR:
      let names: [String]
      do { names = try FileManager.default.contentsOfDirectory(atPath: path) } catch {
        return "\(shown) cannot be listed (\(error.localizedDescription)); fix its permissions, then start again"
      }
      for n in names {
        budget -= 1
        if budget < 0 { return "\(shown) holds too many entries to check; clear it out, then start again" }
        if let why = entryProblem(path + "/" + n, "\(shown)/\(n)", &budget) { return why }
      }
      return nil
    case S_IFCHR: return nil  // a sandbox's placeholder for a name that does not exist
    case S_IFREG:
      return st.st_nlink == 1 ? nil : "\(shown) has another name on this disk (a hard link); remove the other link, then start again"
    default: return "\(shown) is not a regular file; remove it, then start again"
    }
  }

  /// The sandbox cannot protect a file that has a second name, so a launch with the switch on is refused unless every protected file that
  /// exists is a regular file with link count 1 (not a symlink) and every protected folder holds only such files. One plain line naming the
  /// file and how to fix it, or nil when all is fine.
  public static func preflight(talosHome: String) -> String? {
    var budget = walkCap
    for name in preflightNames {
      if let why = entryProblem(talosHome + "/" + name, name, &budget) { return why }
    }
    let threads = (try? FileManager.default.contentsOfDirectory(atPath: talosHome + "/workers")) ?? []
    for t in threads {
      for n in workerControlNames {
        if let why = entryProblem("\(talosHome)/workers/\(t)/\(n)", "workers/\(t)/\(n)", &budget) { return why }
      }
    }
    return nil
  }

  // MARK: the owner's git excludes, and the file written for the session

  /// The entries of the owner's own global git excludes file (core.excludesFile from `git config --global`, else git's default location),
  /// read only. `configured` is what git said (the caller asks git); a file that cannot be read adds nothing.
  public static func ownerExcludes(userHome: String, configured: String?) -> [String] {
    let expand = { (p: String) in p.hasPrefix("~/") ? userHome + "/" + p.dropFirst(2) : p }
    let file = configured.map(expand) ?? userHome + "/.config/git/ignore"
    guard let st = try? FileManager.default.attributesOfItem(atPath: file), ((st[.size] as? Int) ?? Int.max) <= 256 * 1024,
      let d = FileManager.default.contents(atPath: file)
    else { return [] }
    // by the "\n" byte, not by Character: Swift reads "\r\n" as one Character that is not "\n"
    return String(decoding: d, as: UTF8.self).components(separatedBy: "\n")
      .map { $0.hasSuffix("\r") ? String($0.dropLast()) : $0 }
      .filter { !$0.trimmingCharacters(in: .whitespaces).isEmpty }
  }

  /// Writes the excludes file of `pieces` (the app's own write; sessions get it read-only). Never through a link: a folder or file planted at
  /// `sandbox/` (made outside) would send the app's write elsewhere.
  static func writeExcludes(_ p: Pieces, write: (Data, String) throws -> Void) throws {
    for path in [(p.excludesPath as NSString).deletingLastPathComponent, p.excludesPath] where OsSandboxPaths.isLink(path) {
      throw Failure(message: "\(path) is a symbolic link; remove it, then start again")
    }
    try write(Data((p.excludesLines.joined(separator: "\n") + "\n").utf8), p.excludesPath)
  }

  // MARK: one start

  public enum Prepared: Equatable {
    /// The start is refused, in one plain line.
    case refused(String)
    /// The sandbox this start carries.
    case ready(Pieces)

    public var pieces: Pieces? { if case .ready(let p) = self { return p } else { return nil } }
  }

  /// Everything one launch needs with the switch on: the preflight, the folder checks, the pieces and the excludes file written. `dry`:
  /// nothing is written (the update check's plan). `kitDir` is where the kit release is, worked out from the session's own login environment.
  public static func prepare(
    _ i: Input, dry: Bool = false, write: (Data, String) throws -> Void = { try AtomicFile.write($0, to: $1, mode: 0o644) },
    kitDir: String
  ) -> Prepared {
    if let bad = preflight(talosHome: i.talosHome) { return .refused(bad) }
    do {
      let folder = try resolveReal(i.folder, "the session's folder")
      if let why = OsSandboxFolder.launchArgsProblem(i.launchArgs) { return .refused(why) }
      if let problem = OsSandboxFolder.launchProblem(folder, claudeDir: i.claudeDir, loadsProject: i.loadsProject, kitDir: kitDir, userHome: i.userHome, talosHome: i.talosHome, trusted: i.trustedBridge?.asTrusted) {
        return .refused(problem)
      }
      var withKit = i
      withKit.kitDir = kitDir
      let pieces = try settings(withKit)
      if !dry { try writeExcludes(pieces, write: write) }
      return .ready(pieces)
    } catch let f as Failure {
      return .refused(f.message)
    } catch {
      return .refused("the OS sandbox cannot be set up: \(error)")
    }
  }

  /// An earlier build set `chflags uchg` on these files; none is set now (it protected nothing: see docs/SECURITY.md). Any that still carries the
  /// flag has it taken off, so no file is left unwritable. Quiet when there is nothing to do; a flag that cannot be cleared comes back as a note.
  public static let legacyFlagged = ["restart-proofs-used.json", "restart-proof-mark.json", "secret-backend"]

  public static func clearLegacyFlags(talosHome: String) -> [String] {
    var notes: [String] = []
    for n in legacyFlagged {
      let p = talosHome + "/" + n
      var st = stat()
      guard lstat(p, &st) == 0, (st.st_mode & S_IFMT) == S_IFREG, st.st_flags & UInt32(UF_IMMUTABLE) != 0 else { continue }
      if lchflags(p, st.st_flags & ~UInt32(UF_IMMUTABLE)) != 0 {
        notes.append("\(n) is still locked by an earlier version (\(String(cString: strerror(errno)))); run chflags nouchg on it from a terminal")
      }
    }
    return notes
  }
}
