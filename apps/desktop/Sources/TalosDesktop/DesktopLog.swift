import Foundation

/// `~/Library/Logs/Talos/desktop.log`: one line per CHANGE of the Terminal screen's tab state, for finding out on an installed app
/// why the tabs are not there. Booleans and counts only: never a thread name, a thread id or any screen text.
enum DesktopLog {
  static let path = NSHomeDirectory() + "/Library/Logs/Talos/desktop.log"
  /// Tests: write somewhere else.
  nonisolated(unsafe) static var pathOverride: String?
  private static let lock = NSLock()
  nonisolated(unsafe) private static var lastTabs: String?

  /// Logs `terminal-tabs: <state>` when `state` differs from the last one logged. Nothing is thrown: a log that cannot be
  /// written must never get in the way of the screen.
  static func tabs(_ state: String) {
    lock.withLock {
      guard state != lastTabs else { return }
      lastTabs = state
      append("\(ISO8601DateFormatter().string(from: Date())) terminal-tabs: \(state)\n")
    }
  }

  static func resetForTest() { lock.withLock { lastTabs = nil } }

  private static func append(_ line: String) {
    let file = pathOverride ?? path
    try? FileManager.default.createDirectory(atPath: (file as NSString).deletingLastPathComponent, withIntermediateDirectories: true)
    let fd = open(file, O_WRONLY | O_CREAT | O_APPEND, 0o600)
    guard fd >= 0 else { return }
    _ = line.withCString { write(fd, $0, strlen($0)) }
    close(fd)
  }
}
