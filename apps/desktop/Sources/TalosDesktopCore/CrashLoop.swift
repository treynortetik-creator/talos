import Foundation

/// Crash-loop cap (4.3 step 5): 5 restarts in 15 min, or 3 auto-confirms in 60 min → stop.
public struct CrashLoop: Equatable, Sendable {
  public var restarts: [Double] = []
  public var autoConfirms: [Double] = []
  public var restartWindow: Double
  public var restartCap: Int
  public var confirmWindow: Double
  public var confirmCap: Int

  public init(restartWindow: Double = 900, restartCap: Int = 5, confirmWindow: Double = 3600, confirmCap: Int = 3) {
    self.restartWindow = restartWindow
    self.restartCap = restartCap
    self.confirmWindow = confirmWindow
    self.confirmCap = confirmCap
  }

  /// An entry counts while `now - t < window`. An entry "in the future" (clock moved back) counts too: conservative.
  static func count(_ list: [Double], now: Double, window: Double) -> Int {
    list.filter { now - $0 < window }.count
  }

  public func restartsInWindow(now: Double) -> Int { Self.count(restarts, now: now, window: restartWindow) }
  public func autoConfirmsInWindow(now: Double) -> Int { Self.count(autoConfirms, now: now, window: confirmWindow) }
  public func mayRestart(now: Double) -> Bool { restartsInWindow(now: now) < restartCap }
  public func mayAutoConfirm(now: Double) -> Bool { autoConfirmsInWindow(now: now) < confirmCap }

  public mutating func recordRestart(now: Double) {
    restarts.append(now)
    restarts = restarts.filter { now - $0 < restartWindow }
  }

  public mutating func recordAutoConfirm(now: Double) {
    autoConfirms.append(now)
    autoConfirms = autoConfirms.filter { now - $0 < confirmWindow }
  }
}
