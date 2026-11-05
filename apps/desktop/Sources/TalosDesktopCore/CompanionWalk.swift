import CoreGraphics
import Foundation

/// The two walks along his line, Rounds and the short wander, and the decisions the controller takes about them. They are plain
/// functions of plain values so a test can check them without a window.
public enum CompanionWalkKind: Equatable, Sendable {
  case rounds, wander

  /// How far out the walk goes, in points.
  public var reach: CGFloat { self == .wander ? CompanionPlacement.wanderReach : CompanionPlacement.roundsReach }

  /// The walk the model asked for, if one may start: none while a walk is under way, and Rounds win over a wander.
  public static func requested(roundsDue: Bool, wanderDue: Bool, walking: Bool) -> CompanionWalkKind? {
    if walking { return nil }
    if roundsDue { return .rounds }
    return wanderDue ? .wander : nil
  }

  /// A walk starts only where he can be seen: the next recompute would cut it short, and nobody would watch it.
  public func mayStart(visible: Bool) -> Bool { visible }
}
