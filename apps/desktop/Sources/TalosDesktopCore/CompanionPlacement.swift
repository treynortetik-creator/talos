import CoreGraphics
import Foundation

/// Where the companion's windows go (spec 3.3, 3.4, 6, 8). Pure maths on rectangles in AppKit's space (origin bottom left,
/// y up), so it is tested with plain numbers and no screen.
public struct CompanionScreen: Equatable, Sendable {
  /// `CGDisplayCreateUUIDFromDisplayID` as text. Never an `NSScreen` index, which changes when a display comes and goes.
  public var uuid: String
  public var frame: CGRect
  public var visibleFrame: CGRect
  public var isPrimary: Bool
  /// The display's backing scale (1 or 2): the atlas that matches it is the one drawn on it (spec 6).
  public var backingScale: Double
  public init(uuid: String, frame: CGRect, visibleFrame: CGRect, isPrimary: Bool, backingScale: Double = 2) {
    self.backingScale = backingScale
    self.uuid = uuid
    self.frame = frame
    self.visibleFrame = visibleFrame
    self.isPrimary = isPrimary
  }
}

/// A saved spot as fractions of how far the sprite can travel inside a display's `visibleFrame`: (0, 0) is bottom left,
/// (1, 1) top right. Survives a resolution change, and a Dock that moves.
public struct CompanionSpot: Codable, Equatable, Sendable {
  public var fx: Double
  public var fy: Double
  public init(fx: Double, fy: Double) {
    self.fx = fx
    self.fy = fy
  }
}

public enum CompanionPlacement {
  public static let standardSize = CGSize(width: 96, height: 104)
  public static let miniSize = CGSize(width: 44, height: 44)
  public static let controlsSize = CGSize(width: 164, height: 74)
  public static let bubbleHeight: CGFloat = 30
  public static let bubbleMaxWidth: CGFloat = 240
  public static let composeSize = CGSize(width: 520, height: 260)
  static let gap: CGFloat = 4

  public static func size(mini: Bool) -> CGSize { mini ? miniSize : standardSize }

  /// Bottom right, above the Dock.
  public static func defaultOrigin(size: CGSize, in v: CGRect) -> CGPoint {
    CGPoint(x: v.maxX - size.width - 24, y: v.minY + 8)
  }

  public static func origin(for spot: CompanionSpot, size: CGSize, in v: CGRect) -> CGPoint {
    // A saved spot that isn't a number (a damaged preference) would put him at NaN, off every screen: use the default instead.
    guard spot.fx.isFinite, spot.fy.isFinite else { return defaultOrigin(size: size, in: v) }
    let tx = max(0, v.width - size.width)
    let ty = max(0, v.height - size.height)
    return clamp(CGPoint(x: v.minX + spot.fx * tx, y: v.minY + spot.fy * ty), size: size, in: v)
  }

  public static func spot(of origin: CGPoint, size: CGSize, in v: CGRect) -> CompanionSpot {
    let tx = max(1, v.width - size.width)
    let ty = max(1, v.height - size.height)
    return CompanionSpot(
      fx: min(1, max(0, Double((origin.x - v.minX) / tx))), fy: min(1, max(0, Double((origin.y - v.minY) / ty))))
  }

  /// Keeps the whole figure on screen. Never rewrites a saved spot: callers clamp for display only.
  public static func clamp(_ o: CGPoint, size: CGSize, in v: CGRect) -> CGPoint {
    let x = min(max(o.x, v.minX), max(v.minX, v.maxX - size.width))
    let y = min(max(o.y, v.minY), max(v.minY, v.maxY - size.height))
    return CGPoint(x: x, y: y)
  }

  /// Window origins snap to device pixels.
  public static func snap(_ o: CGPoint, scale: CGFloat) -> CGPoint {
    let s = max(scale, 1)
    return CGPoint(x: (o.x * s).rounded() / s, y: (o.y * s).rounded() / s)
  }

  /// Which display and where. The preferred display (the last one he was on) if it is still attached, else the primary;
  /// that display's own saved spot, else the default. A display that returns goes back to its saved spot because spots for
  /// absent displays are kept by the caller.
  public static func resolve(
    spots: [String: CompanionSpot], preferred: String?, screens: [CompanionScreen], size: CGSize
  ) -> (screen: CompanionScreen, origin: CGPoint)? {
    guard let s = screens.first(where: { $0.uuid == preferred }) ?? screens.first(where: { $0.isPrimary }) ?? screens.first else {
      return nil
    }
    let o = spots[s.uuid].map { origin(for: $0, size: size, in: s.visibleFrame) } ?? defaultOrigin(size: size, in: s.visibleFrame)
    return (s, o)
  }

  /// Hover controls: below him, above him near the bottom edge.
  public static func controlsFrame(sprite: CGRect, in v: CGRect) -> CGRect {
    let size = controlsSize
    var x = sprite.midX - size.width / 2
    x = min(max(x, v.minX), v.maxX - size.width)
    let below = sprite.minY - gap - size.height
    let y = below >= v.minY ? below : min(sprite.maxY + gap, v.maxY - size.height)
    return CGRect(origin: CGPoint(x: x, y: y), size: size)
  }

  public static let traySize = CGSize(width: 280, height: 0)  // height follows the rows
  public static let replyCardWidth: CGFloat = 320

  /// The tray and the reply card (C-LIVE): under him, above him near the bottom edge, clear of him, on screen. The caller
  /// closes Controls first, so the three never overlap.
  public static func cardFrame(sprite: CGRect, size: CGSize, in v: CGRect) -> CGRect {
    var x = sprite.midX - size.width / 2
    x = min(max(x, v.minX), max(v.minX, v.maxX - size.width))
    let h = min(size.height, v.height)
    let below = sprite.minY - gap - h
    let y = below >= v.minY ? below : min(sprite.maxY + gap, v.maxY - h)
    return CGRect(x: x, y: max(v.minY, y), width: min(size.width, v.width), height: h)
  }

  public enum Side: Equatable, Sendable { case above, below }

  /// The bubble: one line, above him by default, flipping at the top edge. While Controls are up it sits past them on the same
  /// side, so the two never overlap at the default spot (both would want the space above him).
  public static func bubbleFrame(sprite: CGRect, textWidth: CGFloat, controls: CGRect?, in v: CGRect) -> (frame: CGRect, side: Side) {
    let w = min(bubbleMaxWidth, max(60, textWidth + 24), v.width)
    let h = bubbleHeight
    var x = sprite.midX - w / 2
    x = min(max(x, v.minX), v.maxX - w)
    var topEdge = sprite.maxY
    var bottomEdge = sprite.minY
    if let c = controls {
      if c.minY >= sprite.maxY - 0.5 { topEdge = c.maxY } else if c.maxY <= sprite.minY + 0.5 { bottomEdge = c.minY }
    }
    let aboveY = topEdge + gap
    if aboveY + h <= v.maxY { return (CGRect(x: x, y: aboveY, width: w, height: h), .above) }
    let belowY = bottomEdge - gap - h
    if belowY >= v.minY { return (CGRect(x: x, y: belowY, width: w, height: h), .below) }
    return (CGRect(x: x, y: max(v.minY, v.maxY - h), width: w, height: h), .above)
  }

  /// Where the 520x260 compose panel opens when anchored to him: beside him, clear of him, on screen.
  public static func composeFrame(sprite: CGRect, size: CGSize = composeSize, in v: CGRect) -> CGRect {
    var x = sprite.midX - size.width / 2
    x = min(max(x, v.minX), v.maxX - size.width)
    var y = sprite.maxY + gap
    if y + size.height > v.maxY { y = sprite.minY - gap - size.height }
    y = min(max(y, v.minY), v.maxY - size.height)
    var r = CGRect(x: x, y: y, width: size.width, height: size.height)
    if r.intersects(sprite) {  // a short screen: put it beside him instead
      r.origin.x = sprite.minX - gap - size.width
      if r.minX < v.minX { r.origin.x = sprite.maxX + gap }
      r.origin.x = min(max(r.origin.x, v.minX), v.maxX - size.width)
    }
    return r
  }

  // MARK: Rounds

  /// How far a short wander goes out, in points.
  public static let wanderReach: CGFloat = 64
  /// How far a Rounds walk goes out, in points.
  public static let roundsReach: CGFloat = 176

  /// The walk (spec 2.4): up to `reach` (`roundsReach` for Rounds) out and back along his line, 8 pt a step, so at most 44 moves. Faces the way he is
  /// going, toward the middle of the visible area. Returns the x positions for each step, ending on the start.
  public static func roundsPath(start: CGPoint, size: CGSize, in v: CGRect, reach: CGFloat = roundsReach) -> (xs: [CGFloat], facingRight: Bool) {
    let roomRight = v.maxX - (start.x + size.width)
    let roomLeft = start.x - v.minX
    let right = roomRight >= roomLeft
    let dist = min(reach, max(0, right ? roomRight : roomLeft))
    let steps = Int(dist / 8)
    var xs: [CGFloat] = []
    for i in 1...max(steps, 1) where steps > 0 { xs.append(start.x + (right ? 1 : -1) * CGFloat(i * 8)) }
    if steps > 0 { for i in stride(from: steps - 1, through: 0, by: -1) { xs.append(start.x + (right ? 1 : -1) * CGFloat(i * 8)) } }
    return (xs, right)
  }

  /// Where a stopped walk leaves him. Home, his saved spot, unless the pointer is over where he stands or over home: moving the
  /// window out from under a still pointer sends no exit event (hover would stick), and moving it in sends no enter event (it
  /// would eat the next click). Then he stays put and the next walk starts by going home, when the pointer is far enough away.
  public static func restOrigin(home: CGPoint, current: CGPoint, size: CGSize, pointer: CGPoint) -> CGPoint {
    let onHome = CGRect(origin: home, size: size).contains(pointer)
    let onCurrent = CGRect(origin: current, size: size).contains(pointer)
    return onHome || onCurrent ? current : home
  }

  /// How far from home still counts as home: a snapped window origin and the saved spot differ by less than a point.
  public static let homeTolerance: CGFloat = 1

  /// Whether he should go on to `home`, the spot a cut walk began from (nil when no walk was cut: then never). `restOrigin`
  /// leaves him where he stands when the pointer is on him or on home, so a walk cut short that way leaves him off home. Once the
  /// pointer is over neither frame and nothing else has him, he goes. Never under a resting pointer (no exit or enter event is
  /// sent for a window that moves under it), never beside a walk, a drag, a call, or any panel, menu or bubble open around him.
  public static func shouldReturnHome(
    home: CGPoint?, current: CGPoint, size: CGSize, pointer: CGPoint,
    walking: Bool, dragging: Bool, onCall: Bool, panelOpen: Bool
  ) -> Bool {
    guard let home else { return false }  // no cut walk left a target: a moved saved spot is not a reason to move
    if walking || dragging || onCall || panelOpen { return false }
    let atHome = abs(current.x - home.x) < homeTolerance && abs(current.y - home.y) < homeTolerance
    if atHome { return false }
    return !CGRect(origin: home, size: size).contains(pointer) && !CGRect(origin: current, size: size).contains(pointer)
  }

  /// The rectangle the whole walk covers, widened by the 60 pt keep-clear margin (spec 2.4).
  public static func roundsKeepClear(start: CGPoint, size: CGSize, path: [CGFloat], margin: CGFloat = 60) -> CGRect {
    let lo = min(start.x, path.min() ?? start.x)
    let hi = max(start.x, path.max() ?? start.x) + size.width
    return CGRect(x: lo - margin, y: start.y - margin, width: hi - lo + 2 * margin, height: size.height + 2 * margin)
  }

  // MARK: Snooze

  /// A stored snooze end more than an hour ahead is a clock jump: cut it to one hour. Past ends are over.
  public static func snoozeEnd(stored: Date?, now: Date) -> Date? {
    guard let s = stored, s > now else { return nil }
    return min(s, now.addingTimeInterval(3600))
  }
}
