import AppKit
import Foundation
import TalosDesktopCore
import TalosSupervisor

/// The first-launch question "Move Talos to your Applications folder?" (the one most Mac apps ask), asked BEFORE the supervisor starts
/// (from `TalosApp.init`), only for a release build that runs from a temporary copy or from outside ~/Applications. A yes copies the
/// app into ~/Applications, clears the download flag on the copy, opens it and quits this one; nothing of Talos is running yet, so the
/// quit stops nothing. A Talos that is already running is brought forward instead and this one quits without asking. Every failure and
/// every "left alone" is said in an alert, never skipped.
@MainActor
enum AppMovePrompt {
  static let declinedKey = "app.moveToApplications.declined"

  /// Whether a process other than this one runs an app with this bundle id.
  static func otherInstance() -> NSRunningApplication? {
    NSRunningApplication.runningApplications(withBundleIdentifier: AppMover.bundleID).first { $0.processIdentifier != ProcessInfo.processInfo.processIdentifier }
  }

  /// The signing Team ID of a bundle (`codesign -dv`), nil when unsigned or unknown.
  nonisolated static func team(of path: String) -> String? {
    let r = ProcessRunner.run(["/usr/bin/codesign", "-dv", "--verbose=2", path], timeout: 20)
    for line in (r.err + "\n" + r.out).split(separator: "\n") where line.hasPrefix("TeamIdentifier=") {
      let t = line.dropFirst("TeamIdentifier=".count).trimmingCharacters(in: .whitespaces)
      return t.isEmpty || t == "not set" ? nil : t
    }
    return nil
  }

  /// Whether the app at this path is running now, by its bundle URL (never by name).
  nonisolated static func isRunning(path: String) -> Bool {
    let url = URL(fileURLWithPath: path).resolvingSymlinksInPath()
    return NSWorkspace.shared.runningApplications.contains { $0.bundleURL?.resolvingSymlinksInPath() == url }
  }

  @discardableResult
  static func runIfNeeded(
    bundlePath: String = Bundle.main.bundlePath, home: String = NSHomeDirectory(),
    isRelease: Bool = (Bundle.main.object(forInfoDictionaryKey: "TalosSourceCommit") as? String).map { !$0.isEmpty } ?? false,
    defaults: UserDefaults = .standard, otherRunning: (() -> NSRunningApplication?)? = nil,
    ask: ((AppLocation.Reason) -> Bool)? = nil, move: ((String) -> AppMover.Outcome)? = nil, relaunch: ((String) -> Void)? = nil,
    report: ((String, String) -> Void)? = nil
  ) -> AppMoveOffer.Result {
    let other = (otherRunning ?? { otherInstance() })()
    return AppMoveOffer.run(
      bundlePath: bundlePath, home: home, isRelease: isRelease, declinedBefore: defaults.bool(forKey: declinedKey),
      otherInstanceRunning: other != nil,
      ask: ask ?? { askUser($0) },
      move: move ?? {
        AppMover.move(
          from: $0, home: home,
          seam: AppMover.liveSeam(runTool: { ProcessRunner.run($0, timeout: 120).ok }, team: { team(of: $0) }, isRunning: { isRunning(path: $0) }))
      },
      relaunch: relaunch ?? { openAndQuit($0) },
      activateOther: { _ = other?.activate(options: [.activateAllWindows]); if otherRunning == nil { quitNow() } },
      rememberDecline: { defaults.set(true, forKey: declinedKey) },
      report: report ?? { showAlert(title: $0, message: $1) },
      recordMoved: {
        // what the first launch from ~/Applications needs to tidy the downloaded copy (DownloadTidyPrompt)
        if let f = BundleFacts.read(path: bundlePath, team: nil, running: true) { MoveMarker.record(f, defaults: defaults) }
      })
  }

  private static func askUser(_ reason: AppLocation.Reason) -> Bool {
    NSApplication.shared.activate(ignoringOtherApps: true)
    let a = NSAlert()
    a.messageText = AppMoveCopy.title
    a.informativeText = AppMoveCopy.body(reason)
    a.addButton(withTitle: AppMoveCopy.move)
    a.addButton(withTitle: AppMoveCopy.doNotMove)
    return a.runModal() == .alertFirstButtonReturn
  }

  private static func showAlert(title: String, message: String) {
    NSApplication.shared.activate(ignoringOtherApps: true)
    let a = NSAlert()
    a.alertStyle = .warning
    a.messageText = title
    a.informativeText = message
    a.runModal()
  }

  /// Runs before the supervisor, the web server and every window exist: leaving now stops nothing.
  private static func quitNow() { exit(0) }

  /// The moved copy opens after this app has quit (a second copy never runs beside the first).
  private static func openAndQuit(_ dest: String) {
    let p = Process()
    p.executableURL = URL(fileURLWithPath: "/bin/sh")
    p.arguments = AppRelaunch.arguments(pid: ProcessInfo.processInfo.processIdentifier, app: dest)
    p.standardInput = FileHandle.nullDevice
    p.standardOutput = FileHandle.nullDevice
    p.standardError = FileHandle.nullDevice
    do {
      try p.run()
      quitNow()
    } catch {
      showAlert(title: AppMoveCopy.failedTitle, message: AppMoveCopy.failed("Talos copied itself to \(dest) but couldn't open it."))
    }
  }
}
