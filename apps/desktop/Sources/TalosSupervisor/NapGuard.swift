import Foundation

/// Keeps the app out of App Nap while something is supervised. The app has no window most of the time, and a napping app's timers are
/// held back, so a supervision loop would run late while the app lives. Hold and release are idempotent.
public protocol NapGuard: AnyObject, Sendable {
  func hold()
  func release()
}

/// The one way the app holds a `ProcessInfo` activity against App Nap. Each owner (the workers' loop, Main's supervisor) has its own.
public final class ProcessActivityNapGuard: NapGuard, @unchecked Sendable {
  private let lock = NSLock()
  private var token: NSObjectProtocol?
  private let begin: @Sendable () -> NSObjectProtocol
  private let end: @Sendable (NSObjectProtocol) -> Void

  public convenience init(reason: String) {
    self.init(
      begin: { ProcessInfo.processInfo.beginActivity(options: [.userInitiatedAllowingIdleSystemSleep], reason: reason) },
      end: { ProcessInfo.processInfo.endActivity($0) })
  }

  /// `begin` and `end` stand in for `ProcessInfo` in tests, which count the activities actually taken and given back.
  public init(begin: @escaping @Sendable () -> NSObjectProtocol, end: @escaping @Sendable (NSObjectProtocol) -> Void) {
    self.begin = begin
    self.end = end
  }

  deinit { release() }

  public func hold() {
    lock.withLock {
      guard token == nil else { return }
      token = begin()
    }
  }

  public func release() {
    lock.withLock {
      guard let t = token else { return }
      end(t)
      token = nil
    }
  }
}
