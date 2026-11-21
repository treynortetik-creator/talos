import Foundation

/// The list of phones and Macs that can reach the agent is a page in the Talos window (the web app's account settings, its
/// devices part). The Mac settings row opens it there, inside the window, on the Talos server's own host; it never goes to the browser.
public enum DevicesPage {
  /// The in-app path and part. It must stay a path the window accepts (`AppPath`), and the web app must have a page there.
  public static let path = "/settings/account#devices"
  public static let rowTitle = "See and remove your devices"
  public static let rowButton = "Open"
  /// Shown under the row when there is no Talos server address to open it on.
  public static let needsServer = "Set up the Talos server first"

  public enum Plan: Equatable, Sendable {
    case open(path: String)
    case disabled(reason: String)
  }

  public static func plan(hasRelay: Bool) -> Plan {
    hasRelay ? .open(path: path) : .disabled(reason: needsServer)
  }

  /// Where the window ends up: the configured Talos server's origin plus the path and part.
  public static func url(relay: RelayOrigin) -> URL? {
    var c = URLComponents(url: relay.url, resolvingAgainstBaseURL: false)
    c?.path = "/settings/account"
    c?.fragment = "devices"
    return c?.url
  }
}
