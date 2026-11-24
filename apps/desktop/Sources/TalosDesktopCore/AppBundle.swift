import Foundation

/// Where the installed Talos.app is, handed to the agent the app starts as `TALOS_APP_BUNDLE`. The live bridge (the only writer of
/// status.json) copies it there as `app_path` after its own check, so `talos-app facts` can name the app without guessing. The app never
/// writes that file itself: two writers would race.
///
/// It is a runtime variable, set in `LoginShellEnv.build` on top of the login shell and desktop.json. It is not in desktop.json, so the
/// owner's confirmed launch (`launchFingerprint`, built from desktop.json alone) never sees it, and every thread session carries it in
/// its base environment as well as its own, so a session's launch hash (`LaunchSpecHash`: only what differs from the base) does not move.
public enum AppBundle {
  public static let envKey = "TALOS_APP_BUNDLE"

  /// This process's own app folder, or nil when it does not run from a `.app` (a test runner, a debug build, the CLI helper).
  public static let path: String? = resolve(bundlePath: Bundle.main.bundlePath)

  /// The real folder `bundlePath` names (links resolved), only when it is an absolute path ending in `.app` that exists as a folder.
  public static func resolve(bundlePath: String) -> String? {
    guard bundlePath.hasPrefix("/"), bundlePath.hasSuffix(".app") else { return nil }
    var isDir: ObjCBool = false
    guard FileManager.default.fileExists(atPath: bundlePath, isDirectory: &isDir), isDir.boolValue else { return nil }
    let real = URL(fileURLWithPath: bundlePath).resolvingSymlinksInPath().path
    return real.hasSuffix(".app") ? real : nil
  }
}
