import Foundation

/// Talos Help is one page inside the Talos app (the web app's `/help`), written once. The Mac's Help menu item, the menu bar
/// item and the setup checklist all open that page in the Talos window; there is no second copy of the text on the Mac.
public enum HelpPage {
  /// The in-app path. It must stay a path the window accepts (`AppPath`), and the web app must have a page there.
  public static let path = "/help"

  public enum Plan: Equatable, Sendable {
    /// Show the Talos window and send it to the page.
    case showPage(path: String)
    /// There is no relay address, so there is no page to show: say so and open the place that sets one.
    case needsRelay(notice: String)
  }

  public static func plan(hasRelay: Bool) -> Plan {
    hasRelay ? .showPage(path: path) : .needsRelay(notice: noRelay)
  }

  /// Without a relay address the Talos window has nothing to load, and Help is a page in it.
  public static let noRelay =
    "Help is a page in the Talos window, and the window needs your relay address first. Set one in \(MacSettingsText.connectionPath)."
}
