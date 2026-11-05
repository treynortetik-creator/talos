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

  /// Strict about shape, tolerant of extra fields. A torn or half-written file (invalid JSON) is nil, never a guess.
  public static func decode(_ data: Data) -> BridgeStatus? {
    guard let o = (try? JSONSerialization.jsonObject(with: data)) as? [String: Any], JSONValue.int(o["v"]) == 1,
      let pid = JSONValue.int(o["pid"]), pid > 0, pid < Int(Int32.max), let m = o["mode"] as? String,
      let mode = Mode(rawValue: m), let relay = o["relay"] as? [String: Any],
      let connected = JSONValue.bool(relay["connected"]), let ua = o["updated_at"] as? String,
      let when = isoDate(ua)
    else { return nil }
    return BridgeStatus(
      pid: Int32(pid), mode: mode, relayConnected: connected, lastConnectAt: relay["last_connect_at"] as? String,
      lastCloseCode: JSONValue.int(relay["last_close_code"]), queueDepth: JSONValue.int(o["queue_depth"]) ?? 0,
      permissionRelay: JSONValue.bool(o["permission_relay"]) ?? false, updatedAt: when)
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
