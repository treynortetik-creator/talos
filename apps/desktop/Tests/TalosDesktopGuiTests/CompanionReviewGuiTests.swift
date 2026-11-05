import AppKit
import CoreAudio
import Foundation
import QuartzCore
import SwiftUI
import Testing
import TalosDesktopCore

@testable import TalosDesktop

// Regression tests for the review of PR #106. Real panels, real layers, real CoreAudio listeners; TALOS_GUI_TESTS=1 only.
// Nothing here plays a sound, and no test activates the app.

@MainActor
extension CompanionFixture {
  func screenB(scale: Double = 2, x: CGFloat? = nil) -> CompanionScreen {
    let v = screens[0].visibleFrame
    let f = CGRect(x: x ?? v.maxX + 100, y: v.minY, width: 900, height: 600)
    return CompanionScreen(uuid: "TEST-B", frame: f, visibleFrame: f, isPrimary: false, backingScale: scale)
  }
  /// Sleep until he has been idle for more than 30 minutes.
  func makeAsleep() {
    advance(1900)
    advance(1)
  }
  func untilWalkEnds(max: TimeInterval = 60) {  // a cap on a hang, not a claim about speed
    let start = Date()
    while controller.isWalking && Date().timeIntervalSince(start) < max { spin(0.05) }
  }
}

@MainActor
@Suite("Companion review fixes (panel)", .serialized, .guiExclusive, .enabled(if: guiTestsEnabled))
struct CompanionReviewGuiTests {
  // MARK: Rounds

  @Test func roundsStartedFromAsleepWalksAndLeavesOneTimerThatEndsWithTheWalk() throws {
    _ = NSApplication.shared
    let fx = CompanionFixture(enabled: true)
    defer { fx.done() }
    fx.makeAsleep()
    #expect(fx.controller.lastOutput?.state == .asleep)
    fx.controller.envAdjust = { $0.secondsSinceInput = 5 }  // the owner touched the Mac a moment ago: Rounds may wake him
    let p = try #require(fx.controller.spritePanelForTest)
    let sv = try #require(fx.controller.spriteViewForTest)
    let home = p.frame.origin
    let timersBefore = fx.controller.activeTimerCount
    fx.controller.startRoundsForTest()
    #expect(fx.controller.isWalking, "waking him is part of starting Rounds, not the end of it")
    fx.spin(0.8)
    #expect(p.frame.origin.x != home.x, "he moves")
    #expect(sv.playingClip?.hasPrefix("running-") == true, "and runs, \(String(describing: sv.playingClip))")
    fx.untilWalkEnds()
    #expect(!fx.controller.isWalking)
    #expect(p.frame.origin == home)
    #expect(fx.controller.activeTimerCount <= timersBefore, "no walk timer outlives the walk: \(fx.controller.activeTimerCount) vs \(timersBefore)")
    fx.spin(0.5)
    #expect(sv.playingClip == nil, "the running clip ended with the walk")
  }

  @Test func everyClampStopsAWalkInProgress() throws {
    _ = NSApplication.shared
    let clamps: [(String, (CompanionFixture) -> Void)] = [
      ("reduce motion", { $0.controller.envAdjust = { $0.reduceMotion = true } }),
      ("low power", { $0.controller.envAdjust = { $0.lowPower = true } }),
      ("mic", { $0.controller.systemForTest.simulateMic(running: true) }),
      ("quiet", { $0.inputs.quiet = true }),
    ]
    for (name, apply) in clamps {
      let fx = CompanionFixture(enabled: true)
      defer { fx.done() }
      let p = try #require(fx.controller.spritePanelForTest)
      let sv = try #require(fx.controller.spriteViewForTest)
      let home = p.frame.origin
      fx.controller.startRoundsForTest()
      #expect(fx.controller.isWalking, "\(name)")
      fx.spin(0.5)
      apply(fx)
      fx.advance(0.1)
      #expect(!fx.controller.isWalking, "\(name) stops the walk")
      #expect(p.frame.origin == home, "\(name): back at his saved spot")
      #expect(sv.playingClip == nil, "\(name): no walk clip left on a still figure")
      fx.spin(0.5)
      #expect(p.frame.origin == home, "\(name): and he does not move again")
      #expect(fx.controller.activeTimerCount <= 2, "\(name): no walk timer")
    }
  }

  @Test func theWayBackFacesBack() throws {
    _ = NSApplication.shared
    let fx = CompanionFixture(enabled: true)
    defer { fx.done() }
    let p = try #require(fx.controller.spritePanelForTest)
    let sv = try #require(fx.controller.spriteViewForTest)
    fx.controller.startRoundsForTest()
    var lastX = p.frame.origin.x
    var right = 0, left = 0
    let start = Date()
    while fx.controller.isWalking && Date().timeIntervalSince(start) < 60 {
      fx.spin(0.02)
      let x = p.frame.origin.x
      if x > lastX {
        right += 1
        if fx.controller.isWalking { #expect(sv.playingClip == "running-right", "moving right, clip \(String(describing: sv.playingClip)) x \(lastX)->\(x) walking \(fx.controller.isWalking) left \(left) right \(right)") }
      } else if x < lastX {
        left += 1
        if fx.controller.isWalking { #expect(sv.playingClip == "running-left", "moving left, clip \(String(describing: sv.playingClip))") }
      }
      lastX = x
    }
    #expect(right > 0 && left > 0, "the walk goes out and comes back: \(left) left, \(right) right")
  }

  @Test func aRecomputeInTheMiddleOfAWalkKeepsTheWalkClipRunning() throws {
    _ = NSApplication.shared
    let fx = CompanionFixture(enabled: true)
    defer { fx.done() }
    let sv = try #require(fx.controller.spriteViewForTest)
    fx.controller.startRoundsForTest()
    fx.spin(0.5)
    let clip = sv.playingClip
    #expect(clip?.hasPrefix("running-") == true)
    for _ in 0..<3 {
      fx.advance(0.1)  // StatusCoordinator's 2 s recompute reaches the model: it knows nothing of the walk
      #expect(fx.controller.isWalking)
      #expect(sv.playingClip == clip, "the walk's clip is still asserted")
    }
    fx.controller.stopWalkForTest()
  }

  // MARK: quiet dot, ember

  @Test func theQuietWindowDrawsItsStillDotOnlyWhenSomethingWasCollected() throws {
    _ = NSApplication.shared
    let fx = CompanionFixture(enabled: true)
    defer { fx.done() }
    let sv = try #require(fx.controller.spriteViewForTest)
    fx.inputs.quiet = true
    fx.inputs.collected = 0
    fx.advance(1)
    #expect(!sv.dotIsShowing, "nothing collected: no dot")
    fx.inputs.collected = 3
    fx.advance(1)
    sv.layoutSubtreeIfNeeded()
    #expect(sv.dotIsShowing, "something collected in quiet: a dot")
    #expect(sv.dotLayerForTest.animationKeys() == nil, "a still dot")
    #expect(sv.dotLayerForTest.frame.width > 0 && sv.bounds.contains(CGPoint(x: sv.dotLayerForTest.frame.midX, y: sv.dotLayerForTest.frame.midY)))
    fx.inputs.quiet = false
    fx.advance(1)
    #expect(!sv.dotIsShowing, "gone with the quiet window")
  }

  @Test func theRecomputeEveryTwoSecondsDoesNotRestartTheEmber() throws {
    _ = NSApplication.shared
    for setup in 0..<3 {
      let fx = CompanionFixture(enabled: true, mini: setup == 2)
      defer { fx.done() }
      let sv = try #require(fx.controller.spriteViewForTest)
      fx.controller.envAdjust = { $0.moments = false }  // the rotating clips would redraw the rest by design; this is about the recompute alone
      if setup == 1 { fx.inputs.needs = 1 }
      if setup == 2 { fx.inputs.session = .running(busy: true) }
      fx.advance(5)
      fx.advance(5)
      fx.spin(1.0)
      let first = try #require(sv.emberAnimationSignature, "setup \(setup) has a stepped ember")
      for _ in 0..<4 {
        fx.advance(2)  // StatusCoordinator's recompute
        #expect(sv.emberAnimationSignature == first, "setup \(setup): the same animation, not a new random period")
      }
    }
  }

  /// The real art plays a loop of the body in Idle and in Needs you: the recompute must leave it running, not redraw the rest and start
  /// the loop over from its first cell.
  @Test func theRecomputeEveryTwoSecondsDoesNotRestartTheBaseLoop() throws {
    _ = NSApplication.shared
    for needs in [0, 1] {
      let fx = CompanionFixture(art: CompanionRenderGuiTests.art.path, enabled: true)
      defer { fx.done() }
      let sv = try #require(fx.controller.spriteViewForTest)
      fx.controller.envAdjust = { $0.moments = false }
      fx.inputs.needs = needs
      fx.advance(5)
      fx.advance(5)
      fx.spin(2.0)  // the real wave is 1.14 s
      #expect(sv.isLoopingRest, "needs \(needs): plays its loop")
      let draws = sv.restDrawCount
      for _ in 0..<4 {
        fx.advance(2)
        #expect(sv.restDrawCount == draws, "needs \(needs): the same loop keeps playing, it is not redrawn")
        #expect(sv.spriteLayerForTest.animation(forKey: "frames") != nil)
      }
    }
  }

  @Test func theEmberHidesWhileAClipMovesTheFigureAndComesBackAtRest() throws {
    _ = NSApplication.shared
    let fx = CompanionFixture(enabled: true)
    defer { fx.done() }
    let sv = try #require(fx.controller.spriteViewForTest)
    fx.advance(1)
    #expect(!sv.emberIsHidden)
    fx.inputs.needs = 1  // the wave
    fx.advance(1)
    #expect(sv.playingClip == "waving")
    #expect(sv.emberIsHidden, "the ember is one pose and a wave is not: no glow at the front-facing eye")
    fx.spin(1.0)
    #expect(sv.playingClip == nil)
    #expect(!sv.emberIsHidden, "back with the rest pose")
  }

  @Test func onTheRealArtTheEmberIsOffWhileAClipOrALoopMovesTheFigureAndBackWhenHeHoldsStill() throws {
    _ = NSApplication.shared
    let fx = CompanionFixture(art: CompanionRenderGuiTests.art.path, enabled: true)
    defer { fx.done() }
    let sv = try #require(fx.controller.spriteViewForTest)
    fx.controller.envAdjust = { $0.moments = false }
    fx.advance(1)
    #expect(sv.isLoopingRest && sv.emberIsHidden, "Idle plays its loop, whose glow is in the body: no ember layer over a moving figure")
    fx.inputs.needs = 1  // the wave
    fx.advance(1)
    #expect(sv.playingClip == "waving")
    #expect(sv.emberIsHidden)
    fx.spin(2.0)  // the real wave is 1.14 s
    #expect(sv.playingClip == nil)
    #expect(sv.isLoopingRest && sv.emberIsHidden, "back to the Needs-you loop, glow in the body")
    fx.controller.envAdjust = { $0.reduceMotion = true }
    fx.advance(5)
    #expect(!sv.isLoopingRest && !sv.emberIsHidden, "Reduce Motion holds the pose and the ember comes back with it")
  }

  @Test func reduceMotionEmberSitsAtItsRestingOpacityInEveryState() throws {
    _ = NSApplication.shared
    let fx = CompanionFixture(enabled: true)
    defer { fx.done() }
    let sv = try #require(fx.controller.spriteViewForTest)
    fx.controller.envAdjust = { $0.reduceMotion = true }
    for (needs, busy) in [(0, false), (1, false), (0, true)] {
      fx.inputs.needs = needs
      fx.inputs.session = .running(busy: busy)
      fx.advance(5)
      fx.advance(5)
      #expect(abs(sv.emberOpacity - 0.7) < 0.001, "needs \(needs) busy \(busy): \(sv.emberOpacity)")
      #expect(sv.emberLayerForTest.animationKeys() == nil)
    }
  }

  @Test func aClipThatEndsOnTheOtherSheetNeverShowsAnOldRectCroppedFromIt() throws {
    _ = NSApplication.shared
    let fx = CompanionFixture(enabled: true)
    defer { fx.done() }
    let sv = try #require(fx.controller.spriteViewForTest)
    fx.inputs.needs = 1
    fx.advance(1)
    fx.spin(1.0)  // the wave is over
    fx.advance(5)
    fx.controller.clickForTest(1)  // a click on an alert state shows its bubble again and talks (the extension sheet)
    try #require(sv.playingClip == "talking")
    let ext = try #require(sv.atlas?.manifest).contentsRect(sheet: .talosExt, col: 2, row: 0)
    #expect(sv.spriteContentsRect == ext, "the model value is a cell of the sheet being shown: \(sv.spriteContentsRect)")
  }

  // MARK: displays

  @Test func aDisplayThatComesBackTakesHimBackToItsSavedSpot() throws {
    _ = NSApplication.shared
    let fx = CompanionFixture(start: false)
    defer { fx.done() }
    let b = fx.screenB()
    fx.screens = [fx.screens[0], b]
    fx.defaults.set([0.5, 0.5], forKey: CompanionController.Key.posPrefix + "TEST-B")
    fx.defaults.set("TEST-B", forKey: CompanionController.Key.display)
    fx.startController()
    fx.turnOn()
    let p = try #require(fx.controller.spritePanelForTest)
    #expect(b.visibleFrame.contains(p.frame), "starts on B")
    fx.screens = [fx.screens[0]]  // unplugged
    fx.controller.screensChangedForTest()
    #expect(fx.screens[0].visibleFrame.contains(p.frame), "moved to the primary")
    fx.screens = [fx.screens[0], b]  // plugged back
    fx.controller.screensChangedForTest()
    #expect(b.visibleFrame.contains(p.frame), "and back on B at its saved spot: \(p.frame)")
    #expect(fx.defaults.array(forKey: CompanionController.Key.posPrefix + "TEST-B") as? [Double] == [0.5, 0.5], "the saved spot was never rewritten")
  }

  @Test func unpluggingDuringAWalkLeavesHimOnAScreenThatExists() throws {
    _ = NSApplication.shared
    let fx = CompanionFixture(start: false)
    defer { fx.done() }
    let b = fx.screenB()
    fx.screens = [fx.screens[0], b]
    fx.defaults.set([0.5, 0.5], forKey: CompanionController.Key.posPrefix + "TEST-B")
    fx.defaults.set("TEST-B", forKey: CompanionController.Key.display)
    fx.startController()
    fx.turnOn()
    let p = try #require(fx.controller.spritePanelForTest)
    fx.controller.startRoundsForTest()
    #expect(fx.controller.isWalking)
    fx.spin(0.4)
    fx.screens = [fx.screens[0]]
    fx.controller.screensChangedForTest()
    #expect(!fx.controller.isWalking)
    #expect(fx.screens[0].visibleFrame.contains(p.frame), "on the remaining display, not stranded on the removed one: \(p.frame)")
  }

  @Test func theAtlasFollowsTheDisplayHeIsOnNotTheKeyWindowsScreen() throws {
    _ = NSApplication.shared
    let fx = CompanionFixture(start: false)
    defer { fx.done() }
    let b = fx.screenB(scale: 1)
    fx.screens = [fx.screens[0], b]  // A is 2x, B is 1x
    fx.defaults.set([0.5, 0.5], forKey: CompanionController.Key.posPrefix + "TEST-B")
    fx.defaults.set("TEST-B", forKey: CompanionController.Key.display)
    fx.startController()
    fx.turnOn()
    #expect(fx.controller.atlasScale == 1, "built for the display he is placed on")
    fx.screens = [fx.screens[0]]  // unplugged: he lands on the 2x display
    fx.controller.screensChangedForTest()
    #expect(fx.controller.atlasScale == 2, "the matching atlas comes in")
    #expect(near(fx.spritePixel(), cell(0, 0).0, cell(0, 0).1, cell(0, 0).2), "and it draws: \(String(describing: fx.spritePixel()))")
    fx.screens = [fx.screens[0], b]  // back on the 1x display
    fx.controller.screensChangedForTest()
    #expect(fx.controller.atlasScale == 1)
    #expect(near(fx.spritePixel(), cell(0, 0).0, cell(0, 0).1, cell(0, 0).2))
  }

  // MARK: bubbles and drag

  @Test func aDropNeverShowsAHeldBubbleThroughAMicOrQuiet() {
    _ = NSApplication.shared
    for clamp in ["mic", "quiet"] {
      let fx = CompanionFixture(enabled: true)
      defer { fx.done() }
      fx.inputs.needs = 1
      fx.advance(1)
      #expect(fx.controller.bubbleIsShowing, "\(clamp)")
      fx.controller.dragBeganForTest(right: true)
      #expect(!fx.controller.bubbleIsShowing)
      if clamp == "mic" { fx.controller.systemForTest.simulateMic(running: true) } else { fx.inputs.quiet = true; fx.advance(0.1) }
      fx.controller.dragEndedForTest()
      #expect(!fx.controller.bubbleIsShowing, "\(clamp) holds the bubble back at the drop too")
    }
  }

  @Test func aBubbleAlreadyUpWhenAMicOrQuietStartsGoesAway() {
    _ = NSApplication.shared
    for clamp in ["mic", "quiet"] {
      let fx = CompanionFixture(enabled: true)
      defer { fx.done() }
      fx.inputs.needs = 1
      fx.advance(1)
      #expect(fx.controller.bubbleIsShowing)
      if clamp == "mic" { fx.controller.systemForTest.simulateMic(running: true) } else { fx.inputs.quiet = true; fx.advance(0.1) }
      #expect(!fx.controller.bubbleIsShowing, "\(clamp) closes what is up")
    }
  }

  @Test func theCarriedLoopDoesNotOutliveTheDragWhenTheMicStartsMidDrag() throws {
    _ = NSApplication.shared
    let fx = CompanionFixture(enabled: true)
    defer { fx.done() }
    let sv = try #require(fx.controller.spriteViewForTest)
    fx.controller.dragBeganForTest(right: true)
    #expect(sv.playingClip == "running-right", "carried")
    fx.controller.systemForTest.simulateMic(running: true)
    #expect(sv.playingClip == nil, "the model stopped asserting Carried: the loop is cut")
    fx.controller.dragEndedForTest()
    #expect(sv.playingClip == nil)
  }

  @Test func dragFacingIgnoresSamplesWithNoRealHorizontalMove() {
    var right = true
    var x: CGFloat = 100
    func feed(_ nx: CGFloat) { (right, x) = CompanionSpriteView.facing(lastRight: right, lastX: x, nowX: nx) }
    feed(90)  // a real move left
    #expect(!right)
    for _ in 0..<5 { feed(90) }  // a vertical drag: x does not change
    #expect(!right, "no flip")
    feed(89.5)
    feed(90.5)  // jitter inside the dead zone
    #expect(!right, "no flip for sub-pixel jitter")
    feed(100)
    #expect(right, "a real move right turns him")
  }

  // MARK: sleep, snooze, rebuild

  @Test func aSnoozeEndsAtTheWakeEvenThoughTheWatcherIsOffWhileSnoozed() {
    _ = NSApplication.shared
    for notification in ["wake", "clock"] {
      let fx = CompanionFixture(enabled: true)
      defer { fx.done() }
      fx.controller.snooze(hours: 1)
      #expect(fx.controller.panels.isEmpty && fx.controller.snoozedUntil != nil)
      #expect(fx.controller.systemForTest.listenerCount == 0, "the full watcher is off while he is hidden")
      #expect(fx.controller.snoozeWakeObserverCount > 0, "but something hears the Mac wake")
      fx.wall += 7200  // the Mac slept through the snooze's end; no timer ran
      fx.mono += 10
      if notification == "wake" {
        NSWorkspace.shared.notificationCenter.post(name: NSWorkspace.didWakeNotification, object: NSWorkspace.shared)
      } else {
        NotificationCenter.default.post(name: NSNotification.Name.NSSystemClockDidChange, object: nil)
      }
      fx.spin(0.2)
      #expect(fx.controller.isOnScreen, "\(notification): he is back")
      #expect(fx.controller.snoozedUntil == nil)
      #expect(fx.controller.snoozeWakeObserverCount == 0, "and the extra observers are gone")
    }
  }

  @Test func offOrShutdownDuringASnoozeRemovesTheWakeObservers() {
    _ = NSApplication.shared
    let fx = CompanionFixture(enabled: true)
    defer { fx.done() }
    fx.controller.snooze(hours: 1)
    #expect(fx.controller.snoozeWakeObserverCount > 0)
    fx.turnOff()
    #expect(fx.controller.snoozeWakeObserverCount == 0 && fx.controller.activeListenerCount == 0)
    fx.turnOn()
    fx.controller.snooze(hours: 1)
    fx.controller.shutdown()
    #expect(fx.controller.snoozeWakeObserverCount == 0 && fx.controller.activeListenerCount == 0)
  }

  @Test func aRebuildKeepsWhatMorningAlreadyReported() throws {
    _ = NSApplication.shared
    let fx = CompanionFixture(enabled: true)
    defer { fx.done() }
    let q = QuietWindow.read(Data(#"{"quiet_window":{"start":"20:30","end":"04:00"},"timezone":"Etc/GMT+7"}"#.utf8))
    fx.inputs.quietWindow = q
    fx.inputs.quiet = true
    fx.inputs.collected = 4
    fx.advance(1)
    fx.wall += 24 * 3600
    fx.advance(60)
    fx.inputs.quiet = false
    fx.advance(1)
    #expect(fx.controller.bubbleIsShowing, "first Morning: the overnight bubble")
    #expect(fx.controller.bubbleViewForTest?.text == "Overnight: 4 items")
    fx.controller.setSize(mini: true)  // a rebuild
    fx.spin(0.1)
    fx.controller.setSize(mini: false)  // and another
    fx.spin(0.1)
    fx.inputs.quiet = true
    fx.advance(1)
    fx.wall += 24 * 3600
    fx.advance(60)
    fx.inputs.quiet = false
    fx.advance(1)
    #expect(fx.controller.bubbleViewForTest?.text != "Overnight: 4 items" || !fx.controller.bubbleIsShowing, "the same 4 items are not reported again")
  }

  // MARK: mic

  @Test func playbackOnADeviceWithAnInputStreamDoesNotHoldHimButAProcessRecordingDoes() throws {
    _ = NSApplication.shared
    let s = CompanionSystem()
    let devices = try #require(CompanionSystem.inputDevices(), "CoreAudio lists devices")
    try #require(!devices.isEmpty)
    s.deviceRunningProvider = { _ in true }  // a duplex device: playing music makes "running somewhere" true
    var processInput: Bool? = false
    s.processInputProvider = { processInput }
    s.start()
    defer { s.stop() }
    #expect(!s.micHeld, "device running, no process has input open: playback, not a mic")
    processInput = true
    s.recheckMic()
    #expect(s.micHeld, "a process with input open is a mic")
    processInput = false
    s.recheckMic()
    s.simulateMic(running: false)
    processInput = nil  // the Mac can't say: the device alone decides, as before
    s.recheckMic()
    #expect(s.micHeld, "unknown process state falls back to the device")
    #expect(s.processListenerCount > 0, "it listens for a process starting its input")
    s.stop()
    #expect(s.listenerCount == 0 && s.processListenerCount == 0)
  }

  @Test func theRealProcessQueryAnswersWithNoPromptAndNoMicRunningHere() {
    let a = CompanionSystem.anyProcessRunningInput()
    #expect(a != nil, "the process list reads on this Mac")
    #expect(CompanionSystem.processObjects()?.isEmpty == false)
  }

  // MARK: colour, quiet at wake, settings link

  @Test func theBubbleCreamIsTheBrandCream() throws {
    let tokens = URL(fileURLWithPath: #filePath).deletingLastPathComponent().deletingLastPathComponent().deletingLastPathComponent()
      .deletingLastPathComponent().appendingPathComponent("web/src/theme/tokens.css")
    let css = try String(contentsOf: tokens, encoding: .utf8)
    let line = try #require(css.split(separator: "\n").first { $0.contains("--talos-cream:") })
    let hex = try #require(line.split(separator: "#").last).prefix(6)
    let n = try #require(Int(hex, radix: 16))
    let c = CompanionColors.cream.usingColorSpace(.sRGB)!
    #expect(Int((c.redComponent * 255).rounded()) == (n >> 16) & 255)
    #expect(Int((c.greenComponent * 255).rounded()) == (n >> 8) & 255)
    #expect(Int((c.blueComponent * 255).rounded()) == n & 255)
  }

  @Test func theCompanionInputsTakeQuietAndCollectedNowNotAtTheLastRecompute() {
    let sc = StatusCoordinator.shared
    let saved = sc.now
    defer {
      sc.now = saved
      sc.setQuietForTest(nil)
    }
    let q = QuietWindow.read(Data(#"{"quiet_window":{"start":"20:30","end":"04:00"},"timezone":"Etc/GMT+7"}"#.utf8))
    sc.setQuietForTest(q)
    sc.now = { Date(timeIntervalSince1970: 1_793_462_400) }  // 09:00 UTC-7
    #expect(sc.companionInputsNow.quiet == false)
    sc.now = { Date(timeIntervalSince1970: 1_793_462_400 + 18 * 3600) }  // 03:00 the next day: inside the window
    #expect(sc.companionInputsNow.quiet == true, "a wake at 03:30 must not read the value from before the lid closed")
    #expect(sc.companionInputsNow.collected == sc.collected)
    #expect(sc.companionInputsNow.quietWindow == q)
  }

  /// The SwiftUI button itself can't be pressed from a test (a hosting view builds no accessibility tree without a client); the
  /// button calls this, and the smoke step presses the real one.
  @Test func theHotkeysLinkActionSwitchesToTheHotkeysTab() {
    SettingsNavigator.shared.selected = .companion
    CompanionSettingsView.showHotkeys()
    #expect(SettingsNavigator.shared.selected == .hotkeys)
    SettingsNavigator.shared.selected = .session
  }
}
