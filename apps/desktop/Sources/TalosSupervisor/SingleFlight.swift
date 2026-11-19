import Foundation

/// One piece of work at a time: while it runs, a second caller waits for the same run and gets its result, instead of starting another.
/// Used so the Talos code is never fetched twice at once (onboarding's automatic run and a button press, or two presses).
public final class SingleFlight<T: Sendable>: @unchecked Sendable {
  private let lock = NSLock()
  private var current: Task<T, Never>?

  public init() {}

  public var isRunning: Bool { lock.withLock { current != nil } }

  /// Runs `work` unless a run is in progress; either way returns that run's result. The next call after it ends starts afresh.
  public func run(_ work: @escaping @Sendable () async -> T) async -> T {
    let task: Task<T, Never> = lock.withLock {
      if let current { return current }
      let t = Task { [weak self] () -> T in
        let r = await work()
        self?.finish()
        return r
      }
      current = t
      return t
    }
    return await task.value
  }

  private func finish() { lock.withLock { current = nil } }
}
