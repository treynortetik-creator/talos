import Foundation

/// The computer-use permission dialog (`DialogMatcher.Screen.computerUsePermissions`) on a session's pane, Main's or a thread's. A session
/// must never sit frozen on it, and it grants nothing on Escape, so the supervisor presses Escape, and only Escape (Enter on its first
/// row opens System Settings on the owner's Mac): on an exact match of the whole dialog, re-read just before the key; once per appearance;
/// at most `perHour` an hour per session. Past that it is left on screen and the owner is told the session waits on it. Pure: the
/// supervisor reads the pane and sends the key.
public struct ComputerUseDismiss: Equatable, Sendable {
  public static let perHour = 3
  public static let window: Double = 3600
  /// The one line the owner gets after a dismissal, at most once in `window` per session. Fixed text: nothing of the screen is in it.
  public static let ownerLine =
    "This session tried to use the screen, but macOS has not allowed it. Nothing is stuck: the session carried on without it. Screen control for sessions is being rebuilt; there is nothing you need to grant right now."
  /// After Escape the dialog should go at once; still there this long after, it did not take, and the owner is told it waits.
  public static let stuckAfter: Double = 10
  /// Not seen for this long, on every look, before an appearance that was pressed (or left at the limit) counts as over. One look that
  /// misses it (a frame torn mid-redraw) is not the dialog gone: else the same appearance could get a second Escape.
  public static let goneAfter: Double = 2
  /// The audit line of a dismissal.
  public static let auditEvent = "dialog_dismissed"
  public static let auditKind = "computer_use_permissions"

  public enum Decision: Equatable, Sendable {
    /// Not on screen (this appearance, if any, is over).
    case gone
    /// Not seen on this look, but the appearance that was pressed (or left at the limit) has not been missing for `goneAfter` yet: nothing
    /// changes, and no key goes.
    case fading
    /// Press Escape now, after a re-read that finds the same dialog.
    case press
    /// Escape was pressed for this appearance and the dialog is still there: never a second key for it.
    case pressed(stuck: Bool)
    /// The hourly limit is reached: left on screen for the owner. `first` once per appearance (the audit line, the notice).
    case limit(first: Bool)
  }

  /// When (awake clock) Escape was pressed, the last hour's.
  public private(set) var presses: [Double] = []
  /// Escape was pressed for the dialog on screen now, and when.
  public private(set) var pressedAt: Double?
  private var limitSaid = false
  /// When (awake clock) the looks began to miss a pressed or limited appearance.
  private var absentSince: Double?
  /// The dialog on screen now is left for the owner (the limit, or an Escape that did not take): the usual "waiting on" line may go.
  public private(set) var leftForOwner = false
  /// When (awake clock) the owner was last told of a dismissal.
  public private(set) var toldAt: Double?

  public init() {}

  /// One look at the pane. `onScreen`: `DialogMatcher.computerUseBlock` found the dialog.
  public mutating func look(onScreen: Bool, now: Double) -> Decision {
    guard onScreen else {
      if pressedAt != nil || limitSaid {
        // a settled miss only: the looks must miss it for `goneAfter` (a clock that went back starts the wait over)
        guard let since = absentSince, now >= since else {
          absentSince = now
          return .fading
        }
        if now - since < Self.goneAfter { return .fading }
      }
      absentSince = nil
      pressedAt = nil
      limitSaid = false
      leftForOwner = false
      return .gone
    }
    absentSince = nil
    if let at = pressedAt {
      let stuck = now - at >= Self.stuckAfter
      if stuck { leftForOwner = true }
      return .pressed(stuck: stuck)
    }
    // a press dated ahead of now (a clock that went back) still counts: it can't hand out more presses
    presses = presses.filter { now - $0 < Self.window }
    if presses.count >= Self.perHour {
      let first = !limitSaid
      limitSaid = true
      leftForOwner = true
      return .limit(first: first)
    }
    return .press
  }

  /// Escape went (or may have: a timed-out send counts, so it is never sent twice).
  public mutating func pressed(now: Double) {
    presses.append(now)
    pressedAt = now
  }

  /// Whether the owner's line may go now; when it may, it counts as told.
  public mutating func mayTellOwner(now: Double) -> Bool {
    if let t = toldAt, now - t < Self.window, t <= now + 60 { return false }
    toldAt = now
    return true
  }
}
