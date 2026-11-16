import CoreGraphics
import Foundation
import Testing
@testable import TalosDesktopCore

@Suite("Screen capture: the agent sees only allowed apps")
struct ScreenCaptureTests {
  let allowed: Set<String> = ["com.example.notes"]

  @Test func anUngrantedWindowInFrontIsAGapAndTheAllowedOneAndTheDesktopShow() async throws {
    let cap = FakeCapture(Fx.content(), colours: Fx.colours)
    let shot = try await Fx.core(capture: cap).agentCapture(allowedBundleIDs: allowed)
    let seen = try colours(of: shot)
    #expect(!seen.contains { near($0, .magenta) }, "an ungranted app's window showed: \(seen)")
    #expect(seen.contains(.allowed))
    #expect(seen.contains(.wallpaper))
    #expect(shot.shownApps == ["com.example.notes"])
    #expect(shot.hiddenWindows == 1)
    #expect(shot.area == Fx.display.frame)
    // The allow list, not a block list: the plan names exactly the allowed window and the desktop picture
    #expect(cap.plans == [CapturePlan(source: .display(1, only: [PlannedWindow(Fx.notesWindow), PlannedWindow(Fx.wallpaper)]), crop: nil)])
  }

  /// The control for the test above: the same fake screen, unfiltered, does show the colour, so its absence there is the filter.
  @Test func theOwnersCaptureIsUnfilteredAndShowsEveryWindow() async throws {
    let cap = FakeCapture(Fx.content(), colours: Fx.colours)
    let shot = try await Fx.core(capture: cap).ownerCapture(mode: .full)
    let seen = try colours(of: shot)
    #expect(seen.contains(.magenta))
    #expect(seen.contains(.allowed))
    #expect(shot.shownApps == nil)
    #expect(cap.plans == [CapturePlan(source: .display(1, only: nil), crop: nil)])
  }

  @Test func whenTheWindowListCannotBeReadItRefusesAndNeverFallsBackToTheWholeScreen() async {
    let cap = FakeCapture(Fx.content(), colours: Fx.colours)
    cap.listError = Boom(text: "the stream service is not available")
    await #expect(throws: ScreenRefusal.filterUnavailable("the stream service is not available")) {
      try await Fx.core(capture: cap).agentCapture(allowedBundleIDs: allowed)
    }
    #expect(cap.plans.isEmpty, "nothing may be drawn once filtering failed")
    #expect(ScreenRefusal.filterUnavailable("x").reason.contains("took no screenshot"))
  }

  @Test func withoutScreenRecordingItRefusesBeforeAskingMacOSForAnything() async {
    let cap = FakeCapture(Fx.content(), colours: Fx.colours)
    let core = Fx.core(capture: cap, permissions: FakePermissions(screen: false))
    await #expect(throws: ScreenRefusal.screenRecordingNotGranted) { try await core.agentCapture(allowedBundleIDs: allowed) }
    await #expect(throws: ScreenRefusal.screenRecordingNotGranted) { try await core.ownerCapture(mode: .full) }
    // Listing windows is what makes macOS raise its prompt: never reached
    #expect(cap.contentCalls == 0)
  }

  @Test func aDrawingFailureIsAnErrorNotAnEmptyPicture() async {
    let cap = FakeCapture(Fx.content(), colours: Fx.colours)
    cap.drawError = Boom(text: "display asleep")
    await #expect(throws: ScreenRefusal.captureFailed("display asleep")) {
      try await Fx.core(capture: cap).agentCapture(allowedBundleIDs: allowed)
    }
    await #expect(throws: ScreenRefusal.captureFailed("display asleep")) { try await Fx.core(capture: cap).ownerCapture(mode: .full) }
  }

  @Test func oneWindowOfAnUngrantedAppIsRefusedAndOfAnAllowedAppIsShown() async throws {
    let cap = FakeCapture(Fx.content(), colours: Fx.colours)
    let core = Fx.core(capture: cap)
    await #expect(throws: ScreenRefusal.appNotAllowed(app: "com.example.secret", subject: .running(pid: 502))) {
      try await core.agentCapture(allowedBundleIDs: allowed, area: .window(30))
    }
    #expect(cap.plans.isEmpty)
    let shot = try await core.agentCapture(allowedBundleIDs: allowed, area: .window(20))
    #expect(try colours(of: shot) == [.allowed])
    #expect(shot.area == Fx.notesWindow.frame)
    await #expect(throws: ScreenRefusal.windowNotFound(99)) { try await core.agentCapture(allowedBundleIDs: allowed, area: .window(99)) }
    // The desktop picture is shown behind allowed windows but is not a window an agent may ask for by itself
    await #expect(throws: ScreenRefusal.appNotAllowed(app: "com.apple.dock", subject: .running(pid: 90))) {
      try await core.agentCapture(allowedBundleIDs: allowed, area: .window(10))
    }
  }

  @Test func theOwnerMayCaptureAnyWindow() async throws {
    let shot = try await Fx.core().ownerCapture(mode: .window(30))
    #expect(try colours(of: shot) == [.magenta])
  }

  @Test func aRegionIsCroppedAndStillFiltered() async throws {
    let cap = FakeCapture(Fx.content(), colours: Fx.colours)
    // Mostly the ungranted window, with a strip of the allowed one
    let shot = try await Fx.core(capture: cap).agentCapture(allowedBundleIDs: allowed, area: .region(CGRect(x: 160, y: 110, width: 100, height: 80)))
    #expect(shot.width == 100 && shot.height == 80)
    #expect(shot.area == CGRect(x: 160, y: 110, width: 100, height: 80))
    let seen = try colours(of: shot)
    #expect(!seen.contains { near($0, .magenta) })
    #expect(seen.contains(.allowed))
    #expect(cap.plans.first?.crop == CGRect(x: 160, y: 110, width: 100, height: 80))
  }

  @Test func aWindowThatOpensAfterTheListIsNotDrawn() async throws {
    let cap = FakeCapture(Fx.content(), colours: Fx.colours)
    cap.betweenListAndDraw = { c in
      var s = c.content
      s.windows.insert(ScreenWindow(id: 40, ownerBundleID: "com.example.late", ownerPID: 503, frame: Fx.display.frame), at: 0)
      c.content = s
      c.setColour(40, .magenta)
    }
    let shot = try await Fx.core(capture: cap).agentCapture(allowedBundleIDs: allowed)
    #expect(!(try colours(of: shot)).contains { near($0, .magenta) })
  }

  /// Window ids are numbers: one that now belongs to another app is not the window that was allowed.
  @Test func aWindowIdNowOwnedByAnotherAppIsNotDrawn() async throws {
    let cap = FakeCapture(Fx.content(), colours: Fx.colours)
    cap.betweenListAndDraw = { c in
      var s = c.content
      s.windows = s.windows.map { w in
        w.id == 20 ? ScreenWindow(id: 20, ownerBundleID: "com.example.secret", ownerPID: 502, frame: w.frame) : w
      }
      c.content = s
      c.setColour(20, .magenta)
    }
    let shot = try await Fx.core(capture: cap).agentCapture(allowedBundleIDs: allowed)
    #expect(!(try colours(of: shot)).contains { near($0, .magenta) })
    // The same app name on a new process is a new owner too
    #expect(!PlannedWindow(Fx.notesWindow).matches(ScreenWindow(id: 20, ownerBundleID: "com.example.notes", ownerPID: 9999, frame: .zero)))
  }

  @Test func onlyMacOSItselfCountsAsTheDesktop() async throws {
    let widget = ScreenWindow(id: 50, ownerBundleID: "com.example.widget", ownerPID: 504, frame: CGRect(x: 0, y: 0, width: 50, height: 50), layer: -2_147_483_600)
    let noID = ScreenWindow(id: 51, ownerBundleID: nil, ownerPID: 505, frame: CGRect(x: 300, y: 0, width: 50, height: 50), layer: -2_147_483_600)
    #expect(!widget.isDesktop)
    #expect(!noID.isDesktop)
    #expect(Fx.wallpaper.isDesktop)
    #expect(ScreenWindow(id: 52, ownerBundleID: "com.apple.finder", ownerPID: 91, frame: .zero, layer: -2_147_483_603).isDesktop)
    // A Finder browser window is an app window, not desktop
    #expect(!ScreenWindow(id: 53, ownerBundleID: "com.apple.finder", ownerPID: 91, frame: .zero, layer: 0).isDesktop)
    var c = Fx.content()
    c.windows.insert(contentsOf: [widget, noID], at: 0)
    let cap = FakeCapture(c, colours: Fx.colours.merging([50: .magenta, 51: .magenta]) { a, _ in a })
    let shot = try await Fx.core(capture: cap).agentCapture(allowedBundleIDs: allowed)
    #expect(!(try colours(of: shot)).contains { near($0, .magenta) })
    #expect(shot.hiddenWindows == 3)
  }

  @Test func theAllowListMatchesWholeIdsAndBlanksAllowNothing() async throws {
    var c = Fx.content()
    c.windows.insert(ScreenWindow(id: 60, ownerBundleID: nil, ownerPID: 506, frame: CGRect(x: 0, y: 200, width: 100, height: 100)), at: 0)
    let cap = FakeCapture(c, colours: Fx.colours.merging([60: .magenta]) { a, _ in a })
    let core = Fx.core(capture: cap)
    for list: Set<String> in [["", " "], ["COM.EXAMPLE.SECRET"], ["com.example"], ["com.example.secret.helper"]] {
      let shot = try await core.agentCapture(allowedBundleIDs: list)
      #expect(!(try colours(of: shot)).contains { near($0, .magenta) }, "allow list \(list)")
      #expect(shot.shownApps == [])
    }
    let spaced = try await core.agentCapture(allowedBundleIDs: [" com.example.notes "])
    #expect(spaced.shownApps == ["com.example.notes"])
  }

  @Test func regionsPickTheDisplayHoldingMostOfThemAndBadOnesAreRefused() throws {
    let left = ScreenDisplay(id: 1, frame: CGRect(x: 0, y: 0, width: 400, height: 300))
    let right = ScreenDisplay(id: 2, frame: CGRect(x: 400, y: 0, width: 400, height: 300))
    let c = ScreenContent(displays: [left, right], windows: [], mainDisplayID: 2)
    let p = try ScreenPlanner.owner(area: .region(CGRect(x: 380, y: 10, width: 100, height: 50)), content: c)
    #expect(p.plan == CapturePlan(source: .display(2, only: nil), crop: CGRect(x: 0, y: 10, width: 80, height: 50)))
    #expect(p.area == CGRect(x: 400, y: 10, width: 80, height: 50))
    // A negative size is the same rectangle
    let n = try ScreenPlanner.owner(area: .region(CGRect(x: 100, y: 100, width: -50, height: -50)), content: c)
    #expect(n.plan.crop == CGRect(x: 50, y: 50, width: 50, height: 50))
    #expect(try ScreenPlanner.owner(area: .full, content: c).plan.source == .display(2, only: nil))
    #expect(try ScreenPlanner.owner(area: .display(1), content: c).plan.source == .display(1, only: nil))
    #expect(throws: ScreenRefusal.regionOffScreen) { try ScreenPlanner.owner(area: .region(CGRect(x: 5000, y: 0, width: 10, height: 10)), content: c) }
    #expect(throws: ScreenRefusal.displayNotFound(3)) { try ScreenPlanner.owner(area: .display(3), content: c) }
    for bad in [CGRect(x: 0, y: 0, width: 0, height: 10), CGRect(x: CGFloat.nan, y: 0, width: 10, height: 10), CGRect(x: 0, y: 0, width: CGFloat.infinity, height: 1)] {
      #expect(throws: ScreenRefusal.self) { try ScreenPlanner.agent(area: .region(bad), allowed: .ids([]), content: c) }
    }
    #expect(throws: ScreenRefusal.noDisplay) { try ScreenPlanner.owner(area: .full, content: ScreenContent(displays: [], windows: [], mainDisplayID: nil)) }
  }

  @Test func theMainDisplayIsTheDefaultAndAnUnknownMainFallsBackToTheFirst() throws {
    let a = ScreenDisplay(id: 5, frame: CGRect(x: 0, y: 0, width: 10, height: 10))
    let b = ScreenDisplay(id: 6, frame: CGRect(x: 10, y: 0, width: 10, height: 10))
    #expect(try ScreenPlanner.where_(.full, ScreenContent(displays: [a, b], windows: [], mainDisplayID: 6)).0 == b)
    #expect(try ScreenPlanner.where_(.full, ScreenContent(displays: [a, b], windows: [], mainDisplayID: 99)).0 == a)
  }
}

@Suite("Screen PNG")
struct ScreenPNGTests {
  func image(_ w: Int, _ h: Int) throws -> CGImage {
    let ctx = try bitmap(w, h)
    ctx.setFillColor(CGColor(srgbRed: 1, green: 0, blue: 1, alpha: 1))
    ctx.fill(CGRect(x: 0, y: 0, width: w, height: h))
    return try #require(ctx.makeImage())
  }

  @Test func scalesTheLongEdgeDownAndKeepsTheShape() throws {
    let out = try ScreenPNG.encode(try image(1000, 600), maxLongEdge: 100)
    #expect(out.width == 100 && out.height == 60)
    let back = try #require(decodePNG(out.data))
    #expect(back.width == 100 && back.height == 60)
    #expect(out.data.prefix(8) == Data([0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A]))
    #expect(Set(try pixels(back)).allSatisfy { near($0, .magenta, slack: 2) })
    let tall = try ScreenPNG.encode(try image(30, 900), maxLongEdge: 300)
    #expect(tall.width == 10 && tall.height == 300)
  }

  @Test func neverScalesUp() throws {
    let out = try ScreenPNG.encode(try image(50, 20), maxLongEdge: 1568)
    #expect(out.width == 50 && out.height == 20)
    #expect(ScreenPNG.scaledSize(width: 5000, height: 1, maxLongEdge: 100) == (100, 1))
  }

  @Test func refusesAMaximumOutOfRange() throws {
    let img = try image(10, 10)
    for bad in [0, -1, ScreenPNG.largestMaxLongEdge + 1] {
      #expect(throws: ScreenRefusal.self) { try ScreenPNG.encode(img, maxLongEdge: bad) }
    }
  }

  @Test func theCoresSettingIsWhatACaptureUses() async throws {
    let shot = try await Fx.core(maxLongEdge: 40).ownerCapture(mode: .full)
    #expect(shot.width == 40 && shot.height == 30)
    let back = try #require(decodePNG(shot.png))
    #expect(back.width == 40)
  }
}
