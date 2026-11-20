import Foundation

/// `talos-app update` asks the running Mac app to look for a new version now by writing
/// `$TALOS_APP_HOME/auto-update/check-now.json`: `{"v":1,"action":"check","ts":"<ISO time>"}`. The app trusts the file only for what it
/// is, a request to do the check it would do anyway: it is small, a real file in the app's own folder, one known shape, and recent.
/// Anything else is ignored (and removed, so it is not read again).
public enum CheckNowRequest {
  public static let fileName = "check-now.json"
  /// A real request is a few dozen bytes.
  public static let maxBytes = 1024
  /// A request older than this was left behind (the app was not running, the Mac slept): it is not a request for now.
  public static let maxAge: Double = 10 * 60
  /// A time ahead of this clock by more than this is wrong, not early.
  public static let maxAhead: Double = 60

  public enum Reason: String, Equatable, Sendable {
    case tooBig, notAnObject, wrongVersion, wrongAction, noTime, stale, ahead
  }
  public enum Verdict: Equatable, Sendable {
    case check
    case ignore(Reason)
  }

  /// `now` in wall seconds. `ts` is an ISO-8601 string, or a number of seconds or of milliseconds since 1970.
  public static func evaluate(_ data: Data, now: Double) -> Verdict {
    guard data.count <= maxBytes else { return .ignore(.tooBig) }
    guard let o = (try? JSONSerialization.jsonObject(with: data)) as? [String: Any] else { return .ignore(.notAnObject) }
    guard let v = o["v"] as? NSNumber, CFGetTypeID(v) != CFBooleanGetTypeID(), v.intValue == 1, v.doubleValue == 1 else {
      return .ignore(.wrongVersion)
    }
    guard let action = o["action"] as? String, action == "check" else { return .ignore(.wrongAction) }
    guard let at = time(o["ts"]) else { return .ignore(.noTime) }
    if at > now + maxAhead { return .ignore(.ahead) }
    if now - at > maxAge { return .ignore(.stale) }
    return .check
  }

  static func time(_ raw: Any?) -> Double? {
    if let s = raw as? String { return ISOTime.parse(s) }
    guard let n = raw as? NSNumber, CFGetTypeID(n) != CFBooleanGetTypeID() else { return nil }
    let x = n.doubleValue
    guard x.isFinite, x > 0 else { return nil }
    return x > 1e11 ? x / 1000 : x
  }
}
