import Foundation

/// What the Talos window can honestly say about itself (audit D46). Sign-in used to be "not signed in" whenever the page had
/// not said so, so a relay that was down at launch looked like a signed-out owner and the menu offered Sign in….
public enum PageState: Equatable, Sendable {
  case loading
  case signedIn
  case signedOut
  /// The page did not load (relay down, no network, web process gone). It retries by itself; Try now retries at once.
  case unreachable

  public static func resolve(pageReady: Bool, signedIn: Bool, loadFailed: Bool) -> PageState {
    if loadFailed { return .unreachable }
    if !pageReady { return signedIn ? .signedIn : .loading }
    return signedIn ? .signedIn : .signedOut
  }

  /// Sign in… is offered only when the page itself said the owner is signed out.
  public var offersSignIn: Bool { self == .signedOut }

  /// A main-frame answer that means the service is down rather than the page being wrong (502, 503, ...).
  public static func isServerDown(status: Int?) -> Bool { (status ?? 0) >= 500 }

  public static let unreachableLine = "Can't reach Talos, retrying…"

  /// Talos Help is a page on the server, so it cannot open while the server cannot be reached, and that is when it is wanted
  /// most. The window's failure screen carries these short lines instead (the full page still has one source: the web app).
  /// Every command and menu name here is checked against the real CLI and menu bar by the web app's Help test.
  public static let outageHelp = [
    "Talos Help is a page on your Talos server, so it cannot open until the server answers.",
    "Look at the Talos icon in the Mac menu bar: a head with a slash through it means the agent, the bridge or the server is down. Choose Start session if the agent is stopped.",
    "In Terminal, talos-app status and talos-app doctor say what is wrong, and talos-app logs shows the bridge log.",
  ]
}
