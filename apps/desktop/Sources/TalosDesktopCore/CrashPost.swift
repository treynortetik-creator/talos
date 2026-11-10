import Foundation

/// The crash-loop post (DESKTOP-SPEC 4.3 step 5): `talos-app post <default thread> "<agent>'s session stopped restarting
/// at <time>"`. Reads only `agent.name` and `default_thread` from `$TALOS_APP_HOME/config.json`.
public enum CrashPost {
  public struct AppConfig: Equatable, Sendable {
    public var agentName: String?
    public var defaultThread: String?
  }

  public static func readAppConfig(_ data: Data?) -> AppConfig {
    guard let data, let o = (try? JSONSerialization.jsonObject(with: data)) as? [String: Any] else {
      return AppConfig(agentName: nil, defaultThread: nil)
    }
    let name = (o["agent"] as? [String: Any])?["name"] as? String
    return AppConfig(agentName: name, defaultThread: o["default_thread"] as? String)
  }

  public static func text(agentName: String?, at time: String) -> String {
    "\(agentName ?? "The agent")'s session stopped restarting at \(time)"
  }

  /// `HH:mm` in the Mac's time zone.
  public static func clockTime(_ date: Date, timeZone: TimeZone = .current) -> String {
    let f = DateFormatter()
    f.locale = Locale(identifier: "en_US_POSIX")
    f.timeZone = timeZone
    f.dateFormat = "HH:mm"
    return f.string(from: date)
  }
}
