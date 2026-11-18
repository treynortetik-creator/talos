import AppKit
import CoreGraphics
import Foundation
import Testing
import TalosDesktopCore

@testable import TalosDesktopCore

// The screen-control gate and a high-level window (a dictation tool's status window sits at level 1000, alpha 1, over a third of the
// screen). Real windows, the real window list and the window server's own hit test (`NSWindow.windowNumber(at:)`), through the real
// `LiveScreenApps.pointOwner`. No event is posted and the pointer never moves. Runs only with TALOS_GUI_TESTS=1 (DESKTOP-SPEC 7.2).

@Suite("Screen input: a high window above the target", .serialized, .guiExclusive, .enabled(if: guiTestsEnabled))
@MainActor
struct OverlayClickThroughGuiTests {
  /// The target's place in the window server's own coordinates (top-left origin), clear of the menu bar, the Dock and the right third.
  let targetCG = CGRect(x: 120, y: 160, width: 300, height: 240)

  func appKit(_ r: CGRect) -> NSRect {
    let h = NSScreen.screens[0].frame.height
    return NSRect(x: r.minX, y: h - r.maxY, width: r.width, height: r.height)
  }

  func target() -> NSWindow {
    _ = NSApplication.shared
    let w = NSWindow(contentRect: appKit(targetCG), styleMask: [.borderless], backing: .buffered, defer: false)
    w.isReleasedWhenClosed = false
    w.backgroundColor = .white
    // above other apps' ordinary windows (the live Talos app can sit over this spot), still far below the overlay and below level 24
    w.level = .floating
    w.orderFrontRegardless()
    return w
  }

  enum Kind { case clearIgnoring, clearTaking, opaque }

  func overlay(_ kind: Kind) -> NSWindow {
    let w = NSWindow(contentRect: appKit(targetCG.insetBy(dx: -60, dy: -60)), styleMask: [.borderless], backing: .buffered, defer: false)
    w.isReleasedWhenClosed = false
    w.level = NSWindow.Level(rawValue: 1000)
    w.hasShadow = false
    switch kind {
    case .clearIgnoring: (w.isOpaque, w.backgroundColor, w.ignoresMouseEvents) = (false, .clear, true)
    case .clearTaking: (w.isOpaque, w.backgroundColor, w.ignoresMouseEvents) = (false, .clear, false)
    case .opaque: (w.isOpaque, w.backgroundColor, w.ignoresMouseEvents) = (true, .red, false)
    }
    w.orderFrontRegardless()
    return w
  }

  /// Runs the main loop until the windows are on screen, as the window server lists them.
  func waitOnScreen(_ ws: [NSWindow]) {
    let end = Date().addingTimeInterval(10)
    while Date() < end {
      let listed = LiveScreenApps.windowList() ?? []
      if ws.allSatisfy({ w in listed.contains { $0.windowID == UInt32(w.windowNumber) && $0.onScreen } }) { return }
      RunLoop.main.run(until: Date().addingTimeInterval(0.05))
    }
  }

  var spot: CGPoint { CGPoint(x: targetCG.midX, y: targetCG.midY) }

  /// The target as the window list names it: the owner the gate must give when the server hands the click to the target.
  func targetApp(_ t: NSWindow) throws -> ScreenApp {
    let w = try #require(LiveScreenApps.windowList()?.first { $0.windowID == UInt32(t.windowNumber) })
    return ScreenApp(bundleID: w.bundleID, pid: w.pid, name: w.name)
  }

  @Test func aClearWindowThatIgnoresTheMouseLetsTheClickReachTheTarget() throws {
    let t = target()
    let o = overlay(.clearIgnoring)
    defer { o.close(); t.close() }
    waitOnScreen([t, o])
    #expect(LiveScreenApps.windowList()?.first { $0.windowID == UInt32(o.windowNumber) }?.layer == 1000)
    let app = try targetApp(t)
    #expect(app.pid == getpid())
    #expect(LiveScreenApps().pointOwner(at: spot) == .app(app))
  }

  @Test func aClearWindowThatTakesTheMouseRefuses() throws {
    let t = target()
    let o = overlay(.clearTaking)
    defer { o.close(); t.close() }
    waitOnScreen([t, o])
    // clear pixels, but the window server hands the click to it: the point is not the target's
    #expect(LiveScreenApps().pointOwner(at: spot) == .systemArea)
  }

  @Test func anOpaqueWindowRefuses() throws {
    let t = target()
    let o = overlay(.opaque)
    defer { o.close(); t.close() }
    waitOnScreen([t, o])
    #expect(LiveScreenApps().pointOwner(at: spot) == .systemArea)
  }

  /// The socket's thread asks while the main thread is free (as in the app): the hit test hops to main and answers. The test itself must
  /// not sit on the main thread, which then could not run the hop.
  @Test nonisolated func theSocketThreadGetsTheSameAnswerThroughTheMainThread() async throws {
    let (t, o, app, p) = try await MainActor.run { () throws -> (NSWindow, NSWindow, ScreenApp, CGPoint) in
      let me = OverlayClickThroughGuiTests()
      let t = me.target()
      let o = me.overlay(.clearIgnoring)
      me.waitOnScreen([t, o])
      return (t, o, try me.targetApp(t), me.spot)
    }
    let got = await Task.detached { LiveScreenApps().pointOwner(at: p) }.value
    await MainActor.run {
      o.close()
      t.close()
    }
    #expect(got == .app(app))
  }

  @Test func theHitTestFailsClosedWhenTheMainThreadDoesNotAnswer() throws {
    // a caller off the main thread while the main thread is blocked: no answer within the timeout is nil, never a guess
    let started = Date()
    let answer = LockedValue<UInt32??>(nil)
    let p = spot
    let box = DispatchSemaphore(value: 0)
    Thread.detachNewThread {
      answer.value = .some(LiveScreenApps.windowServerHit(at: p))
      box.signal()
    }
    // hold the main thread past the timeout without running the loop
    Thread.sleep(forTimeInterval: LiveScreenApps.hitTimeout + 0.5)
    _ = box.wait(timeout: .now() + 5)
    #expect(answer.value == .some(nil))
    #expect(Date().timeIntervalSince(started) >= LiveScreenApps.hitTimeout)
  }
}
