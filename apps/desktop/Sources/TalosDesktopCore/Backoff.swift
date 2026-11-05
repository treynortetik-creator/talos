import Foundation

/// Restart delays (DESKTOP-SPEC 4.3 step 4): 2, 5, 15, 30, 60 s, ±20 %, capped at 60 s, reset after 10 healthy minutes.
/// Times are monotonic seconds (never wall clock), so a clock change can't fake a healthy run.
public struct Backoff: Equatable, Sendable {
  public var steps: [Double]
  public var jitter: Double
  public var cap: Double
  public var healthyReset: Double

  public init(steps: [Double] = [2, 5, 15, 30, 60], jitter: Double = 0.2, cap: Double = 60, healthyReset: Double = 600) {
    self.steps = steps
    self.jitter = jitter
    self.cap = cap
    self.healthyReset = healthyReset
  }

  /// `attempt` is 0-based. `unit` is a random number in [-1, 1] (injected so tests are exact).
  public func delay(attempt: Int, unit: Double) -> Double {
    guard !steps.isEmpty else { return 0 }
    let base = steps[min(max(attempt, 0), steps.count - 1)]
    let u = min(max(unit, -1), 1)
    return max(0, min(cap, base * (1 + jitter * u)))
  }

  /// The attempt index to use for the restart after a crash at `crashAt` of a run that started at `runStartedAt`.
  /// A run healthy for `healthyReset` seconds starts over at 0. A negative duration (impossible with a monotonic clock,
  /// but a test can inject one) never resets.
  public func nextAttempt(previous: Int, runStartedAt: Double, crashAt: Double) -> Int {
    let healthy = crashAt - runStartedAt
    if healthy >= healthyReset { return 0 }
    return previous + 1
  }
}
