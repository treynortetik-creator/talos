import AppKit
import Combine
import Foundation
import Testing
import TalosDesktopCore

@testable import TalosDesktop

// C-LIVE review round on real panels and real events. Runs only with TALOS_GUI_TESTS=1 from a logged-in session.

private func feedFrame(
  busy: Bool = false, needs: Int = 0, unread: Int = 0, failed: Int = 0, rows: [[String: Any]] = [], reply: (String, Int)? = nil
) -> CompanionFeed {
  let o: [String: Any] = [
    "type": "companion_state", "link": "online", "mac_online": true, "busy": busy, "needs": needs, "working": 0, "queued": 0,
    "on_call": 0, "unread": unread, "failed": failed, "rows": rows,
    "last_reply": reply.map { ["thread_id": $0.0, "seq": $0.1] as [String: Any] } ?? NSNull(),
  ]
  guard case .companionState(let f)? = WebToNative.decode(o) else { fatalError("the test frame must decode") }
  return f
}

@MainActor private final class Counter: ObservableObject {
  @Published private(set) var value = 1
  var announced = 0
  var bag = Set<AnyCancellable>()
  init() { objectWillChange.sink { [unowned self] in announced += 1 }.store(in: &bag) }
  func set(_ v: Int) { setIfChanged(\.value, to: v) }
}

/// A fixed sequence, so a failure reproduces.
private struct Lcg: RandomNumberGenerator {
  var s: UInt64
  mutating func next() -> UInt64 {
    s = s &* 6364136223846793005 &+ 1442695040888963407
    return s
  }
}

@MainActor
@Suite("Companion LIVE review panels", .serialized, .enabled(if: guiTestsEnabled))
struct CompanionLiveReviewGuiTests {
  private func mouse(_ type: NSEvent.EventType, at p: NSPoint, in panel: NSPanel) -> NSEvent {
    NSEvent.mouseEvent(
      with: type, location: p, modifierFlags: [], timestamp: ProcessInfo.processInfo.systemUptime, windowNumber: panel.windowNumber,
      context: nil, eventNumber: 1, clickCount: 1, pressure: 1)!
  }

  @Test func aRenderBetweenMouseDownAndMouseUpDoesNotLoseTheRowClick() throws {
    let t = LiveFixture()
    defer { t.done() }
    t.feed(feedFrame(rows: [["thread_id": "a1", "state": "working"], ["thread_id": "a2", "state": "ready"]]))
    t.openTray()
    let panel = try #require(t.c.trayPanelForTest)
    let v = try #require(t.c.trayViewForTest)
    let before = v.rowViews.map { ObjectIdentifier($0) }
    let row = v.rowViews[1]
    let p = row.convert(NSPoint(x: 30, y: 16), to: nil)
    panel.sendEvent(mouse(.leftMouseDown, at: p, in: panel))
    t.fx.advance(2.5)  // the 2 s timer, or a feed frame, renders while the button is held
    t.fx.advance(0.5)
    #expect(v.rowViews.map { ObjectIdentifier($0) } == before, "an unchanged list is not rebuilt")
    panel.sendEvent(mouse(.leftMouseUp, at: p, in: panel))
    #expect(t.paths == ["/t/a2"], "the click lands on the row it began on")
  }

  @Test func aChangedListIsStillRebuilt() throws {
    let t = LiveFixture()
    defer { t.done() }
    t.feed(feedFrame(rows: [["thread_id": "a1", "state": "working"]]))
    t.openTray()
    t.feed(feedFrame(rows: [["thread_id": "a1", "state": "working"], ["thread_id": "a2", "state": "ready"]]))
    #expect(t.c.trayViewForTest?.rowViews.count == 2)
  }

  @Test func theEmptyListDrawsHellosStill() throws {
    let t = LiveFixture()
    defer { t.done() }
    t.openTray()
    let v = try #require(t.c.trayViewForTest)
    #expect(v.current.showsStill)
    let r = try #require(v.stillRectForTest, "All quiet. has Hello's still beside it")
    v.frame = NSRect(origin: .zero, size: NSSize(width: CompanionPlacement.traySize.width, height: v.apply(v.current)))
    // The fixture art is transparent; give the view an opaque cell to prove it paints what it is handed, inside its rectangle.
    let cell = NSBitmapImageRep(
      bitmapDataPlanes: nil, pixelsWide: 96, pixelsHigh: 104, bitsPerSample: 8, samplesPerPixel: 4, hasAlpha: true, isPlanar: false,
      colorSpaceName: .deviceRGB, bytesPerRow: 0, bitsPerPixel: 0)!
    NSGraphicsContext.saveGraphicsState()
    NSGraphicsContext.current = NSGraphicsContext(bitmapImageRep: cell)
    NSColor.red.setFill()
    NSRect(x: 0, y: 0, width: 96, height: 104).fill()
    NSGraphicsContext.restoreGraphicsState()
    v.still = cell.cgImage
    let rep = try #require(v.bitmapImageRepForCachingDisplay(in: v.bounds))
    v.cacheDisplay(in: v.bounds, to: rep)
    let ground = CompanionColors.ground.usingColorSpace(.sRGB)!
    var drawn = 0
    let k = CGFloat(rep.pixelsWide) / v.bounds.width  // the bitmap is in device pixels
    for x in stride(from: Int((r.minX + 2) * k), to: Int((r.maxX - 2) * k), by: 3) {
      for y in stride(from: Int((r.minY + 2) * k), to: Int((r.maxY - 2) * k), by: 3) {
        guard let c = rep.colorAt(x: x, y: y)?.usingColorSpace(.sRGB) else { continue }
        if abs(c.redComponent - ground.redComponent) + abs(c.greenComponent - ground.greenComponent)
          + abs(c.blueComponent - ground.blueComponent) > 0.05
        { drawn += 1 }
      }
    }
    #expect(drawn > 20, "pixels were drawn in the still's rectangle, not just the ground")
    t.feed(feedFrame(rows: [["thread_id": "a1", "state": "working"]]))
    #expect(v.stillRectForTest == nil, "and not when the list has rows")
  }

  @Test func hoveringHimWithTheTrayOrCardOpenDoesNotRaiseControlsOverIt() {
    let t = LiveFixture()
    defer { t.done() }
    t.openTray()
    t.c.hoverForTest(false)
    t.c.hoverForTest(true)
    t.fx.spin(0.4)
    #expect(t.c.trayIsShowing)
    #expect(t.c.controlsPanelForTest?.isVisible != true, "Controls would cover the top of the list")
    t.c.closeCards()
    t.c.hoverForTest(false)
    t.c.hoverForTest(true)
    t.fx.spin(0.4)
    #expect(t.c.controlsPanelForTest?.isVisible == true, "with nothing open they come back")
    t.c.openReplyCard(thread: "general")
    #expect(t.c.controlsPanelForTest?.isVisible != true)
  }

  @Test func openInTalosOnTheCardOpensTheRepliesThreadFromEveryCardState() {
    let t = LiveFixture()
    defer { t.done() }
    t.feed(feedFrame())
    for outcome in [LastReplyTracker.Outcome.text("Hello", truncated: false), .empty, .timedOut, .unavailable] {
      t.paths = []
      t.c.openReplyCard(thread: "a1")
      t.replyDone.last?(outcome)
      t.c.cardViewForTest?.onOpenTalos?()
      #expect(t.paths == ["/t/a1"])
      #expect(t.fx.opened == 0, "never the page it was last on")
    }
  }

  @Test func aReplyBubbleClickAfterTheFeedWentAwayStillOpensTheThread() {
    let t = LiveFixture()
    defer { t.done() }
    t.fx.defaults.set(false, forKey: CompanionController.Key.replyBubbles)  // the plain bubble: today's behaviour
    t.feed(feedFrame(reply: ("general", 1)))
    t.feed(feedFrame(unread: 1, reply: ("general", 2)))
    #expect(t.c.currentBubbleForTest == .newReply(thread: "Daily plan", id: "general"))
    t.feed(nil)  // a reload, a wake or 90 s of silence while the bubble is still up
    #expect(t.c.bubbleIsShowing)
    t.c.bubbleViewForTest?.onClick?()
    #expect(t.paths == ["/t/general"], "the click is not swallowed")
    #expect(!t.c.cardIsShowing && t.replyRequests.isEmpty, "and nothing is asked of a page that is gone")
  }

  @Test func theCardNeverCutsALastLineOrLeavesTextInTheAccessibilityTree() throws {
    let t = LiveFixture()
    defer { t.done() }
    t.feed(feedFrame())
    t.c.openReplyCard(thread: "general")
    let v = try #require(t.c.cardViewForTest)
    var g = Lcg(s: 7)
    let words = ["a", "to", "the", "internationalization", "ok", "w", "reply", "configuration", "x", "it's"]
    var clipped = 0
    for _ in 0..<600 {
      var text = ""
      while text.count < 500 { text += words.randomElement(using: &g)! + (Int.random(in: 0..<12, using: &g) == 0 ? "\n" : " ") }
      v.show(String(text.prefix(500)), isReply: true)
      let f = v.textField
      let need = ceil(f.cell!.cellSize(forBounds: NSRect(x: 0, y: 0, width: f.frame.width, height: 100_000)).height)
      if need > f.frame.height + 0.5 && !v.bodyIsCapped { clipped += 1 }
    }
    #expect(clipped == 0, "the field's own cell needs no more height than it was given")
    v.show(String(repeating: "a\n", count: 250), isReply: true)
    #expect(v.bodyIsCapped && v.textField.cell?.truncatesLastVisibleLine == true, "a tall reply ends in an ellipsis, not a cut")
    v.show("SECRET reply text", isReply: true)
    #expect(v.textField.accessibilityLabel()?.contains("SECRET") == true)
    t.c.hideCard()
    #expect(v.textField.accessibilityLabel()?.contains("SECRET") != true, "gone from the accessibility label on close")
    #expect(v.textField.stringValue == "")
  }

  @Test func displaysAsleepKeepThePagesReplyBanner() {
    let t = LiveFixture()
    defer { t.done() }
    #expect(t.c.dropsReplyBanner(body: "New reply in Daily plan"))
    let nc = NSWorkspace.shared.notificationCenter
    nc.post(name: NSWorkspace.screensDidSleepNotification, object: nil)
    t.fx.spin(0.2)
    #expect(t.c.systemForTest.animationsPaused)
    #expect(!t.c.dropsReplyBanner(body: "New reply in Daily plan"), "he'd show it on a dark screen: the banner waits in Notification Center")
    nc.post(name: NSWorkspace.screensDidWakeNotification, object: nil)
    t.fx.spin(0.2)
    #expect(t.c.dropsReplyBanner(body: "New reply in Daily plan"))
    nc.post(name: NSWorkspace.sessionDidResignActiveNotification, object: nil)
    t.fx.spin(0.2)
    #expect(!t.c.dropsReplyBanner(body: "New reply in Daily plan"), "a switched-out user session too")
    nc.post(name: NSWorkspace.sessionDidBecomeActiveNotification, object: nil)
    t.fx.spin(0.2)
  }

  @Test func aValueSetAgainIsNotAChangeForTheMenuBarScene() {
    let c = Counter()
    c.set(2)
    c.set(2)
    c.set(2)
    #expect(c.announced == 1 && c.value == 2)
    c.set(3)
    #expect(c.announced == 2)
  }
}
