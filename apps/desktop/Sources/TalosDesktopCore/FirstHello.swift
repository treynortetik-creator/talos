import Foundation

/// The agent's first hello (the Hello screen of the new setup), asked for from the bridge, never typed into a chat. When setup ends the
/// app writes one small request file in the Talos home, `onboarding/hello.json`, which only the owner's user can write, and the bridge
/// (apps/bridge/src/onboarding-hello.ts) makes the hello from its own fixed template: a quiet "Setting up your agent…" row in the chat, and
/// the agent greets as its first turn. The file chooses only the phone variant (`connected` or `not_connected`); it carries no text, so
/// nothing here can change what the agent is told. The bridge makes it once per install and never after the owner wrote in the chat.
///
/// The suggestion chips of the mock are lines in the greeting for the owner to answer with: the chat has no chip control yet.
public enum FirstHello {
  public static let folder = "onboarding"
  public static let fileName = "hello.json"

  public static func requestPath(talosHome: String) -> String { talosHome + "/" + folder + "/" + fileName }

  /// `{"v":1,"action":"hello","phone":"connected"|"not_connected","ts":"<ISO time>"}`. Nothing else.
  public static func requestBody(phoneConnected: Bool, now: Date) -> Data {
    let ts = ISOTime.string(now.timeIntervalSince1970)
    let phone = phoneConnected ? "connected" : "not_connected"
    return Data("{\"v\":1,\"action\":\"hello\",\"phone\":\"\(phone)\",\"ts\":\"\(ts)\"}".utf8)
  }

  /// Writes the request: the folder 0700, the file 0600, whole or not at all (a temporary file, then a rename). false: it could not be written.
  @discardableResult
  public static func writeRequest(talosHome: String, phoneConnected: Bool, now: Date = Date()) -> Bool {
    let dir = talosHome + "/" + folder
    let fm = FileManager.default
    do {
      try fm.createDirectory(atPath: dir, withIntermediateDirectories: true, attributes: [.posixPermissions: 0o700])
      let tmp = dir + "/.hello-" + UUID().uuidString
      guard fm.createFile(atPath: tmp, contents: requestBody(phoneConnected: phoneConnected, now: now), attributes: [.posixPermissions: 0o600])
      else { return false }
      if rename(tmp, requestPath(talosHome: talosHome)) != 0 {
        try? fm.removeItem(atPath: tmp)
        return false
      }
      return true
    } catch { return false }
  }
}

/// "Setup is still going": written when the agent's folder is made, removed when the owner reaches the end. A Mac whose setup was
/// cut short (the app quit after the folder was made) opens the setup again; a Mac that never had the marker is an existing install
/// and never sees it.
public enum OnboardingMarker {
  public static func path(home: String) -> String { AutoSetup.appFolder(home: home) + "/setup-in-progress" }

  public static func isPending(home: String, fileExists: (String) -> Bool = { FileManager.default.fileExists(atPath: $0) }) -> Bool {
    fileExists(path(home: home))
  }

  /// The setup screens show when there is no agent yet, or when this Mac's own setup was cut short.
  public static func isNeeded(configured: Bool, pending: Bool) -> Bool { OnboardingFlow.isNeeded(configured: configured) || pending }

  @discardableResult
  public static func set(home: String) -> Bool {
    let p = path(home: home)
    try? FileManager.default.createDirectory(atPath: (p as NSString).deletingLastPathComponent, withIntermediateDirectories: true)
    return FileManager.default.createFile(atPath: p, contents: Data())
  }

  public static func clear(home: String) { try? FileManager.default.removeItem(atPath: path(home: home)) }
}

/// Keeps the hello pending until the bridge has taken it. The request file is read by the bridge only while it is up, and it ignores a
/// request older than ten minutes, so "write it once" is not enough: the app keeps a pending note (`hello-pending`, with the phone
/// variant) and, each time the agent's connection is up, writes a fresh request. The request file being gone again means the bridge took
/// it (made the hello, or knew it was already made or not wanted): then the note goes. One hello per install is the bridge's rule (kv);
/// this only makes sure it is asked for until answered.
public enum HelloDelivery {
  public static func pendingPath(home: String) -> String { AutoSetup.appFolder(home: home) + "/hello-pending" }

  public struct Pending: Equatable, Sendable {
    public var phoneConnected: Bool
    /// When the request file was last written (seconds since 1970); nil: not written yet.
    public var writtenAt: Double?
    public init(phoneConnected: Bool, writtenAt: Double? = nil) {
      self.phoneConnected = phoneConnected
      self.writtenAt = writtenAt
    }
  }

  public enum Action: Equatable, Sendable {
    case nothing
    /// Write (or write again) the request file.
    case write(phoneConnected: Bool)
    /// The bridge took the request: the note can go.
    case done
  }

  /// Older than this and the bridge would ignore the file: write a new one.
  public static let rewriteAfter: Double = 8 * 60

  /// What to do now. `bridgeUp`: the agent's connection is live. `requestExists`: the request file is on disk.
  public static func next(_ p: Pending?, bridgeUp: Bool, requestExists: Bool, now: Double) -> Action {
    guard let p else { return .nothing }
    if let at = p.writtenAt {
      if !requestExists { return .done }
      if now - at > rewriteAfter, bridgeUp { return .write(phoneConnected: p.phoneConnected) }
      return .nothing
    }
    return bridgeUp ? .write(phoneConnected: p.phoneConnected) : .nothing
  }

  public static func read(home: String) -> Pending? {
    guard let d = FileManager.default.contents(atPath: pendingPath(home: home)),
      let o = (try? JSONSerialization.jsonObject(with: d)) as? [String: Any], let phone = o["phone"] as? String
    else { return nil }
    return Pending(phoneConnected: phone == "connected", writtenAt: (o["written_at"] as? NSNumber)?.doubleValue)
  }

  public static func save(_ p: Pending, home: String) {
    let path = pendingPath(home: home)
    try? FileManager.default.createDirectory(atPath: (path as NSString).deletingLastPathComponent, withIntermediateDirectories: true)
    var o: [String: Any] = ["phone": p.phoneConnected ? "connected" : "not_connected"]
    if let w = p.writtenAt { o["written_at"] = w }
    if let d = try? JSONSerialization.data(withJSONObject: o) { FileManager.default.createFile(atPath: path, contents: d) }
  }

  public static func clear(home: String) { try? FileManager.default.removeItem(atPath: pendingPath(home: home)) }

  /// One look: does what `next` says. `talosHome`: where the bridge's home is. Returns the action it took.
  @discardableResult
  public static func tick(home: String, talosHome: String, bridgeUp: Bool, now: Date = Date()) -> Action {
    let exists = FileManager.default.fileExists(atPath: FirstHello.requestPath(talosHome: talosHome))
    let pending = read(home: home)
    let a = next(pending, bridgeUp: bridgeUp, requestExists: exists, now: now.timeIntervalSince1970)
    switch a {
    case .write(let phone):
      if FirstHello.writeRequest(talosHome: talosHome, phoneConnected: phone, now: now) {
        save(Pending(phoneConnected: phone, writtenAt: now.timeIntervalSince1970), home: home)
      }
    case .done: clear(home: home)
    case .nothing: break
    }
    return a
  }
}

/// When the setup screens open at launch, and the marker's life: a Mac that finished (or never started) setup is decided by whether
/// it is set up; the in-progress marker only matters for a setup the new screens themselves left half done.
public enum OnboardingLaunch {
  /// Open the setup screens at launch? `shownThisRun`: they already opened since the app started.
  public static func shouldOpen(configured: Bool, pending: Bool, shownThisRun: Bool, dismissed: Bool = false) -> Bool {
    // the owner closed the screens on purpose: not again by itself (the menu's Set up Talos… still opens them)
    if shownThisRun || dismissed { return false }
    return configured ? pending : true
  }

  /// A Mac became set up by some other way (the Advanced route, an adopted agent) while the new screens were not running: the marker is
  /// stale, and goes. While they run, configured turning true is their own doing and the marker stays until they finish.
  public static func settle(configured: Bool, flowActive: Bool, home: String) {
    if configured, !flowActive { OnboardingMarker.clear(home: home) }
  }
}

/// "I closed the setup on purpose": remembered so the launch does not open it again by itself. A crash or a quit leaves nothing here, so the
/// next launch still opens a setup that was cut short. Opening the screens again (the menu) forgets it.
public enum OnboardingDismissal {
  public static func path(home: String) -> String { AutoSetup.appFolder(home: home) + "/setup-dismissed" }
  public static func isSet(home: String) -> Bool { FileManager.default.fileExists(atPath: path(home: home)) }
  public static func set(home: String) {
    try? FileManager.default.createDirectory(atPath: (path(home: home) as NSString).deletingLastPathComponent, withIntermediateDirectories: true)
    FileManager.default.createFile(atPath: path(home: home), contents: Data())
  }
  public static func clear(home: String) { try? FileManager.default.removeItem(atPath: path(home: home)) }
}
