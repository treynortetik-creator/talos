import CryptoKit
import Foundation

/// `desktop.json` (DESKTOP-SPEC 4.1). Whether Talos starts at login is the system's (the login item), not this file: the old
/// `start_at_login` key is ignored when read and no longer written, and an older build reads a file without it. Defaults are generic; the owner's real launch command lives only in his local file,
/// never in code. Decoding tolerates missing keys (a D0-era file, or a hand-written one) and fills them from `defaults`.
public struct DesktopConfig: Codable, Equatable, Sendable {
  /// `auto` = tmux when `tmux -V` reports 3.2 or newer, else `direct` (the app-owned pty).
  public enum Host: String, Codable, Sendable { case auto, tmux, direct }

  public struct Session: Codable, Equatable, Sendable {
    /// The conversation the next start resumes (`--resume <id>`). Never replaced by the app on its own (4.3 step 7).
    public var id: String?
    /// Last five ids the owner moved away from ([Start a new conversation]).
    public var previousIds: [String]
    /// When a start of `id` got through the dev-channel dialog, by a human Enter or by the auto-accept (ISO 8601). It only feeds the
    /// first-run checklist's "First start confirmed" row and the id hand-over (`adoptReportedIdIfNeeded`); no auto-accept reads it.
    public var confirmedAt: String?
    /// No longer written and never read (the auto-accept retired the rule that used them, 2026-11-07, see `AutoConfirmGuard`); the
    /// places that reset a session still set it to nil. Still decoded and encoded as it is, so an older desktop.json loads and a
    /// rolled-back app finds the key.
    public var confirmedCliVersion: String?
    /// See `confirmedCliVersion`: no longer written or read. The only channel that counts is `AutoConfirmGuard.talosChannel`.
    public var approvedDevChannels: [String]
    /// The id whose conversation file the app has seen on disk (so it has had a turn: Claude Code writes the file at the first
    /// message). `id` with a seen file that is later not found is lost, not unsaved: it is resumed, and fails as "can't be
    /// resumed", never quietly started over under the same id. Absent until a file is seen, and in an older desktop.json.
    public var conversationSeen: String?

    public init(
      id: String? = nil, previousIds: [String] = [], confirmedAt: String? = nil, confirmedCliVersion: String? = nil,
      approvedDevChannels: [String] = [], conversationSeen: String? = nil
    ) {
      self.conversationSeen = conversationSeen
      self.id = id
      self.previousIds = previousIds
      self.confirmedAt = confirmedAt
      self.confirmedCliVersion = confirmedCliVersion
      self.approvedDevChannels = approvedDevChannels
    }

    enum CodingKeys: String, CodingKey {
      case id
      case previousIds = "previous_ids"
      case confirmedAt = "confirmed_at"
      case confirmedCliVersion = "confirmed_cli_version"
      case approvedDevChannels = "approved_dev_channels"
      case conversationSeen = "conversation_seen"
    }

    public init(from decoder: Decoder) throws {
      let c = try decoder.container(keyedBy: CodingKeys.self)
      id = try c.decodeIfPresent(String.self, forKey: .id)
      previousIds = try c.decodeIfPresent([String].self, forKey: .previousIds) ?? []
      confirmedAt = try c.decodeIfPresent(String.self, forKey: .confirmedAt)
      confirmedCliVersion = try c.decodeIfPresent(String.self, forKey: .confirmedCliVersion)
      approvedDevChannels = try c.decodeIfPresent([String].self, forKey: .approvedDevChannels) ?? []
      conversationSeen = (try? c.decodeIfPresent(String.self, forKey: .conversationSeen)) ?? nil
    }

    public func encode(to encoder: Encoder) throws {
      var c = encoder.container(keyedBy: CodingKeys.self)
      // nulls are written explicitly, so a NEW file shows every field (the spec's 4.1 shape). An existing file keeps its own text for
      // every key a save did not change (`KeepUnknownJSON`), so it may still lack a null key.
      try c.encode(id, forKey: .id)
      try c.encode(previousIds, forKey: .previousIds)
      try c.encode(confirmedAt, forKey: .confirmedAt)
      try c.encode(confirmedCliVersion, forKey: .confirmedCliVersion)
      try c.encode(approvedDevChannels, forKey: .approvedDevChannels)
      try c.encodeIfPresent(conversationSeen, forKey: .conversationSeen)  // only once set: a file that never had it keeps its shape
    }

    /// The owner chose [Start a new conversation]: the old id moves to `previous_ids` (last 5) and the confirmation goes.
    public mutating func retireCurrentId() {
      if let old = id {
        previousIds.removeAll { $0 == old }
        previousIds.append(old)
        if previousIds.count > 5 { previousIds.removeFirst(previousIds.count - 5) }
      }
      id = nil
      confirmedAt = nil
      confirmedCliVersion = nil
      conversationSeen = nil
    }
  }

  public struct Hotkeys: Codable, Equatable, Sendable {
    public var compose: String
    public init(compose: String) { self.compose = compose }
  }

  public var v: Int
  public var host: Host
  public var agentDir: String
  public var claudePath: String
  public var args: [String]
  public var env: [String: String]
  public var session: Session
  public var autoRestart: Bool
  public var autoConfirmRestart: Bool
  public var startSessionOnLaunch: Bool
  public var openTerminalOnDialog: Bool
  public var hotkeys: Hotkeys
  public var relayUrl: String
  /// How to run the bridge CLI for the crash-loop post (`talos-app post …`). Empty = `talos-app` on the login PATH.
  public var talosAppCommand: [String]
  /// Thread for the crash-loop post. nil = `default_thread` from `$TALOS_APP_HOME/config.json`.
  public var notifyThread: String?
  /// Hold an idle-sleep assertion while the Mac is on AC power (audit D63). Off by default: a Mac that never sleeps is the
  /// owner's choice. It never keeps a closed lid awake.
  public var keepAwakeOnAC: Bool
  /// Open the main Talos window once each time the app starts (a start at login included) when a relay is set up. On by
  /// default: the owner launched Talos, saw nothing, and could not find it (2026-11-02).
  public var openWindowAtLaunch: Bool
  /// When Main's model request looks stuck on an owner message (`MainWatch.stalled`), Talos presses Esc once in Main's pane (through the
  /// key gate, only when nobody is typing and no dialog is up), asks the bridge to deliver that message again, and says so in the
  /// thread. Once per message. On by default; a desktop.json without the key reads as on. Off: the stall line only.
  public var unstickMain: Bool
  /// The launch fingerprint (`launchFingerprint`: folder, resolved program, flags without the resume id, env) of the last start that got
  /// through the dev-channel dialog. The auto-accept presses Enter only while this start's fingerprint equals it; a changed launch (or none
  /// stored yet) waits for the owner, and his confirmation stores the new one. Here, not in `session`, because a new conversation
  /// replaces the whole `session` and must not ask again. Only the owner's click on the Mac popup stores it, never a tap on the card, an auto-accept or a plain Enter in the pane. It is
  /// SEALED: `confirmedLaunchMac` is an HMAC over it with a key in the Keychain (`LaunchTrust`), so a program that can write this file cannot make
  /// an edited launch look confirmed; the guard trusts it only while the MAC verifies. The floor under that is the constant-channel check in
  /// `AutoConfirmGuard` (only `server:talos-app` is ever answered).
  public var confirmedLaunch: String?
  /// Per-piece hashes (`folder`, `program`, `flags`, `env`; never a value) of the launch `confirmedLaunch` stands for, so a card can say what
  /// changed. Only a description: nothing is decided from it.
  public var confirmedLaunchParts: [String: String]?
  /// The seal on `confirmedLaunch` and its parts: an HMAC with a key in the Keychain (`LaunchTrust`). The guard trusts the fingerprint only while
  /// it verifies; a value anyone else writes into this file does not.
  public var confirmedLaunchMac: String?
  /// The version of the seal migration that has run (`LaunchTrustMigration`); absent or 0 = it has not.
  public var launchTrust: Int?
  /// The app updates itself from signed releases (`AutoUpdate`). On for a new install (`defaults`); a desktop.json written before this
  /// setting existed has no key and reads as OFF, so a Mac that is updated another way keeps that way until its owner switches this on.
  public var autoUpdate: Bool
  /// Where the updater looks for `latest.json` and the files beside it. nil or empty = `AutoUpdate.defaultFeed`. Trust never comes from
  /// this address: only from the signature against the key pinned in the app, then Developer ID and notarization.
  public var updateFeedUrl: String?

  enum CodingKeys: String, CodingKey, CaseIterable {
    case v, host, args, env, session, hotkeys
    case agentDir = "agent_dir"
    case claudePath = "claude_path"
    case autoRestart = "auto_restart"
    case autoConfirmRestart = "auto_confirm_restart"
    case startSessionOnLaunch = "start_session_on_launch"
    case openTerminalOnDialog = "open_terminal_on_dialog"
    case relayUrl = "relay_url"
    case talosAppCommand = "talos_app_command"
    case notifyThread = "notify_thread"
    case keepAwakeOnAC = "keep_awake_on_ac"
    case openWindowAtLaunch = "open_window_at_launch"
    case unstickMain = "unstick_main"
    case confirmedLaunch = "confirmed_launch"
    case confirmedLaunchParts = "confirmed_launch_parts"
    case confirmedLaunchMac = "confirmed_launch_mac"
    case launchTrust = "launch_trust"
    case autoUpdate = "auto_update"
    case updateFeedUrl = "update_feed_url"
  }

  public init(
    v: Int, host: Host = .auto, agentDir: String, claudePath: String, args: [String], env: [String: String],
    session: Session, autoRestart: Bool, autoConfirmRestart: Bool, startSessionOnLaunch: Bool,
    openTerminalOnDialog: Bool, hotkeys: Hotkeys = Hotkeys(compose: "ctrl+opt+space"),
    relayUrl: String, talosAppCommand: [String] = [], notifyThread: String? = nil, keepAwakeOnAC: Bool = false,
    openWindowAtLaunch: Bool = true, autoUpdate: Bool = false, unstickMain: Bool = true
  ) {
    self.v = v
    self.host = host
    self.agentDir = agentDir
    self.claudePath = claudePath
    self.args = args
    self.env = env
    self.session = session
    self.autoRestart = autoRestart
    self.autoConfirmRestart = autoConfirmRestart
    self.startSessionOnLaunch = startSessionOnLaunch
    self.openTerminalOnDialog = openTerminalOnDialog
    self.hotkeys = hotkeys
    self.relayUrl = relayUrl
    self.talosAppCommand = talosAppCommand
    self.notifyThread = notifyThread
    self.keepAwakeOnAC = keepAwakeOnAC
    self.openWindowAtLaunch = openWindowAtLaunch
    self.unstickMain = unstickMain
    self.autoUpdate = autoUpdate
  }

  public init(from decoder: Decoder) throws {
    let d = DesktopConfig.defaults
    let c = try decoder.container(keyedBy: CodingKeys.self)
    v = try c.decodeIfPresent(Int.self, forKey: .v) ?? d.v
    // A value this build doesn't know (a newer build wrote it) costs that one item, never the whole file.
    host = (try? c.decodeIfPresent(Host.self, forKey: .host)) ?? d.host
    agentDir = try c.decodeIfPresent(String.self, forKey: .agentDir) ?? d.agentDir
    claudePath = try c.decodeIfPresent(String.self, forKey: .claudePath) ?? d.claudePath
    args = try c.decodeIfPresent([String].self, forKey: .args) ?? d.args
    env = try c.decodeIfPresent([String: String].self, forKey: .env) ?? d.env
    session = try c.decodeIfPresent(Session.self, forKey: .session) ?? d.session
    autoRestart = try c.decodeIfPresent(Bool.self, forKey: .autoRestart) ?? d.autoRestart
    autoConfirmRestart = try c.decodeIfPresent(Bool.self, forKey: .autoConfirmRestart) ?? d.autoConfirmRestart
    startSessionOnLaunch = try c.decodeIfPresent(Bool.self, forKey: .startSessionOnLaunch) ?? d.startSessionOnLaunch
    openTerminalOnDialog = try c.decodeIfPresent(Bool.self, forKey: .openTerminalOnDialog) ?? d.openTerminalOnDialog
    hotkeys = try c.decodeIfPresent(Hotkeys.self, forKey: .hotkeys) ?? d.hotkeys
    relayUrl = try c.decodeIfPresent(String.self, forKey: .relayUrl) ?? d.relayUrl
    talosAppCommand = try c.decodeIfPresent([String].self, forKey: .talosAppCommand) ?? d.talosAppCommand
    notifyThread = try? c.decodeIfPresent(String.self, forKey: .notifyThread)
    keepAwakeOnAC = try c.decodeIfPresent(Bool.self, forKey: .keepAwakeOnAC) ?? d.keepAwakeOnAC
    // A value of the wrong type costs this one setting, not the file.
    openWindowAtLaunch = ((try? c.decodeIfPresent(Bool.self, forKey: .openWindowAtLaunch)) ?? nil) ?? d.openWindowAtLaunch
    unstickMain = ((try? c.decodeIfPresent(Bool.self, forKey: .unstickMain)) ?? nil) ?? d.unstickMain
    confirmedLaunch = (try? c.decodeIfPresent(String.self, forKey: .confirmedLaunch)) ?? nil
    confirmedLaunchParts = (try? c.decodeIfPresent([String: String].self, forKey: .confirmedLaunchParts)) ?? nil
    confirmedLaunchMac = (try? c.decodeIfPresent(String.self, forKey: .confirmedLaunchMac)) ?? nil
    launchTrust = (try? c.decodeIfPresent(Int.self, forKey: .launchTrust)) ?? nil
    // absent (a file from before the setting) or unreadable: OFF, never the new-install default
    autoUpdate = ((try? c.decodeIfPresent(Bool.self, forKey: .autoUpdate)) ?? nil) ?? false
    updateFeedUrl = (try? c.decodeIfPresent(String.self, forKey: .updateFeedUrl)) ?? nil
  }

  public func encode(to encoder: Encoder) throws {
    var c = encoder.container(keyedBy: CodingKeys.self)
    try c.encode(v, forKey: .v)
    try c.encode(host, forKey: .host)
    try c.encode(agentDir, forKey: .agentDir)
    try c.encode(claudePath, forKey: .claudePath)
    try c.encode(args, forKey: .args)
    try c.encode(env, forKey: .env)
    try c.encode(session, forKey: .session)
    try c.encode(autoRestart, forKey: .autoRestart)
    try c.encode(autoConfirmRestart, forKey: .autoConfirmRestart)
    try c.encode(startSessionOnLaunch, forKey: .startSessionOnLaunch)
    try c.encode(openTerminalOnDialog, forKey: .openTerminalOnDialog)
    try c.encode(hotkeys, forKey: .hotkeys)
    try c.encode(relayUrl, forKey: .relayUrl)
    try c.encode(talosAppCommand, forKey: .talosAppCommand)
    try c.encode(notifyThread, forKey: .notifyThread)
    try c.encode(keepAwakeOnAC, forKey: .keepAwakeOnAC)
    try c.encode(openWindowAtLaunch, forKey: .openWindowAtLaunch)
    try c.encode(unstickMain, forKey: .unstickMain)
    try c.encode(confirmedLaunch, forKey: .confirmedLaunch)
    try c.encodeIfPresent(confirmedLaunchParts, forKey: .confirmedLaunchParts)
    try c.encodeIfPresent(confirmedLaunchMac, forKey: .confirmedLaunchMac)
    try c.encodeIfPresent(launchTrust, forKey: .launchTrust)
    try c.encode(autoUpdate, forKey: .autoUpdate)
    try c.encodeIfPresent(updateFeedUrl, forKey: .updateFeedUrl)
  }

  public static let defaults = DesktopConfig(
    v: 1,
    host: .auto,
    agentDir: "~/talos-agent",
    claudePath: "auto",
    args: [],
    env: [:],
    session: Session(),
    autoRestart: true,
    autoConfirmRestart: true,
    startSessionOnLaunch: true,
    openTerminalOnDialog: true,
    hotkeys: Hotkeys(compose: "ctrl+opt+space"),
    relayUrl: RelayConfig.placeholder,
    // a new install updates itself; an existing file without the key reads as off (`init(from:)`)
    autoUpdate: true)

  public func encoded() throws -> Data {
    let e = JSONEncoder()
    e.outputFormatting = [.sortedKeys, .prettyPrinted, .withoutEscapingSlashes]
    return try e.encode(self)
  }

  public static func decode(_ data: Data) throws -> DesktopConfig {
    try JSONDecoder().decode(DesktopConfig.self, from: data)
  }

  /// `agent_dir` with a leading `~` expanded.
  public func expandedAgentDir(home: String) -> String { PathUtil.expandTilde(agentDir, home: home) }

  /// What a start launches: SHA-256 over a length-prefixed encoding of the folder, the program, the flags (without the resume id) and the
  /// environment, so no value can pass for a separator and no two launches share a fingerprint by design. A change to any of these makes the
  /// next start a cold start (4.3 step 6) and, for the dev-channels warning, a launch the owner has not confirmed.
  /// `args`: the flags as launched, when they are not the saved ones (Main always passes the channels flag, `MainChannelFlag`).
  public func launchFingerprint(resolvedClaude: String, args launched: [String]? = nil) -> String {
    let flags = ResumeRewrite.strip(launched ?? args)
    let envRows = env.keys.sorted().flatMap { [$0, env[$0] ?? ""] }
    return Fingerprint.sha256(["dir", agentDir, "claude", resolvedClaude, "args"] + [String(flags.count)] + flags + ["env"] + [String(envRows.count)] + envRows)
  }

  /// The same inputs as `launchFingerprint`, one short hash per piece (`LaunchChange`-style names the owner knows: the folder, the program, the
  /// flags, the environment). A card compares two of these to say WHICH piece changed, never to decide anything.
  public func launchParts(resolvedClaude: String, args launched: [String]? = nil) -> [String: String] {
    let flags = ResumeRewrite.strip(launched ?? args)
    let envRows = env.keys.sorted().flatMap { [$0, env[$0] ?? ""] }
    return [
      "folder": Fingerprint.sha256([agentDir], bytes: 8), "program": Fingerprint.sha256([resolvedClaude], bytes: 8),
      "flags": Fingerprint.sha256(flags, bytes: 8), "env": Fingerprint.sha256(envRows, bytes: 8),
    ]
  }

  /// Which pieces differ between the confirmed launch and this one, in the card's order. Empty when the confirmed pieces are not known (or
  /// nothing differs): the card then says only that the start command is not confirmed.
  public static func changedPieces(confirmed: [String: String]?, now: [String: String]) -> [String] {
    guard let confirmed else { return [] }
    return ["folder", "program", "flags", "env"].filter { confirmed[$0] != nil && confirmed[$0] != now[$0] }
  }
}

public enum PathUtil {
  /// The real folder a path names: links resolved, no trailing slash, `.` and `..` gone, and the case the file system has. A path
  /// that does not exist is still cleaned the same way, so two spellings of it compare equal. Compare folders with this, never as text.
  public static func canonical(_ path: String) -> String {
    let url = URL(fileURLWithPath: path).standardized
    if let c = try? url.resourceValues(forKeys: [.canonicalPathKey]).canonicalPath { return c }
    return url.resolvingSymlinksInPath().path
  }

  public static func expandTilde(_ path: String, home: String) -> String {
    if path == "~" { return home }
    if path.hasPrefix("~/") { return home + path.dropFirst(1) }
    return path
  }
}

public enum Fingerprint {
  /// SHA-256 over the strings, each written as its UTF-8 byte count, a colon and its bytes, so a string that contains a separator or looks
  /// like the next field is still one string. Lowercase hex, cut to `bytes` bytes when given.
  public static func sha256(_ items: [String], bytes: Int = 32) -> String {
    var h = SHA256()
    for item in items {
      h.update(data: Data("\(item.utf8.count):".utf8))
      h.update(data: Data(item.utf8))
    }
    return h.finalize().prefix(bytes).map { String(format: "%02x", $0) }.joined()
  }
}

/// Reads and writes `desktop.json` atomically with mode 0600.
public enum ConfigFile {
  public static func load(_ path: String) throws -> DesktopConfig? {
    guard let data = FileManager.default.contents(atPath: path) else { return nil }
    return try DesktopConfig.decode(data)
  }

  /// Writes `config` into the file as it is now: what this build does not know (a key a newer build added, at any depth) and
  /// what it could not read (a value it fell back from) stays as the owner left it. Only what this save changed is written.
  /// A file this build cannot decode at all (not JSON, or a value of the wrong kind) is moved to `desktop.json.unreadable-<UTC stamp>`
  /// first, the newest three kept, and that path is returned, so the caller can say where it went; nothing is lost either way.
  @discardableResult
  public static func save(_ config: DesktopConfig, to path: String) throws -> String? {
    try save(config, to: path) { try AtomicFile.write($0, to: $1, mode: 0o600) }
  }

  /// The write is a parameter so a test can make it fail after the file was moved aside.
  @discardableResult
  static func save(_ config: DesktopConfig, to path: String, write: (Data, String) throws -> Void) throws -> String? {
    let existing = FileManager.default.contents(atPath: path)
    var movedTo: String?
    if let existing, !existing.isEmpty, (try? DesktopConfig.decode(existing)) == nil {
      movedTo = try setAside(path)
    }
    do {
      try write(try KeepUnknownJSON.encoded(config, overFile: existing), path)
    } catch {
      // Nothing was written: put the unreadable file back, so a restart in this window reads what the owner had, not defaults.
      if let movedTo, !FileManager.default.fileExists(atPath: path) { try? FileManager.default.moveItem(atPath: movedTo, toPath: path) }
      throw error
    }
    if let movedTo { pruneUnreadableCopies(of: path, keeping: movedTo) }  // after the write, so a failure here never costs the new file
    return movedTo
  }

  static let unreadableCopiesKept = 3

  private static func setAside(_ path: String) throws -> String {
    let fm = FileManager.default
    let dir = (path as NSString).deletingLastPathComponent
    let name = (path as NSString).lastPathComponent + ".unreadable-"
    let f = DateFormatter()
    f.locale = Locale(identifier: "en_US_POSIX")
    f.timeZone = TimeZone(identifier: "UTC")
    f.dateFormat = "yyyyMMdd'T'HHmmssSSS'Z'"
    var target = dir + "/" + name + f.string(from: Date())
    while fm.fileExists(atPath: target) { target += "x" }  // the same millisecond twice: still a new name, and it sorts after
    try fm.moveItem(atPath: path, toPath: target)
    return target
  }

  /// The newest three by name (the name is the UTC stamp). The copy just made is never removed, whatever the clock says.
  private static func pruneUnreadableCopies(of path: String, keeping fresh: String) {
    let fm = FileManager.default
    let dir = (path as NSString).deletingLastPathComponent
    let name = (path as NSString).lastPathComponent + ".unreadable-"
    let freshName = (fresh as NSString).lastPathComponent
    let others = ((try? fm.contentsOfDirectory(atPath: dir)) ?? []).filter { $0.hasPrefix(name) && $0 != freshName }.sorted()
    for old in others.dropLast(unreadableCopiesKept - 1) { try? fm.removeItem(atPath: dir + "/" + old) }
  }
}

/// The one mechanism for "round-trip what the model does not know": a three-way merge of the file as it is (`raw`), what this build
/// makes of that file (`old`, its decode encoded again) and what it is about to write (`new`). A key whose `old` and `new` agree
/// keeps its raw text; a key the save changed takes the new value or, when `new` has none, is removed; keys only `raw` has stay.
public enum KeepUnknownJSON {
  public static func encoded(_ config: DesktopConfig, overFile existing: Data?) throws -> Data {
    let fresh = try config.encoded()
    guard let existing, let raw = object(existing), let new = object(fresh) else { return fresh }
    let options: JSONSerialization.WritingOptions = [.sortedKeys, .prettyPrinted, .withoutEscapingSlashes]
    if let old = (try? DesktopConfig.decode(existing)).flatMap({ (try? $0.encoded()).flatMap(object) }) {
      var out = merge(raw: raw, old: old, new: new)
      // A reset means reset: when the session that was there is replaced by another one or by none (a new conversation), the old
      // record goes whole, and so do the keys a newer build kept in it. Setting the first id on a session that had none is not a reset.
      let was = (old["session"] as? [String: Any])?["id"] as? String
      if let was, was != (new["session"] as? [String: Any])?["id"] as? String { out["session"] = new["session"] }
      return try JSONSerialization.data(withJSONObject: out, options: options)
    }
    // The file cannot be decoded, so there is no "what this build made of it". Every key this build knows is then taken from `new`
    // (one it left out is cleared, not brought back), and the two nested structs are merged key by key to keep what they do not know.
    let known = Set(DesktopConfig.CodingKeys.allCases.map(\.rawValue))
    return try JSONSerialization.data(
      withJSONObject: merge(raw: raw, old: [:], new: new, forced: known, nested: ["session", "hotkeys"]), options: options)
  }

  static func merge(
    raw: [String: Any], old: [String: Any], new: [String: Any], forced: Set<String> = [], nested: Set<String> = []
  ) -> [String: Any] {
    var out = raw
    for k in Set(old.keys).union(new.keys).union(forced) where !same(old[k], new[k]) || forced.contains(k) {
      if let n = new[k] as? [String: Any], let r = raw[k] as? [String: Any],
        let o = old[k] as? [String: Any] ?? (nested.contains(k) ? [:] : nil)
      {
        out[k] = merge(raw: r, old: o, new: n, forced: nested.contains(k) ? Set(n.keys) : [])
      } else {
        out[k] = new[k]
      }
    }
    return out
  }

  private static func same(_ a: Any?, _ b: Any?) -> Bool {
    switch (a, b) {
    case (nil, nil): return true
    case (let a?, let b?): return (a as AnyObject).isEqual(b)
    default: return false
    }
  }

  private static func object(_ data: Data) -> [String: Any]? {
    (try? JSONSerialization.jsonObject(with: data)) as? [String: Any]
  }
}

public enum AtomicFile {
  /// tmp in the same folder (0600 from creation), then rename. The folder is created 0700 if missing.
  public static func write(_ data: Data, to path: String, mode: mode_t = 0o600) throws {
    let dir = (path as NSString).deletingLastPathComponent
    try FileManager.default.createDirectory(
      atPath: dir, withIntermediateDirectories: true, attributes: [.posixPermissions: 0o700])
    let tmp = dir + "/." + (path as NSString).lastPathComponent + ".\(getpid()).\(UInt32.random(in: 0...UInt32.max)).tmp"
    let fd = open(tmp, O_WRONLY | O_CREAT | O_EXCL, mode)
    guard fd >= 0 else { throw POSIXError(POSIXErrorCode(rawValue: errno) ?? .EIO) }
    var ok = true
    data.withUnsafeBytes { buf in
      var off = 0
      while off < buf.count {
        let n = Darwin.write(fd, buf.baseAddress! + off, buf.count - off)
        if n <= 0 { ok = false; break }
        off += n
      }
    }
    fchmod(fd, mode)
    if fsync(fd) != 0 { ok = false }
    close(fd)
    guard ok, rename(tmp, path) == 0 else {
      unlink(tmp)
      throw POSIXError(.EIO)
    }
  }
}
