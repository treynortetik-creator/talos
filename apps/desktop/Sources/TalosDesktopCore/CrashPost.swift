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

  /// Why a restart after a crash could not launch at all.
  public enum RestartBlock: String, Sendable {
    case channelsHeld = "channels_held"
    case claudeMissing = "claude_missing"
    case folderMissing = "folder_missing"

    var plain: String {
      switch self {
      case .channelsHeld: return "another session holds its channels"
      case .claudeMissing: return "claude was not found"
      case .folderMissing: return "its folder is missing"
      }
    }
  }

  /// The one line for the phone when the Mac gives up on a restart it could never launch. Not the crash-loop wording: the agent
  /// did not keep crashing, it could not be started again.
  public static func restartGaveUp(agentName: String?, why: RestartBlock, at time: String) -> String {
    "\(agentName ?? "The agent")'s session crashed and the Mac could not start it again (\(why.plain)). It gave up at \(time); open Talos on the Mac."
  }

  /// The one line for the phone when the app opens on a desktop.json it cannot read.
  public static let configUnreadable = "Talos can't read desktop.json; Main isn't started. Fix the file or open the menu"

  /// The one line for the phone when Main ended by itself with exit code 0 more often than the contract allows in an hour
  /// (`clean_exit_loop`) and the Mac stopped starting it again.
  public static func cleanExitLoop(at time: String) -> String {
    "Main keeps exiting cleanly, so the Mac left it stopped at \(time). Nothing was restored; open Talos on the Mac."
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
