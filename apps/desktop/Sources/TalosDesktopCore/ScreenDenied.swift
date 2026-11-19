import CoreGraphics
import Foundation

/// System processes that draw the lock screen, the screen saver or a password and authorisation prompt. An agent never sees,
/// drives or is offered them: they are never on the allowed list (`ScreenAllowed.entry`, `ScreenAllowStore`), the Mac measures no
/// consent request for them (`ScreenProtocol.notAllowed`), and the bridge makes no card for them (`SCREEN_DENIED_BUNDLES` in
/// apps/bridge/src/screen.ts, kept equal to this list by a test). Each id was read from this Mac's own bundles (`lsappinfo` and
/// every Info.plist), not guessed.
public enum ScreenDenied {
  public static let bundleIDs: [String] = [
    "com.apple.loginwindow",  // the lock screen and login
    "com.apple.SecurityAgent",  // password and authorisation dialogs
    "com.apple.ScreenSaver.Engine",  // the screen saver
    "com.apple.LockScreen",  // the lock screen of a remote screen-sharing session
    "com.apple.LocalAuthentication.UIAgent",  // Touch ID and password prompts (coreautha)
    "com.apple.coreautha",  // same prompt, the name it is also known by
    "com.apple.UserNotificationCenter",  // system alerts that ask the owner a question
    "com.apple.NetAuthAgent",  // network share credential prompts
    "com.apple.EscrowSecurityAlert",  // recovery key and escrow alerts
    "com.apple.security.Keychain-Circle-Notification",  // approving another device for the keychain
    "com.apple.mcx.MCXDiskAuthorization",  // managed disk authorisation
    "com.apple.coreservices.uiagent",  // the "Open?" prompt for a downloaded app (Gatekeeper)
    "com.apple.accessibility.universalAccessAuthWarn",  // "control this computer" Accessibility prompt
    "com.apple.UniversalAccessControl",  // the privacy (TCC) permission UI
    "com.apple.AskPermissionUI",  // Ask to Buy and Screen Time permission requests
    "com.apple.AOSAlertManager",  // Apple ID and Find My alerts, including a remote lock
    "com.apple.IOUIAgent",  // "allow this accessory to connect" prompts
    "com.apple.FileSystemUIAgent",  // password prompts for encrypted volumes
    "com.apple.frameworks.diskimages.diuiagent",  // disk image password and licence prompts
  ]

  /// The ids that are the lock screen or the screen saver themselves: in front, the Mac counts as locked.
  public static let lockSurfaces: Set<String> = [
    "com.apple.loginwindow", "com.apple.ScreenSaver.Engine", "com.apple.LockScreen",
  ]

  public static func isLockSurface(_ bundleID: String?) -> Bool {
    guard let b = bundleID?.trimmingCharacters(in: .whitespacesAndNewlines).lowercased() else { return false }
    return lockSurfaces.contains { $0.lowercased() == b }
  }

  private static let lowered = Set(bundleIDs.map { $0.lowercased() })

  /// True for one of the ids above, whatever its case or surrounding spaces. Nil and empty are not denied here (they are never
  /// allowed either: an entry needs an id).
  public static func contains(_ bundleID: String?) -> Bool {
    guard let b = bundleID?.trimmingCharacters(in: .whitespacesAndNewlines).lowercased(), !b.isEmpty else { return false }
    return lowered.contains(b)
  }
}

/// Whether the Mac's screen is locked, from the console session's own dictionary. Fails closed: a session that cannot be read, is not
/// on the console, has not finished logging in, or says it is locked counts as locked.
public enum ScreenLockState {
  /// `CGSessionCopyCurrentDictionary()`'s answer, or a fake. Keys as macOS 26 prints them (read on this Mac while locked).
  public static func isLocked(session: [String: Any]?) -> Bool {
    guard let s = session else { return true }
    func flag(_ key: String) -> Bool? { (s[key] as? NSNumber)?.boolValue }
    if flag("CGSSessionScreenIsLocked") == true { return true }
    guard let onConsole = flag("kCGSSessionOnConsoleKey"), onConsole else { return true }
    if flag("kCGSessionLoginDoneKey") == false { return true }
    return false
  }

  public static func liveIsLocked() -> Bool {
    isLocked(session: CGSessionCopyCurrentDictionary() as? [String: Any])
  }
}
