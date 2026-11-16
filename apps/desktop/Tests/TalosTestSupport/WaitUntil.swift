import Foundation

/// What a `waitUntil` saw: whether the condition held before the limit, the last value it read, and how long it took. Its text is
/// what a failed check should print, so a timeout says what the test was looking at instead of only "false".
public struct Waited<T>: CustomStringConvertible {
  public let ok: Bool
  public let last: T
  public let seconds: Double

  public var description: String {
    let s = String(format: "%.2f", seconds)
    return ok ? "met after \(s) s (last saw: \(last))" : "not met after \(s) s; last saw: \(last)"
  }
}

/// The one way the tests wait for something that should happen: `observe` is read every `poll` seconds until `done` holds for what
/// it returned, or `timeout` seconds have passed. It returns the moment the condition holds, so a long limit costs time only when a
/// test is failing anyway, and a busy machine makes the wait longer, never the answer different. The read is made once more at the
/// limit, so a condition met during the last sleep still counts.
///
/// A fixed sleep followed by a check is the thing this replaces: under load the sleep is too short, and on a quiet machine too long.
public func waitUntil<T>(
  timeout: Double = 15, poll: Double = 0.05, observe: () -> T, _ done: (T) -> Bool
) -> Waited<T> {
  let start = Date()
  let until = start.addingTimeInterval(timeout)
  var seen = observe()
  while !done(seen) {
    if Date() >= until { return Waited(ok: false, last: seen, seconds: Date().timeIntervalSince(start)) }
    usleep(useconds_t(max(0.001, poll) * 1_000_000))
    seen = observe()
  }
  return Waited(ok: true, last: seen, seconds: Date().timeIntervalSince(start))
}

/// The same for a plain condition, with nothing to report but whether it held.
@discardableResult
public func waitUntil(timeout: Double = 15, poll: Double = 0.05, _ cond: () -> Bool) -> Bool {
  waitUntil(timeout: timeout, poll: poll, observe: cond) { $0 }.ok
}
