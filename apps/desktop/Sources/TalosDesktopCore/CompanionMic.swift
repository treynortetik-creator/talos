import Foundation

/// The "a mic is running" clamp (spec 2.3): starts at once, ends 30 s after the last input device stops, so a meeting's first
/// seconds are covered and Wispr Flow costs only a short delay. A mic running for more than 3 hours in one stretch is reported
/// so a stuck device isn't a silently dead pet. Pure: the CoreAudio listeners feed `update`.
public struct MicHold: Equatable, Sendable {
  public static let tail: TimeInterval = 30
  public static let stuckAfter: TimeInterval = 3 * 3600

  private var runningSince: TimeInterval?
  private var stoppedAt: TimeInterval?

  public init() {}

  /// `anyRunning`: some input device reports `IsRunningSomewhere`.
  public mutating func update(anyRunning: Bool, mono: TimeInterval) {
    if anyRunning {
      if runningSince == nil { runningSince = mono }
      stoppedAt = nil
    } else {
      if runningSince != nil { stoppedAt = mono }
      runningSince = nil
    }
  }

  public func held(mono: TimeInterval) -> Bool {
    if runningSince != nil { return true }
    if let s = stoppedAt { return mono - s < Self.tail }
    return false
  }

  public func stuck(mono: TimeInterval) -> Bool {
    guard let r = runningSince else { return false }
    return mono - r >= Self.stuckAfter
  }

  /// When the hold will end (or the stuck line will appear), so one one-shot can be scheduled.
  public func deadline(mono: TimeInterval) -> TimeInterval? {
    if let s = stoppedAt, mono - s < Self.tail { return s + Self.tail }
    if let r = runningSince, mono - r < Self.stuckAfter { return r + Self.stuckAfter }
    return nil
  }
}
