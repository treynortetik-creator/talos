import Foundation

/// Where the app keeps small values of its own (UserDefaults in the app, a dictionary in tests).
public protocol SettingsStore: AnyObject {
  func data(forKey key: String) -> Data?
  func string(forKey key: String) -> String?
  func set(_ data: Data?, forKey key: String)
}

/// Settings changed before setup (U8). `desktop.json` existing is what makes the next launch start a session, so a toggle must
/// never create it. Until Import or Adopt makes the file, the values live here (UserDefaults in the app), come back on the next
/// launch, and are merged into the file when setup happens. The compose hotkey keeps its own older key
/// (`HotkeyController.preSetupKey`), which is merged too.
public struct PreSetup: Equatable, Sendable {
  public static let key = "settings.preSetup.v1"
  /// The hotkey's own key, from before this type existed.
  public static let hotkeyKey = "hotkey.compose"

  public var host: DesktopConfig.Host?
  public var agentDir: String?
  public var autoRestart: Bool?
  public var autoConfirmRestart: Bool?
  public var startSessionOnLaunch: Bool?
  public var openTerminalOnDialog: Bool?
  public var relayUrl: String?
  public var talosAppCommand: [String]?
  /// The default thread is stored as nothing, so "nil" and "never set" are told apart by `notifyThreadSet`.
  public var notifyThread: String?
  public var notifyThreadSet: Bool
  public var keepAwakeOnAC: Bool?
  public var openWindowAtLaunch: Bool?
  public var hotkey: String?

  public init(
    host: DesktopConfig.Host? = nil, agentDir: String? = nil, autoRestart: Bool? = nil, autoConfirmRestart: Bool? = nil,
    startSessionOnLaunch: Bool? = nil, openTerminalOnDialog: Bool? = nil, relayUrl: String? = nil, talosAppCommand: [String]? = nil,
    notifyThread: String? = nil, notifyThreadSet: Bool = false, keepAwakeOnAC: Bool? = nil, hotkey: String? = nil,
    openWindowAtLaunch: Bool? = nil
  ) {
    self.host = host
    self.agentDir = agentDir
    self.autoRestart = autoRestart
    self.autoConfirmRestart = autoConfirmRestart
    self.startSessionOnLaunch = startSessionOnLaunch
    self.openTerminalOnDialog = openTerminalOnDialog
    self.relayUrl = relayUrl
    self.talosAppCommand = talosAppCommand
    self.notifyThread = notifyThread
    self.notifyThreadSet = notifyThreadSet
    self.keepAwakeOnAC = keepAwakeOnAC
    self.hotkey = hotkey
    self.openWindowAtLaunch = openWindowAtLaunch
  }

  /// Every value the Settings window can change before setup, as the config holds it now. The launch command is not among
  /// them: before setup it can only be set by Import, which is the setup.
  public static func snapshot(of c: DesktopConfig) -> PreSetup {
    PreSetup(
      host: c.host, agentDir: c.agentDir, autoRestart: c.autoRestart, autoConfirmRestart: c.autoConfirmRestart,
      startSessionOnLaunch: c.startSessionOnLaunch, openTerminalOnDialog: c.openTerminalOnDialog, relayUrl: c.relayUrl,
      talosAppCommand: c.talosAppCommand, notifyThread: c.notifyThread, notifyThreadSet: true, keepAwakeOnAC: c.keepAwakeOnAC,
      openWindowAtLaunch: c.openWindowAtLaunch)
  }

  /// `c` with the held values laid over it. Anything not held is left as it is. The launch command, environment and
  /// conversation ids are never touched.
  public func applied(to c: DesktopConfig) -> DesktopConfig {
    var o = c
    if let v = host { o.host = v }
    if let v = agentDir { o.agentDir = v }
    if let v = autoRestart { o.autoRestart = v }
    if let v = autoConfirmRestart { o.autoConfirmRestart = v }
    if let v = startSessionOnLaunch { o.startSessionOnLaunch = v }
    if let v = openTerminalOnDialog { o.openTerminalOnDialog = v }
    if let v = relayUrl { o.relayUrl = v }
    if let v = talosAppCommand { o.talosAppCommand = v }
    if notifyThreadSet { o.notifyThread = notifyThread }
    if let v = keepAwakeOnAC { o.keepAwakeOnAC = v }
    if let v = openWindowAtLaunch { o.openWindowAtLaunch = v }
    if let v = hotkey { o.hotkeys.compose = v }
    return o
  }

  // MARK: storage

  private struct Wire: Codable {
    var host: String?
    var agent_dir: String?
    var auto_restart: Bool?
    var auto_confirm_restart: Bool?
    var start_session_on_launch: Bool?
    var open_terminal_on_dialog: Bool?
    var relay_url: String?
    var talos_app_command: [String]?
    var notify_thread: String?
    var notify_thread_set: Bool?
    var keep_awake_on_ac: Bool?
    var open_window_at_launch: Bool?
  }

  /// What the store holds, or nil when nothing is held. A damaged blob is ignored (it is a convenience, never a reason to
  /// fail a launch); a value of a kind this build doesn't know costs that one value only.
  public static func load(_ store: SettingsStore) -> PreSetup? {
    var p = PreSetup()
    var any = false
    if let d = store.data(forKey: key), let w = try? JSONDecoder().decode(Wire.self, from: d) {
      p.host = w.host.flatMap(DesktopConfig.Host.init(rawValue:))
      p.agentDir = w.agent_dir
      p.autoRestart = w.auto_restart
      p.autoConfirmRestart = w.auto_confirm_restart
      p.startSessionOnLaunch = w.start_session_on_launch
      p.openTerminalOnDialog = w.open_terminal_on_dialog
      p.relayUrl = w.relay_url
      p.talosAppCommand = w.talos_app_command
      p.notifyThread = w.notify_thread
      p.notifyThreadSet = w.notify_thread_set ?? false
      p.keepAwakeOnAC = w.keep_awake_on_ac
      p.openWindowAtLaunch = w.open_window_at_launch
      any = true
    }
    if let h = store.string(forKey: hotkeyKey), !h.isEmpty {
      p.hotkey = h
      any = true
    }
    return any ? p : nil
  }

  public func save(_ store: SettingsStore) {
    let w = Wire(
      host: host?.rawValue, agent_dir: agentDir, auto_restart: autoRestart, auto_confirm_restart: autoConfirmRestart,
      start_session_on_launch: startSessionOnLaunch, open_terminal_on_dialog: openTerminalOnDialog, relay_url: relayUrl,
      talos_app_command: talosAppCommand, notify_thread: notifyThread, notify_thread_set: notifyThreadSet, keep_awake_on_ac: keepAwakeOnAC,
      open_window_at_launch: openWindowAtLaunch)
    store.set(try? JSONEncoder().encode(w), forKey: Self.key)
  }

  public static func clear(_ store: SettingsStore) {
    store.set(nil, forKey: key)
    store.set(nil, forKey: hotkeyKey)
  }

  // MARK: the three moments

  /// Launch: the config the app starts with. With a file, the file is the truth and the held values are stale. Without one, the
  /// held values come back.
  public static func startupConfig(file: DesktopConfig?, store: SettingsStore) -> DesktopConfig {
    if let file { return file }
    return load(store)?.applied(to: .defaults) ?? .defaults
  }

  /// A Settings change while no file exists: hold what the config now says.
  public static func record(_ c: DesktopConfig, in store: SettingsStore) {
    var p = snapshot(of: c)
    p.hotkey = store.string(forKey: hotkeyKey)
    p.save(store)
  }

  /// Import or Adopt is about to create the file: the config it will write, with the held values laid over the current one.
  public static func merged(into c: DesktopConfig, store: SettingsStore) -> DesktopConfig {
    load(store)?.applied(to: c) ?? c
  }

  /// What Import or Adopt builds on: the held values are laid over `c` only while there is no file. Once `desktop.json` exists
  /// it is the truth, and a held value left from before (an older build never cleared the hotkey's) must not undo a later change.
  public static func base(for c: DesktopConfig, configured: Bool, store: SettingsStore) -> DesktopConfig {
    configured ? c : merged(into: c, store: store)
  }

  /// After the file was written. Held values are dropped only once the file exists: a failed write must not lose them.
  public static func finish(store: SettingsStore, fileExists: Bool) {
    if fileExists { clear(store) }
  }
}

/// A dictionary-backed store for tests and previews.
public final class MemoryStore: SettingsStore, @unchecked Sendable {
  private let lock = NSLock()
  private var items: [String: Data] = [:]
  public init() {}
  public func data(forKey key: String) -> Data? { lock.withLock { items[key] } }
  public func string(forKey key: String) -> String? { lock.withLock { items[key] }.flatMap { String(data: $0, encoding: .utf8) } }
  public func set(_ data: Data?, forKey key: String) { lock.withLock { items[key] = data } }
  public func setString(_ s: String?, forKey key: String) { set(s.map { Data($0.utf8) }, forKey: key) }
}
