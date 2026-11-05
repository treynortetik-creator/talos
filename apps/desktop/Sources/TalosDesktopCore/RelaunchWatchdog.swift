import Foundation

/// macOS asks for "Quit & Reopen" after some permission grants (Full Disk Access, Files and Folders). For a menu-bar app
/// that is not installed the usual way the Reopen half does not always happen, and Talos simply vanished (first real Mac
/// run, 2026-11-01). While a grant is under way Talos starts one small helper that waits for Talos to die and then opens it
/// again. A normal Quit cancels the helper, so quitting on purpose never brings Talos back. It gives up after `maxSeconds`.
public enum RelaunchWatchdog {
  /// Passed to the reopened app so it can tell a rescue from a launch the owner asked for.
  public static let relaunchFlag = "--talos-relaunched"

  /// A rescue relaunch re-attaches to a live session but never cold-starts a new one.
  public static func isRelaunch(_ arguments: [String]) -> Bool { arguments.contains(relaunchFlag) }

  /// Who asked Talos to quit. macOS's own Quit & Reopen asks politely from a system process, like a Dock Quit does from
  /// the Dock, so a polite quit alone proves nothing. Only a quit from the Dock or Activity Monitor is the owner getting
  /// rid of Talos; a quit from anywhere else (System Settings, the permission service, an unknown sender) leaves the helper
  /// armed so Talos comes back.
  public static func isDeliberateQuit(senderBundleId: String?) -> Bool {
    guard let id = senderBundleId else { return false }
    return ["com.apple.dock", "com.apple.ActivityMonitor"].contains(id)
  }

  public static let script = """
    pid="$1"; app="$2"; max="$3"; settle="$4"; opener="$5"; flag="$6"
    deadline=$(( $(date +%s) + max ))
    while kill -0 "$pid" 2>/dev/null; do
      [ "$(date +%s)" -ge "$deadline" ] && exit 0
      sleep 0.2
    done
    sleep "$settle"
    exec "$opener" "$app" --args "$flag"
    """

  public static func arguments(pid: Int32, app: String, maxSeconds: Int, settleSeconds: String, opener: String) -> [String] {
    ["-c", script, "talos-relaunch", String(pid), app, String(maxSeconds), settleSeconds, opener, relaunchFlag]
  }

  /// Starts the helper for `pid`. `app` must be an .app bundle path. The caller keeps the Process and ends it on a normal quit.
  public static func start(
    pid: Int32 = ProcessInfo.processInfo.processIdentifier, app: String, maxSeconds: Int = 600, settleSeconds: String = "2",
    opener: String = "/usr/bin/open"
  ) -> Process? {
    guard app.hasSuffix(".app") else { return nil }
    let p = Process()
    p.executableURL = URL(fileURLWithPath: "/bin/sh")
    p.arguments = arguments(pid: pid, app: app, maxSeconds: maxSeconds, settleSeconds: settleSeconds, opener: opener)
    p.standardInput = FileHandle.nullDevice
    p.standardOutput = FileHandle.nullDevice
    p.standardError = FileHandle.nullDevice
    do { try p.run() } catch { return nil }
    return p
  }
}
