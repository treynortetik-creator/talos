import AppKit
import Foundation
import TalosDesktopCore

/// Arms `RelaunchWatchdog` while the owner is granting permissions, so a "Quit & Reopen" from macOS that does not reopen
/// still brings Talos back. The helper is NOT cancelled by `willTerminate`: macOS's Quit & Reopen asks Talos to quit
/// politely, which fires that notification just like any other graceful quit, so cancelling there would kill the very rescue
/// this exists for. It is cancelled only by a quit the owner asked for (`deliberateQuit`: Talos's own Quit items, a Dock or
/// Activity Monitor quit), when the Permissions view closes, or by its own 10-minute limit.
@MainActor
final class RelaunchGuard {
  static let shared = RelaunchGuard()
  private var helper: Process?
  /// Tests replace the path and opener; the app uses its own bundle and `open`.
  var appPath = Bundle.main.bundlePath
  var opener = "/usr/bin/open"
  var settle = "2"

  var isArmed: Bool { helper?.isRunning == true }

  func arm() {
    guard !isArmed else { return }
    helper = RelaunchWatchdog.start(app: appPath, settleSeconds: settle, opener: opener)
  }

  /// The grant is over, or the owner is quitting: Talos must stay closed if it goes away.
  func disarm() {
    helper?.terminate()
    helper = nil
  }

  /// A quit the owner asked for.
  func deliberateQuit() { disarm() }
}
