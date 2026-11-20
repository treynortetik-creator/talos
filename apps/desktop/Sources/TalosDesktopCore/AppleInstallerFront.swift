import Foundation

/// The app that can be asked to come to the front by its bundle id. The real one (`NSRunningApplication`) lives in the app; tests hand
/// in a fake that is only "running" when they say so.
public protocol AppActivating: Sendable {
  /// Whether an app with this bundle id is running now.
  func isRunning(bundleID: String) -> Bool
  /// Brings that app's windows to the front. false: it is not running (nothing was done).
  func activate(bundleID: String) -> Bool
}

/// macOS puts its "Install Command Line Developer Tools" window up from a helper app of its own, and it opens BEHIND a window that is
/// already in front (first real run, 2026-11-20: only a bouncing Dock icon showed it). Talos brings that helper forward itself: right
/// after it asks for the install, and again when the owner says "I don't see Apple's window".
public enum AppleInstallerFront {
  public static let bundleID = "com.apple.dt.CommandLineTools.installondemand"

  /// Looks for Apple's installer and brings it forward, trying again for a few seconds because it takes a moment to appear after
  /// `xcode-select --install`. true: it was found and activated; false: it never appeared (the caller says so, it is not an error here).
  @discardableResult
  public static func bringForward(
    _ apps: AppActivating, attempts: Int = 12, interval: TimeInterval = 0.5,
    sleep: @Sendable (TimeInterval) async -> Void = { try? await Task.sleep(nanoseconds: UInt64($0 * 1_000_000_000)) }
  ) async -> Bool {
    for i in 0..<max(1, attempts) {
      if Task.isCancelled { return false }
      if apps.activate(bundleID: bundleID) { return true }
      if i < attempts - 1 { await sleep(interval) }
    }
    return false
  }

  public static func isRunning(_ apps: AppActivating) -> Bool { apps.isRunning(bundleID: bundleID) }
}

/// Whether Talos is running from a place that breaks updates and start-at-login, and why.
///
/// Verified in this app: a translocated copy (`.../AppTranslocation/<id>/d/Talos.app`, what macOS runs when a downloaded app was never
/// moved) cannot be updated (`AutoUpdater` refuses: the swap would land in the folder the temporary copy came from) and a login item
/// registered from it points at the temporary path. The updater also refuses /Applications (`AutoUpdater.swift:605`, install.sh:155
/// refuses system folders), so the one place that works is the owner's own ~/Applications, which is also where install.sh puts the app.
/// The agent's clone path does not depend on where the app runs from.
public enum AppLocation {
  public enum Reason: Equatable, Sendable {
    /// macOS runs it from a temporary copy.
    case temporary
    /// In /Applications (or below it): the updater will not install there.
    case systemApplications
    /// Anywhere else: Downloads, a disk image, the Desktop.
    case elsewhere
  }

  /// The one folder Talos moves itself into and updates in: ~/Applications.
  public static func destinationFolder(home: String) -> String { ((home as NSString).appendingPathComponent("Applications") as NSString).standardizingPath }

  /// A place the updater can work in: the owner's ~/Applications (one folder deep is fine).
  public static func isInstalledPlace(_ bundlePath: String, home: String) -> Bool {
    (bundlePath as NSString).standardizingPath.hasPrefix(destinationFolder(home: home) + "/")
  }

  /// Why the "move" question is asked, nil when it is not: a real app bundle of a stamped release that is translocated, in
  /// /Applications, or outside ~/Applications. A development run is never asked.
  public static func moveReason(bundlePath: String, home: String, isRelease: Bool) -> Reason? {
    guard isRelease, bundlePath.hasSuffix(".app") else { return nil }
    if AutoUpdate.isTranslocated(bundlePath) { return .temporary }
    if isInstalledPlace(bundlePath, home: home) { return nil }
    let p = (bundlePath as NSString).standardizingPath
    return p.hasPrefix("/Applications/") ? .systemApplications : .elsewhere
  }

  public static func shouldOfferMove(bundlePath: String, home: String, isRelease: Bool) -> Bool {
    moveReason(bundlePath: bundlePath, home: home, isRelease: isRelease) != nil
  }
}
