import CoreGraphics
import Foundation
import Testing

@testable import TalosDesktopCore

@Suite("Companion placement")
struct CompanionPlacementTests {
  let big = CompanionScreen(
    uuid: "A", frame: CGRect(x: 0, y: 0, width: 1920, height: 1080), visibleFrame: CGRect(x: 0, y: 70, width: 1920, height: 985),
    isPrimary: true)
  let ext = CompanionScreen(
    uuid: "B", frame: CGRect(x: 1920, y: 0, width: 2560, height: 1440), visibleFrame: CGRect(x: 1920, y: 0, width: 2560, height: 1415),
    isPrimary: false)
  let size = CompanionPlacement.standardSize

  @Test func theDefaultIsBottomRightAboveTheDock() {
    let o = CompanionPlacement.defaultOrigin(size: size, in: big.visibleFrame)
    #expect(o.y == big.visibleFrame.minY + 8)
    #expect(o.x + size.width == big.visibleFrame.maxX - 24)
  }

  @Test func aSpotIsFractionsAndRoundTrips() {
    let spot = CompanionSpot(fx: 0.25, fy: 0.5)
    let o = CompanionPlacement.origin(for: spot, size: size, in: big.visibleFrame)
    let back = CompanionPlacement.spot(of: o, size: size, in: big.visibleFrame)
    #expect(abs(back.fx - 0.25) < 1e-9 && abs(back.fy - 0.5) < 1e-9)
  }

  @Test func theFigureAlwaysStaysFullyOnScreen() {
    for (x, y) in [(-500.0, -500.0), (5000.0, 5000.0), (1900.0, 1060.0), (0.0, 0.0)] {
      let o = CompanionPlacement.clamp(CGPoint(x: x, y: y), size: size, in: big.visibleFrame)
      #expect(big.visibleFrame.contains(CGRect(origin: o, size: size)))
    }
    for fx in [-3.0, 0, 1, 9] {
      let o = CompanionPlacement.origin(for: CompanionSpot(fx: fx, fy: fx), size: size, in: big.visibleFrame)
      #expect(big.visibleFrame.contains(CGRect(origin: o, size: size)))
    }
  }

  @Test func clampingNeverRewritesTheSavedSpot() {
    let saved = CompanionSpot(fx: 1, fy: 1)
    let tiny = CGRect(x: 0, y: 0, width: 100, height: 100)  // a screen smaller than him
    _ = CompanionPlacement.origin(for: saved, size: size, in: tiny)
    #expect(saved == CompanionSpot(fx: 1, fy: 1))
  }

  /// A spot saved during the fallback run (app icon, same 96 x 104 window) must land him on screen when the real art comes back:
  /// the saved spot is fractions of the display, so it never depended on the art. Hostile values are clamped, not trusted.
  @Test func aSpotSavedDuringTheFallbackRunStillLandsOnScreenAndAJunkOneDoes() {
    for (fx, fy) in [(0.0, 0.0), (1.0, 1.0), (0.5, 0.25), (-3.0, 7.5), (1e9, -1e9)] {
      for mini in [false, true] {
        let sz = CompanionPlacement.size(mini: mini)
        let r = CompanionPlacement.resolve(spots: ["A": CompanionSpot(fx: fx, fy: fy)], preferred: "A", screens: [big, ext], size: sz)
        let frame = CGRect(origin: r!.origin, size: sz)
        #expect(big.visibleFrame.contains(frame), "\(fx),\(fy) mini \(mini): \(frame)")
      }
    }
    let nan = CompanionPlacement.resolve(spots: ["A": CompanionSpot(fx: .nan, fy: .nan)], preferred: "A", screens: [big], size: size)
    #expect(nan.map { big.visibleFrame.contains(CGRect(origin: $0.origin, size: size)) } == true, "NaN in the saved spot: \(String(describing: nan))")
  }

  @Test func theSavedDisplayWinsAndAMissingOneFallsBackToThePrimary() throws {
    let spots = ["A": CompanionSpot(fx: 0, fy: 0), "B": CompanionSpot(fx: 1, fy: 1)]
    let both = try #require(CompanionPlacement.resolve(spots: spots, preferred: "B", screens: [big, ext], size: size))
    #expect(both.screen.uuid == "B")
    #expect(both.origin == CGPoint(x: ext.visibleFrame.maxX - size.width, y: ext.visibleFrame.maxY - size.height))
    let gone = try #require(CompanionPlacement.resolve(spots: spots, preferred: "B", screens: [big], size: size))
    #expect(gone.screen.uuid == "A", "display removed: the primary")
    #expect(gone.origin == CGPoint(x: 0, y: 70))
    #expect(spots["B"] == CompanionSpot(fx: 1, fy: 1), "the old display's spot is kept for when it returns")
    let back = try #require(CompanionPlacement.resolve(spots: spots, preferred: "B", screens: [big, ext], size: size))
    #expect(back.screen.uuid == "B" && back.origin == both.origin)
    #expect(CompanionPlacement.resolve(spots: [:], preferred: nil, screens: [], size: size) == nil)
    let fresh = try #require(CompanionPlacement.resolve(spots: [:], preferred: nil, screens: [ext, big], size: size))
    #expect(fresh.screen.uuid == "A", "the primary, not the first listed")
  }

  @Test func windowOriginsSnapToDevicePixels() {
    #expect(CompanionPlacement.snap(CGPoint(x: 10.3, y: 20.8), scale: 2) == CGPoint(x: 10.5, y: 21))
    #expect(CompanionPlacement.snap(CGPoint(x: 10.3, y: 20.8), scale: 1) == CGPoint(x: 10, y: 21))
  }

  @Test func controlsGoBelowHimAndAboveHimNearTheBottomEdge() {
    let high = CGRect(x: 800, y: 600, width: 96, height: 104)
    let below = CompanionPlacement.controlsFrame(sprite: high, in: big.visibleFrame)
    #expect(below.maxY <= high.minY)
    let low = CGRect(x: 800, y: 78, width: 96, height: 104)
    let above = CompanionPlacement.controlsFrame(sprite: low, in: big.visibleFrame)
    #expect(above.minY >= low.maxY)
    #expect(big.visibleFrame.contains(above) && big.visibleFrame.contains(below))
  }

  @Test func bubbleAndControlsNeverOverlapAtTheDefaultSpot() {
    let o = CompanionPlacement.defaultOrigin(size: size, in: big.visibleFrame)
    let sprite = CGRect(origin: o, size: size)
    let controls = CompanionPlacement.controlsFrame(sprite: sprite, in: big.visibleFrame)
    let bubble = CompanionPlacement.bubbleFrame(sprite: sprite, textWidth: 200, controls: controls, in: big.visibleFrame)
    #expect(!bubble.frame.intersects(controls))
    #expect(!bubble.frame.intersects(sprite))
    #expect(bubble.side == .above)
    #expect(bubble.frame.minY >= controls.maxY, "past the controls on the same side")
  }

  @Test func theBubbleFlipsAtTheTopAndStaysOnScreenInAllFourCorners() {
    let v = big.visibleFrame
    let corners = [
      CGPoint(x: v.minX, y: v.minY), CGPoint(x: v.maxX - 96, y: v.minY), CGPoint(x: v.minX, y: v.maxY - 104),
      CGPoint(x: v.maxX - 96, y: v.maxY - 104),
    ]
    for c in corners {
      let sprite = CGRect(origin: c, size: size)
      for withControls in [false, true] {
        let controls = withControls ? CompanionPlacement.controlsFrame(sprite: sprite, in: v) : nil
        let b = CompanionPlacement.bubbleFrame(sprite: sprite, textWidth: 400, controls: controls, in: v)
        #expect(v.contains(b.frame), "\(c) \(b.frame)")
        #expect(b.frame.width <= CompanionPlacement.bubbleMaxWidth)
        #expect(!b.frame.intersects(sprite))
        if let controls { #expect(!b.frame.intersects(controls)) }
        if let controls { #expect(v.contains(controls)) }
      }
    }
    let top = CGRect(x: 800, y: v.maxY - 104, width: 96, height: 104)
    #expect(CompanionPlacement.bubbleFrame(sprite: top, textWidth: 100, controls: nil, in: v).side == .below)
  }

  @Test func at1280By800TheBubbleControlsAndHeStayOnScreenInAllFourCornersWithAndWithoutMini() {
    let v = CGRect(x: 0, y: 40, width: 1280, height: 720)
    for mini in [false, true] {
      let size = CompanionPlacement.size(mini: mini)
      for (fx, fy) in [(0.0, 0.0), (1.0, 0.0), (0.0, 1.0), (1.0, 1.0)] {
        let o = CompanionPlacement.origin(for: CompanionSpot(fx: fx, fy: fy), size: size, in: v)
        let sprite = CGRect(origin: o, size: size)
        let controls = CompanionPlacement.controlsFrame(sprite: sprite, in: v)
        let bubble = CompanionPlacement.bubbleFrame(sprite: sprite, textWidth: 300, controls: controls, in: v)
        #expect(v.contains(sprite) && v.contains(controls) && v.contains(bubble.frame), "mini=\(mini) \(fx),\(fy)")
        #expect(!bubble.frame.intersects(controls) && !bubble.frame.intersects(sprite) && !controls.intersects(sprite))
      }
    }
  }

  @Test func theComposePanelOpensClearOfHimAndOnScreen() {
    let v = big.visibleFrame
    for c in [CGPoint(x: v.minX, y: v.minY), CGPoint(x: v.maxX - 96, y: v.minY), CGPoint(x: 800, y: v.maxY - 104), CGPoint(x: 800, y: 500)] {
      let sprite = CGRect(origin: c, size: size)
      let f = CompanionPlacement.composeFrame(sprite: sprite, in: v)
      #expect(v.contains(f))
      #expect(!f.intersects(sprite))
      #expect(f.size == CGSize(width: 520, height: 260))
    }
  }

  @Test func roundsWalkOutAndBackInEightPointStepsUnderEightSeconds() {
    let v = big.visibleFrame
    let start = CGPoint(x: 400, y: 78)
    let (xs, right) = CompanionPlacement.roundsPath(start: start, size: size, in: v)
    #expect(right, "toward the middle: more room on the right")
    #expect(xs.count <= 45)
    #expect(xs.last == start.x, "back where he started")
    #expect(xs.max()! - start.x <= 176)
    var prev = start.x
    for x in xs { #expect(abs(x - prev) == 8); prev = x }
    #expect(Double(xs.count) / 6 < 8, "at 6 fps")
    let (left, r2) = CompanionPlacement.roundsPath(start: CGPoint(x: 1700, y: 78), size: size, in: v)
    #expect(r2 == false)
    #expect(left.min()! >= 1700 - 176)
    #expect(CompanionPlacement.roundsPath(start: CGPoint(x: 0, y: 0), size: size, in: CGRect(x: 0, y: 0, width: 96, height: 104)).xs.isEmpty)
  }

  @Test func aShortWanderGoesOutAFewStepsAndBackAndNeverFurtherThanItsReach() {
    let v = big.visibleFrame
    let start = CGPoint(x: 400, y: 78)
    let (xs, right) = CompanionPlacement.roundsPath(start: start, size: size, in: v, reach: CompanionPlacement.wanderReach)
    #expect(right)
    #expect(xs.last == start.x, "back where he started")
    #expect(xs.max()! - start.x <= CompanionPlacement.wanderReach)
    #expect(CompanionPlacement.wanderReach < 176, "shorter than a Rounds walk")
    #expect(xs.count < CompanionPlacement.roundsPath(start: start, size: size, in: v).xs.count)
    #expect(xs.count >= 2)
  }

  @Test func theKeepClearZoneCoversTheWholePathPlusSixtyPoints() {
    let start = CGPoint(x: 400, y: 78)
    let path = CompanionPlacement.roundsPath(start: start, size: size, in: big.visibleFrame).xs
    let z = CompanionPlacement.roundsKeepClear(start: start, size: size, path: path)
    #expect(z.minX == 340 && z.maxX == (path.max()! + 96 + 60))
    #expect(z.contains(CGPoint(x: path.max()! + 96 + 59, y: 100)))
    #expect(!z.contains(CGPoint(x: path.max()! + 96 + 61, y: 100)))
  }

  @Test func aStoppedWalkNeverMovesHimOutFromUnderAPointerThatIsOverHimOrOverHisHomeSpot() {
    let home = CGPoint(x: 400, y: 78)
    let out = CGPoint(x: 448, y: 78)  // mid-wander: the frames overlap, as a 64 pt reach always does for a 96 pt sprite
    func rest(pointer: CGPoint, from current: CGPoint = out) -> CGPoint {
      CompanionPlacement.restOrigin(home: home, current: current, size: size, pointer: pointer)
    }
    #expect(rest(pointer: CGPoint(x: 410, y: 100)) == out, "on home only: he stays where he is")
    #expect(rest(pointer: CGPoint(x: 540, y: 100)) == out, "on where he is only (it entered him): he stays, or the exit event is lost")
    #expect(rest(pointer: CGPoint(x: 480, y: 100)) == out, "on both: he stays, the pointer is over him already")
    #expect(rest(pointer: CGPoint(x: 1000, y: 500)) == home, "on neither: home, as before")
    #expect(rest(pointer: CGPoint(x: 400 + size.width, y: 100)) == out, "just past the home frame is still over where he is")
    #expect(rest(pointer: CGPoint(x: 448 + size.width, y: 100)) == home, "just past both frames: home")
    #expect(rest(pointer: CGPoint(x: 410, y: 100), from: home) == home, "the walk ended at home: nothing to choose")
  }

  @Test func heGoesHomeFromABrokenOffWalkOnlyWhenNothingHasHimAndThePointerIsOverNeitherFrame() {
    let home = CGPoint(x: 400, y: 78)
    let out = CGPoint(x: 448, y: 78)  // left standing off home by a cut walk
    func goes(
      pointer: CGPoint, from current: CGPoint = out, walking: Bool = false, dragging: Bool = false, onCall: Bool = false,
      panelOpen: Bool = false
    ) -> Bool {
      CompanionPlacement.shouldReturnHome(
        home: home, current: current, size: size, pointer: pointer,
        walking: walking, dragging: dragging, onCall: onCall, panelOpen: panelOpen)
    }
    let away = CGPoint(x: 1000, y: 500)
    #expect(
      !CompanionPlacement.shouldReturnHome(
        home: nil, current: out, size: size, pointer: away, walking: false, dragging: false, onCall: false, panelOpen: false),
      "no cut walk left a target: a Dock or Space change that moved his saved spot is not a reason to move him")
    #expect(goes(pointer: away), "off home, pointer over neither frame, nothing open: home")
    #expect(!goes(pointer: CGPoint(x: 410, y: 100)), "the pointer rests on his home spot: moving in would eat the next click")
    #expect(!goes(pointer: CGPoint(x: 540, y: 100)), "the pointer rests on him: moving out sends no exit event")
    #expect(!goes(pointer: CGPoint(x: 480, y: 100)), "over both")
    #expect(goes(pointer: CGPoint(x: 448 + size.width, y: 100)), "just past both frames")
    #expect(!goes(pointer: away, from: home), "already home")
    #expect(!goes(pointer: away, from: CGPoint(x: 400.5, y: 78.5)), "within a point of home is home: a snapped origin is not a reason to move")
    #expect(goes(pointer: away, from: CGPoint(x: 400, y: 80)), "two points off is off")
    #expect(!goes(pointer: away, walking: true), "never fights a walk")
    #expect(!goes(pointer: away, dragging: true), "never during a drag")
    #expect(!goes(pointer: away, onCall: true), "never during a call")
    #expect(!goes(pointer: away, panelOpen: true), "never with a bubble, tray, reply card, controls or compose open around him")
  }

  @Test func aSnoozeFurtherThanAnHourAheadIsAClockJumpAndIsCutToAnHour() {
    let now = Date(timeIntervalSince1970: 1_000_000)
    #expect(CompanionPlacement.snoozeEnd(stored: now.addingTimeInterval(1800), now: now) == now.addingTimeInterval(1800))
    #expect(CompanionPlacement.snoozeEnd(stored: now.addingTimeInterval(86_400), now: now) == now.addingTimeInterval(3600))
    #expect(CompanionPlacement.snoozeEnd(stored: now.addingTimeInterval(-1), now: now) == nil)
    #expect(CompanionPlacement.snoozeEnd(stored: nil, now: now) == nil)
  }
}

@Suite("Mic hold")
struct MicHoldTests {
  @Test func startsAtOnceAndEndsThirtySecondsAfterTheMicStops() {
    var m = MicHold()
    #expect(!m.held(mono: 0))
    m.update(anyRunning: true, mono: 100)
    #expect(m.held(mono: 100))
    m.update(anyRunning: false, mono: 200)
    #expect(m.held(mono: 229.9))
    #expect(!m.held(mono: 230))
    #expect(m.deadline(mono: 210) == 230)
    #expect(m.deadline(mono: 231) == nil)
  }

  @Test func aMicThatComesBackInsideTheTailKeepsTheHold() {
    var m = MicHold()
    m.update(anyRunning: true, mono: 0)
    m.update(anyRunning: false, mono: 10)
    m.update(anyRunning: true, mono: 20)
    #expect(m.held(mono: 500))
  }

  @Test func overThreeHoursInOneStretchIsReportedAsStuck() {
    var m = MicHold()
    m.update(anyRunning: true, mono: 0)
    #expect(!m.stuck(mono: 3 * 3600 - 1))
    #expect(m.stuck(mono: 3 * 3600))
    #expect(m.deadline(mono: 10) == TimeInterval(3 * 3600))
    m.update(anyRunning: false, mono: 3 * 3600 + 5)
    #expect(!m.stuck(mono: 3 * 3600 + 6))
  }
}
