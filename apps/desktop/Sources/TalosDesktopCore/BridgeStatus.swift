import Foundation

/// `$TALOS_APP_HOME/status.json`, written by the live bridge (DESKTOP-SPEC 6.2). Content-free by design: pid, mode and
/// relay connection, never message text, ids of content or tokens. The bridge half (the writer) lands after WP-V6; until
/// the file exists every reader treats it as "unknown", not "down".
public struct BridgeStatus: Equatable, Sendable {
  public enum Mode: String, Sendable { case live, headless, superseded }
  public var pid: Int32
  public var mode: Mode
  public var relayConnected: Bool
  public var lastConnectAt: String?
  public var lastCloseCode: Int?
  public var queueDepth: Int
  public var permissionRelay: Bool
  public var updatedAt: Date
  /// `unseen_oldest_at`: when the session was first told about an owner message with no tool call from it since; nil for none,
  /// and for an older bridge that never writes it (which says nothing).
  public var unseenOldestAt: Date? = nil
  /// `governor`: the usage governor now (`ok`, `paused`, `park_all`, `off`, `unknown`), which the restart-on-update queue holds on. nil
  /// from a bridge that predates it or wrote null; a value this build does not know reads as `unknown`.
  public var governor: String? = nil
  /// `bridge_commit`: the commit the running bridge started from (D61); nil when it cannot tell.
  public var bridgeCommit: String? = nil
  /// `last_owner_at`: when the owner's newest message arrived (as the bridge got it); nil for none, or from an older bridge. Only a
  /// change is read (the app updater's postponement), never the time against this Mac's clock.
  public var lastOwnerAt: String? = nil
  /// `main_resend`: this bridge answers the Mac's `main-resend.json` request (`MainWatch`'s unstick). false from an older bridge: the Mac
  /// then presses nothing, since it could not send the message again.
  public var mainResend: Bool = false
  /// `last_stop_at`: when the owner last stopped the agent from the app (a stop the mod carried out); nil for none, or from an older
  /// bridge. The missed-turn watch never re-sends a message the owner stopped after it was delivered.
  public var lastStopAt: Date? = nil
  /// `started_at`: when this bridge process started; nil when unreadable.
  public var startedAt: Date? = nil
  public static let governorStates: Set<String> = ["ok", "paused", "park_all", "off", "unknown"]

  /// Strict about shape, tolerant of extra fields. A torn or half-written file (invalid JSON) is nil, never a guess.
  public static func decode(_ data: Data) -> BridgeStatus? {
    guard let o = (try? JSONSerialization.jsonObject(with: data)) as? [String: Any], JSONValue.int(o["v"]) == 1,
      let pid = JSONValue.int(o["pid"]), pid > 0, pid < Int(Int32.max), let m = o["mode"] as? String,
      let mode = Mode(rawValue: m), let relay = o["relay"] as? [String: Any],
      let connected = JSONValue.bool(relay["connected"]), let ua = o["updated_at"] as? String,
      let when = isoDate(ua)
    else { return nil }
    var status = BridgeStatus(
      pid: Int32(pid), mode: mode, relayConnected: connected, lastConnectAt: relay["last_connect_at"] as? String,
      lastCloseCode: JSONValue.int(relay["last_close_code"]), queueDepth: JSONValue.int(o["queue_depth"]) ?? 0,
      permissionRelay: JSONValue.bool(o["permission_relay"]) ?? false, updatedAt: when,
      unseenOldestAt: (o["unseen_oldest_at"] as? String).flatMap(isoDate),
      governor: (o["governor"] as? String).map { governorStates.contains($0) ? $0 : "unknown" },
      bridgeCommit: (o["bridge_commit"] as? String).flatMap { c in
        c.count <= 64 && c.unicodeScalars.allSatisfy({ CharacterSet.alphanumerics.contains($0) && $0.isASCII }) ? c : nil },
      lastOwnerAt: (o["last_owner_at"] as? String).flatMap { isoDate($0) == nil || $0.count > 64 ? nil : $0 },
      startedAt: (o["started_at"] as? String).flatMap(isoDate))
    status.mainResend = JSONValue.bool(o["main_resend"]) == true
    status.lastStopAt = (o["last_stop_at"] as? String).flatMap(isoDate)
    return status
  }

  static func isoDate(_ s: String) -> Date? {
    let f = ISO8601DateFormatter()
    f.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
    if let d = f.date(from: s) { return d }
    f.formatOptions = [.withInternetDateTime]
    return f.date(from: s)
  }

  public enum Health: Equatable, Sendable {
    case healthy
    /// updated_at older than 45 s while the pid is alive.
    case stale
    /// The pid isn't alive: a dead bridge leaves a fresh-looking file, so the pid check comes first.
    case dead
    case superseded
    case headless
    case relayDown
  }

  /// Healthy = `updated_at` < 45 s old, pid alive, `mode: live`, `relay.connected` (6.2). A dead pid beats a fresh file.
  public func health(now: Date, pidAlive: (Int32) -> Bool) -> Health {
    guard pidAlive(pid) else { return .dead }
    if mode == .superseded { return .superseded }
    // Fresh means strictly under 45 s old; a stamp from the future is not fresh either (a skewed or forged file).
    let age = now.timeIntervalSince(updatedAt)
    if age >= 45 || age < -5 { return .stale }
    if mode == .headless { return .headless }
    return relayConnected ? .healthy : .relayDown
  }
}

/// `GET <relay>/healthz` → `{ok: true}` (60 s poll).
public enum RelayHealth {
  public static func ok(status: Int, body: Data) -> Bool {
    guard status == 200, let o = (try? JSONSerialization.jsonObject(with: body)) as? [String: Any] else { return false }
    return JSONValue.bool(o["ok"]) == true
  }
}
