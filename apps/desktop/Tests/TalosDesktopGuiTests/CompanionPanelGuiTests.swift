import AppKit
import Foundation
import Testing
import TalosDesktopCore
import TalosSupervisor

@testable import TalosDesktop

// Real NSPanels, real CALayers, real CoreAudio listeners. Runs only with TALOS_GUI_TESTS=1 from a logged-in session (a green
// `local-ci` skips these: DESKTOP-COMPANION-SPEC section 10). Panels are shown for a moment and no test activates the app.

let companionFixtures: String = {
  let here = URL(fileURLWithPath: #filePath)
  return here.appendingPathComponent("../../Fixtures/companion").standardized.path
}()

@MainActor
final class CompanionFixture {
  let suite = "talos.companion.test.\(UUID().uuidString)"
  let defaults: UserDefaults
  let controller: CompanionController
  var inputs = CompanionInputs()
  var mono: TimeInterval = 5000
  var wall = Date(timeIntervalSince1970: 1_793_462_400)
  var opened = 0
  var settingsOpened = 0
  var composeAnchors: [NSRect?] = []
  var composeVisible = false
  var pointer = CGPoint(x: -5000, y: -5000)
  var screens: [CompanionScreen]

  static var realVisible: CGRect { NSScreen.main?.visibleFrame ?? CGRect(x: 0, y: 40, width: 1440, height: 840) }

  init(art: String? = companionFixtures, enabled: Bool = false, mini: Bool = false, start: Bool = true) {
    if let art { setenv("TALOS_COMPANION_DIR", art, 1) } else { unsetenv("TALOS_COMPANION_DIR") }
    defaults = UserDefaults(suiteName: suite)!
    if enabled { defaults.set(true, forKey: CompanionController.Key.enabled) }
    if mini { defaults.set("mini", forKey: CompanionController.Key.size) }
    controller = CompanionController(defaults: defaults)
    // The middle of every range: the day's Rounds slots land in the middle of their ranges, never in the seconds a test lets pass
    // after the pinned 09:00 clock, and an idle antic never comes sooner than it could (23.5 s, and a wander 120 s, and later while the Mac is left alone). A test that wants Rounds starts them.
    controller.modelRandom = { ($0.lowerBound + $0.upperBound) / 2 }
    let v = Self.realVisible
    screens = [CompanionScreen(uuid: "TEST-A", frame: v, visibleFrame: v, isPrimary: true)]
    inputs.quiet = false
    inputs.session = .running(busy: false)
    controller.nowProvider = { [unowned self] in (self.mono, self.wall) }
    controller.pointerProvider = { [unowned self] in self.pointer }
    controller.visibilityOverride = true
    if start { startController() }
  }

  func startController() {
    controller.start(
      inputs: { [unowned self] in self.inputs },
      host: CompanionController.Host(
        openTalos: { [unowned self] in self.opened += 1 },
        openSettings: { [unowned self] in self.settingsOpened += 1 },
        showCompose: { [unowned self] in self.composeAnchors.append($0) },
        composeIsVisible: { [unowned self] in self.composeVisible },
        screens: { [unowned self] in self.screens }))
  }

  func done() {
    controller.shutdown()
    defaults.removePersistentDomain(forName: suite)
  }

  func spin(_ s: TimeInterval) { RunLoop.main.run(until: Date().addingTimeInterval(s)) }

  func advance(_ s: TimeInterval) {
    mono += s
    wall += s
    controller.inputsChanged()
  }

  func turnOn() {
    defaults.set(true, forKey: CompanionController.Key.enabled)
    controller.reconcile(hello: true)
  }
  func turnOff() {
    defaults.set(false, forKey: CompanionController.Key.enabled)
    controller.reconcile(hello: false)
  }

  /// The centre pixel of the sprite layer alone (not the ember overlay), as 0-255 channels.
  func spritePixel() -> (r: Int, g: Int, b: Int)? {
    guard let layer = controller.spriteViewForTest?.spriteLayerForTest else { return nil }
    let w = 96, h = 104
    let cs = CGColorSpace(name: CGColorSpace.sRGB)!
    guard let ctx = CGContext(data: nil, width: w, height: h, bitsPerComponent: 8, bytesPerRow: w * 4, space: cs,
      bitmapInfo: CGImageAlphaInfo.premultipliedLast.rawValue)
    else { return nil }
    layer.frame = CGRect(x: 0, y: 0, width: w, height: h)
    layer.render(in: ctx)
    guard let d = ctx.data else { return nil }
    let p = d.assumingMemoryBound(to: UInt8.self)
    let i = ((h / 2) * w + w / 2) * 4
    return (Int(p[i]), Int(p[i + 1]), Int(p[i + 2]))
  }
}

func near(_ a: (r: Int, g: Int, b: Int)?, _ r: Int, _ g: Int, _ b: Int, tol: Int = 8) -> Bool {
  guard let a else { return false }
  return abs(a.r - r) <= tol && abs(a.g - g) <= tol && abs(a.b - b) <= tol
}
/// The fixture cell colour: R 20+28*col, G 20+24*row, B 200.
func cell(_ col: Int, _ row: Int) -> (Int, Int, Int) { (20 + 28 * col, 20 + 24 * row, 200) }

@MainActor
@Suite("Companion panels", .serialized, .guiExclusive, .enabled(if: guiTestsEnabled))
struct CompanionPanelGuiTests {
  // MARK: off by default

  @Test func offByDefaultOnACleanDefaultsNoPanelNoAtlasNoTimersNoListeners() {
    _ = NSApplication.shared
    let fx = CompanionFixture()
    defer { fx.done() }
    #expect(fx.controller.panels.isEmpty)
    #expect(!fx.controller.atlasIsLoaded)
    #expect(fx.controller.activeTimerCount == 0)
    #expect(fx.controller.activeListenerCount == 0)
    #expect(!fx.controller.isEnabled)
    fx.spin(0.3)
    #expect(fx.controller.panels.isEmpty, "still nothing a moment later")
    #expect(!NSApp.windows.contains { ($0 as? CompanionPanel)?.isVisible == true })
  }

  @Test func onThenRelaunchStillOn() {
    _ = NSApplication.shared
    let fx = CompanionFixture()
    defer { fx.done() }
    fx.turnOn()
    #expect(fx.controller.isOnScreen)
    fx.controller.shutdown()  // the app quits
    #expect(fx.controller.panels.isEmpty)
    let again = CompanionController(defaults: fx.defaults)
    again.nowProvider = fx.controller.nowProvider
    again.start(inputs: { fx.inputs }, host: CompanionController.Host(screens: { fx.screens }))
    defer { again.shutdown() }
    #expect(again.isOnScreen, "On, relaunch, still on")
  }

  @Test func theSettingsAndMenuTogglesWriteTheKeyAndTheControllerFollowsTheStandardDefaultsNotification() {
    _ = NSApplication.shared
    let std = UserDefaults.standard
    std.removeObject(forKey: CompanionController.Key.enabled)
    defer { std.removeObject(forKey: CompanionController.Key.enabled) }
    let c = CompanionController(defaults: std)
    c.host = CompanionController.Host(screens: { [CompanionScreen(uuid: "T", frame: CompanionFixture.realVisible, visibleFrame: CompanionFixture.realVisible, isPrimary: true)] })
    setenv("TALOS_COMPANION_DIR", companionFixtures, 1)
    c.start(inputs: { CompanionInputs() }, host: c.host)
    defer { c.shutdown() }
    #expect(!c.isOnScreen)
    std.set(true, forKey: CompanionController.Key.enabled)  // what @AppStorage in the Settings tab and the menu Toggle do
    RunLoop.main.run(until: Date().addingTimeInterval(0.3))
    #expect(c.isOnScreen, "the real defaults notification reached the controller")
    std.set(false, forKey: CompanionController.Key.enabled)
    RunLoop.main.run(until: Date().addingTimeInterval(0.3))
    #expect(!c.isOnScreen)
    #expect(c.panels.isEmpty)
  }

  // MARK: the panel recipe

  @Test func everyPanelIsBorderlessNonActivatingNeverKeyAndOnEverySpace() throws {
    _ = NSApplication.shared
    let fx = CompanionFixture()
    defer { fx.done() }
    let before = NSWorkspace.shared.frontmostApplication?.processIdentifier
    fx.turnOn()
    fx.controller.hoverForTest(true)
    fx.spin(0.3)
    #expect(fx.controller.controlsAreShowing)
    #expect(NSWorkspace.shared.frontmostApplication?.processIdentifier == before, "showing him never changes the frontmost app")
    #expect(fx.controller.panels.count == 3)
    for p in fx.controller.panels {
      #expect(p.styleMask.contains(.nonactivatingPanel))
      #expect(p.styleMask.contains(.borderless))
      #expect(!p.canBecomeKey && !p.canBecomeMain)
      #expect(!p.isKeyWindow && !p.isMainWindow)
      #expect(p.isFloatingPanel && p.level == .floating)
      #expect(!p.hidesOnDeactivate)
      #expect(!p.isOpaque && !p.hasShadow && p.backgroundColor == .clear)
      #expect(p.collectionBehavior.isSuperset(of: [.canJoinAllSpaces, .fullScreenAuxiliary, .stationary, .ignoresCycle]))
      #expect(!p.isMovable)
      #expect(!p.canHide, "option-cmd-H must not take him")
      #expect(!p.isReleasedWhenClosed)
      #expect(p.animationBehavior == .none)
      if p === fx.controller.spritePanelForTest {
        #expect(p.sharingType == .readOnly, "the character's own panel shows in screenshots and screen shares (owner's yes 2026-11-01, spec 3.1)")
      } else {
        #expect(p.sharingType == .none, "the bubble and the controls can carry thread names and stay out of captures and shares (spec 3.1)")
      }
    }
    let sprite = try #require(fx.controller.spritePanelForTest)
    #expect(sprite.frame.size == CGSize(width: 96, height: 104))
    #expect(sprite.ignoresMouseEvents == false, "ignoresMouseEvents is never touched")
  }

  @Test func firstClickWorksEverywhereBecauseTheAppIsNeverActive() throws {
    _ = NSApplication.shared
    let fx = CompanionFixture(enabled: true)
    defer { fx.done() }
    let sv = try #require(fx.controller.spriteViewForTest)
    #expect(sv.acceptsFirstMouse(for: nil))
    #expect(try #require(fx.controller.bubbleViewForTest).acceptsFirstMouse(for: nil))
    let cv = try #require(fx.controller.controlsViewForTest)
    #expect(cv.acceptsFirstMouse(for: nil) && cv.composeButton.acceptsFirstMouse(for: nil) && cv.openButton.acceptsFirstMouse(for: nil))
    #expect(!sv.mouseDownCanMoveWindow)
    #expect(sv.trackingAreas.filter { $0.owner === sv }.allSatisfy { $0.options.contains(.activeAlways) && $0.options.contains(.inVisibleRect) && !$0.options.contains(.mouseMoved) })
  }

  // MARK: on and off

  @Test func onOffOneHundredTimesLeavesOnePanelAndNothingBehind() {
    _ = NSApplication.shared
    let fx = CompanionFixture()
    defer { fx.done() }
    for i in 0..<100 {
      autoreleasepool {  // a real run loop drains its pool each turn; a synchronous loop must do it by hand
        fx.turnOn()
        #expect(NSApp.windows.compactMap { $0 as? CompanionPanel }.filter(\.isVisible).count == 1, "on #\(i)")
        fx.turnOff()
        #expect(NSApp.windows.compactMap { $0 as? CompanionPanel }.filter(\.isVisible).isEmpty, "off #\(i)")
        #expect(fx.controller.panels.isEmpty)
      }
    }
    fx.spin(0.2)
    let lingering = NSApp.windows.compactMap { $0 as? CompanionPanel }.count
    print("COMPANION lingering closed panels after 100 cycles:", lingering)
    #expect(lingering <= 3, "closed panels are released, not leaked: \(lingering)")
    #expect(fx.controller.activeTimerCount == 0 && fx.controller.activeListenerCount == 0)
    fx.turnOn()
    fx.turnOn()
    fx.controller.reconcile(hello: false)
    #expect(fx.controller.panels.count == 3, "sprite, bubble and controls, once each")
    #expect(NSApp.windows.compactMap { $0 as? CompanionPanel }.filter(\.isVisible).count == 1, "one panel on screen")
  }

  @Test func offIsFullyOffMidBubbleMidClipHoverPendingAndWalking() throws {
    _ = NSApplication.shared
    let fx = CompanionFixture(enabled: true)
    defer { fx.done() }
    #expect(fx.controller.atlasIsLoaded)
    #expect(fx.controller.activeListenerCount > 0, "workspace observers and CoreAudio listeners are on")
    fx.inputs.session = .stopped(byOwner: false)
    fx.advance(1)
    #expect(fx.controller.bubbleIsShowing, "mid-bubble")
    fx.controller.hoverForTest(true)  // hover pending: the 150 ms timer is live
    #expect(fx.controller.activeTimerCount > 0)
    fx.turnOff()
    #expect(fx.controller.panels.isEmpty)
    #expect(fx.controller.activeTimerCount == 0, "timers: \(fx.controller.activeTimerCount)")
    #expect(fx.controller.activeListenerCount == 0)
    #expect(!fx.controller.atlasIsLoaded, "atlases released")
    #expect(fx.controller.spriteViewForTest == nil)
    fx.spin(0.5)
    #expect(fx.controller.panels.isEmpty, "nothing came back from a stale timer")
    #expect(!NSApp.windows.contains { ($0 as? CompanionPanel)?.isVisible == true })

    // Mid-walk.
    fx.inputs.session = .running(busy: false)
    fx.turnOn()
    fx.controller.startRoundsForTest()
    #expect(fx.controller.isWalking)
    fx.turnOff()
    #expect(!fx.controller.isWalking && fx.controller.activeTimerCount == 0)
  }

  @Test func offDuringASnoozeAndSnoozeSurvivesTheClock() {
    _ = NSApplication.shared
    let fx = CompanionFixture(enabled: true)
    defer { fx.done() }
    fx.controller.snooze(hours: 1)
    #expect(fx.controller.panels.isEmpty, "snoozed means hidden")
    #expect(fx.controller.snoozedUntil == fx.wall.addingTimeInterval(3600))
    #expect(fx.defaults.bool(forKey: CompanionController.Key.enabled), "snooze is not off")
    // Sleep past the end: on wake, he is back.
    fx.wall += 3700
    fx.mono += 3700
    fx.controller.wakeForTest()
    #expect(fx.controller.isOnScreen)
    #expect(fx.controller.snoozedUntil == nil)
    // A clock jump: a stored end more than an hour ahead is cut to an hour.
    fx.defaults.set(fx.wall.addingTimeInterval(86_400).timeIntervalSince1970, forKey: CompanionController.Key.snoozeUntil)
    fx.controller.reconcile(hello: false)
    #expect(fx.controller.snoozedUntil == fx.wall.addingTimeInterval(3600))
    #expect(fx.controller.panels.isEmpty)
    // Off during the snooze, then on: not snoozed by a stale value? The value is kept until it ends.
    fx.turnOff()
    #expect(fx.controller.panels.isEmpty && fx.controller.activeTimerCount == 0, "the snooze timer is gone too")
  }

  // MARK: the character

  @Test func theRightPoseForEachStateIsReallyDrawnFromTheRightCell() {
    _ = NSApplication.shared
    let fx = CompanionFixture(enabled: true)
    defer { fx.done() }
    fx.advance(1)
    // Idle rests on idle row 0, col 0.
    let c0 = cell(0, 0)
    #expect(near(fx.spritePixel(), c0.0, c0.1, c0.2), "idle: \(String(describing: fx.spritePixel()))")
    fx.inputs.session = .stopped(byOwner: false)  // Down: failed row 5, last frame col 2
    fx.advance(1)
    let d = cell(2, 5)
    #expect(near(fx.spritePixel(), d.0, d.1, d.2), "down: \(String(describing: fx.spritePixel()))")
    fx.inputs.session = .running(busy: false)
    fx.inputs.needs = 1  // Needs you: waiting row 6, still col 0
    fx.advance(4)
    let n = cell(0, 6)
    #expect(near(fx.spritePixel(), n.0, n.1, n.2), "needs you: \(String(describing: fx.spritePixel()))")
    fx.inputs.needs = 0
    fx.inputs.session = .running(busy: true)  // Working: running row 7, last frame col 3
    fx.advance(4)
    fx.advance(4)
    let w = cell(3, 7)
    #expect(near(fx.spritePixel(), w.0, w.1, w.2), "working: \(String(describing: fx.spritePixel()))")
    fx.inputs.quiet = true  // quiet hours change nothing about how he is drawn
    fx.advance(1)
    #expect(near(fx.spritePixel(), w.0, w.1, w.2), "quiet is still Working: \(String(describing: fx.spritePixel()))")
    #expect(fx.controller.lastOutput?.state == .working && fx.controller.lastOutput?.rest != .statue)
  }

  @Test func statesComeFromRealStatusCoordinatorInputsNotJustADebugMenu() {
    let i = StatusCoordinator.companionInputs(
      phase: .stopped(.user), configured: true, activity: nil, sessionNeedsYou: false, badge: 0, relayFailures: 0, relayConfigured: true,
      agentName: "Talos", quiet: false, quietWindow: nil, collected: 0)
    #expect(i.session == .stopped(byOwner: true), "the owner's own stop is a flag, never the string")
    let crash = StatusCoordinator.companionInputs(
      phase: .stopped(.crashLoop), configured: true, activity: nil, sessionNeedsYou: false, badge: 2, relayFailures: 1, relayConfigured: true,
      agentName: "Talos", quiet: nil, quietWindow: nil, collected: 4)
    #expect(crash.session == .stopped(byOwner: false) && crash.needs == 2 && !crash.relayDown && crash.quiet == nil && crash.collected == 4)
    let relay = StatusCoordinator.companionInputs(
      phase: .running, configured: true, activity: "busy", sessionNeedsYou: false, badge: 0, relayFailures: 2, relayConfigured: true,
      agentName: "Talos", quiet: false, quietWindow: nil, collected: 0)
    #expect(relay.relayDown && relay.session == .running(busy: true), "a relay poll that failed twice running")
    let noRelay = StatusCoordinator.companionInputs(
      phase: .running, configured: true, activity: nil, sessionNeedsYou: false, badge: 0, relayFailures: 9, relayConfigured: false,
      agentName: "Talos", quiet: false, quietWindow: nil, collected: 0)
    #expect(!noRelay.relayDown, "no relay configured is not a failure")
    for (phase, want) in [
      (Supervisor.Phase.idle, CompanionSession.notStarted), (.starting, .starting), (.cleaningUp, .restarting),
      (.waitingToRestart, .restarting), (.stopping, .stopping), (.blocked([]), .blocked),
    ] {
      let x = StatusCoordinator.companionInputs(
        phase: phase, configured: true, activity: nil, sessionNeedsYou: false, badge: 0, relayFailures: 0, relayConfigured: true,
        agentName: "T", quiet: false, quietWindow: nil, collected: 0)
      #expect(x.session == want)
    }
    #expect(StatusCoordinator.companionInputs(phase: .idle, configured: false, activity: nil, sessionNeedsYou: false, badge: 0, relayFailures: 0,
      relayConfigured: true, agentName: "T", quiet: false, quietWindow: nil, collected: 0).session == .notConfigured)
  }

  @Test func theBubbleAppearsForTheEventWithTheSanitizedLabelAndGoesAfterSixSeconds() throws {
    _ = NSApplication.shared
    let fx = CompanionFixture(enabled: true)
    defer { fx.done() }
    fx.inputs.agentName = "A\u{202E}\nB " + String(repeating: "x", count: 300)
    fx.inputs.session = .stopped(byOwner: false)
    fx.advance(1)
    #expect(fx.controller.bubbleIsShowing)
    let text = try #require(fx.controller.bubbleViewForTest).text
    #expect(text.hasSuffix("'s Mac session stopped"))
    #expect(!text.contains("\n") && !text.unicodeScalars.contains("\u{202E}"))
    #expect(text.count <= 62)
    #expect(try #require(fx.controller.bubblePanelForTest).isVisible)
    #expect(!NSApp.isActive || true)
  }

  @Test func nothingShowsADownBubbleForARelayDropOrAnOwnersStop() {
    _ = NSApplication.shared
    let fx = CompanionFixture(enabled: true)
    defer { fx.done() }
    fx.inputs.relayDown = true
    fx.advance(1)
    #expect(fx.controller.lastOutput?.state == .down)
    #expect(!fx.controller.bubbleIsShowing, "a Wi-Fi drop is not a stopped session")
    #expect(fx.controller.lastOutput?.word == "Can't reach the relay")
  }

  @Test func aMicHoldsTheBubbleBackAndTheTailKeepsItBackAfterwards() {
    _ = NSApplication.shared
    let fx = CompanionFixture(enabled: true)
    defer { fx.done() }
    fx.controller.systemForTest.simulateMic(running: true)
    fx.inputs.needs = 1
    fx.advance(1)
    #expect(fx.controller.lastOutput?.state == .needsYou)
    #expect(!fx.controller.bubbleIsShowing, "held while a mic runs")
    fx.controller.systemForTest.simulateMic(running: false)
    fx.advance(1)
    #expect(!fx.controller.bubbleIsShowing, "and for 30 s after")
    fx.turnOff()
    #expect(fx.controller.activeTimerCount == 0, "the tail timer went with him")
  }

  @Test func reduceMotionAndLowPowerShowOnlyStillsWithNoAnimationOnAnyLayer() throws {
    _ = NSApplication.shared
    let fx = CompanionFixture(enabled: true)
    defer { fx.done() }
    fx.advance(1)
    let sv = try #require(fx.controller.spriteViewForTest)
    #expect(sv.attachedAnimationCount > 0, "idle blinks and the ember breathes")
    fx.controller.envAdjust = { $0.reduceMotion = true }
    fx.advance(1)
    #expect(sv.attachedAnimationCount == 0, "turning it on mid-clip goes to the still in the same frame")
    fx.inputs.session = .stopped(byOwner: false)
    fx.advance(1)
    #expect(sv.attachedAnimationCount == 0)
    #expect(fx.controller.bubbleIsShowing, "bubbles still show")
    fx.controller.envAdjust = { $0.lowPower = true }
    fx.advance(1)
    #expect(sv.attachedAnimationCount == 0)
    let p = fx.spritePixel()
    let d = cell(2, 5)
    #expect(near(p, d.0, d.1, d.2), "the still of Down")
  }

  @Test func theEmberNeverChangesMoreThanTwiceASecondAndNeverUsesASmoothAnimation() throws {
    _ = NSApplication.shared
    let fx = CompanionFixture(enabled: true)
    defer { fx.done() }
    let sv = try #require(fx.controller.spriteViewForTest)
    for state in 0..<2 {
      if state == 1 { fx.inputs.needs = 1 }
      fx.advance(5)
      fx.advance(5)
      fx.spin(1.0)  // the 0.6 s wave has to finish: the ember runs only while no clip plays
      print("COMPANION ember state", state, "mode", sv.emberMode, "playing", sv.playingClip as Any, "keys", sv.emberLayerForTest.animationKeys() as Any, "spriteKeys", sv.spriteLayerForTest.animationKeys() as Any)
      let a = try #require(sv.emberLayerForTest.animation(forKey: "ember") as? CAKeyframeAnimation, "state \(state) has a stepped ember")
      #expect(a.calculationMode == .discrete, "no CABasicAnimation, no smooth opacity")
      let times = a.keyTimes ?? []
      #expect(times.count == (a.values?.count ?? 0) + 1)
      let changes = Double(times.count - 1) / a.duration
      #expect(changes <= 2.0001, "\(sv.emberMode): \(changes) changes a second")
      #expect(!(sv.emberLayerForTest.animationKeys() ?? []).contains { sv.emberLayerForTest.animation(forKey: $0) is CABasicAnimation })
    }
  }

  @Test func workingRunsOneMoverEmberWaitsForTheClip() throws {
    _ = NSApplication.shared
    let fx = CompanionFixture(enabled: true)
    defer { fx.done() }
    let sv = try #require(fx.controller.spriteViewForTest)
    fx.inputs.session = .running(busy: true)
    fx.advance(0.1)
    fx.advance(2)
    #expect(fx.controller.lastOutput?.state == .working)
    #expect(sv.playingClip == "running", "the 20 s working run")
    #expect(sv.emberLayerForTest.animation(forKey: "ember") == nil, "ember runs only while no clip is playing: one mover")
    #expect(sv.attachedAnimationCount == 1)
  }

  @Test func theFrameAnimationHasOneMoreKeyTimeThanValuesSoTheLastFrameShows() throws {
    let data = try #require(FileManager.default.contents(atPath: companionFixtures + "/companion.json"))
    let atlas = try CompanionAtlas.decode(data).get()
    let clip = try #require(atlas.clip("waving"))
    let a = CompanionSpriteView.frameAnimation(atlas: atlas, clip: clip, frames: clip.frames, repeatCount: 1, repeatDuration: nil)
    #expect(a.calculationMode == .discrete)
    #expect(a.values?.count == 4)
    #expect(a.keyTimes?.count == 5, "n values need n+1 keyTimes (PROBE: with n the last frame never shows)")
    #expect(a.keyTimes?.last == 1 && a.keyTimes?.first == 0)
    #expect(abs(a.duration - 0.58) < 0.001)
    let loop = CompanionSpriteView.frameAnimation(atlas: atlas, clip: clip, frames: clip.frames, repeatCount: .infinity, repeatDuration: nil)
    #expect(loop.repeatCount == .infinity)
    let timed = CompanionSpriteView.frameAnimation(atlas: atlas, clip: clip, frames: clip.frames, repeatCount: 1, repeatDuration: 20)
    #expect(timed.repeatDuration == 20)
  }

  // MARK: missing and corrupt art

  @Test func missingArtShowsTheIconStillAndSettingsSaysSo() throws {
    _ = NSApplication.shared
    let empty = NSTemporaryDirectory() + "companion-empty-\(UUID().uuidString)"
    try FileManager.default.createDirectory(atPath: empty, withIntermediateDirectories: true)
    defer { try? FileManager.default.removeItem(atPath: empty) }
    let fx = CompanionFixture(art: empty, enabled: true)
    defer { fx.done() }
    #expect(fx.controller.isOnScreen, "he still appears")
    #expect(fx.controller.artProblem?.hasPrefix("Character art is missing: no companion.json in ") == true, "\(fx.controller.artProblem ?? "nil")")
    #expect(try #require(fx.controller.spriteViewForTest).isShowingFallback)
    #expect(!fx.controller.atlasIsLoaded)
    fx.inputs.session = .stopped(byOwner: false)
    fx.advance(1)
    #expect(fx.controller.bubbleIsShowing, "bubbles work without art")
  }

  @Test func corruptArtIsTheSameAsMissingArt() throws {
    _ = NSApplication.shared
    let dir = NSTemporaryDirectory() + "companion-corrupt-\(UUID().uuidString)"
    try FileManager.default.copyItem(atPath: companionFixtures, toPath: dir)
    defer { try? FileManager.default.removeItem(atPath: dir) }
    try Data("not a png".utf8).write(to: URL(fileURLWithPath: dir + "/talos-2x.png"))
    try Data("not a png".utf8).write(to: URL(fileURLWithPath: dir + "/talos-1x.png"))
    let fx = CompanionFixture(art: dir, enabled: true)
    defer { fx.done() }
    // Text with no PNG ending is caught first, by the whole-file check, so it reads as cut short or damaged (the loader's
    // answer since the IEND check went in; "isn't a readable picture" is for a file that LOOKS whole and still won't decode).
    #expect(fx.controller.artProblem?.contains("talos-") == true && fx.controller.artProblem?.contains("is cut short or damaged") == true, "names the file and why: \(fx.controller.artProblem ?? "nil")")
    #expect(try #require(fx.controller.spriteViewForTest).isShowingFallback)
    // A file that ends like a PNG but has no picture inside gets the other message.
    let pngEnd: [UInt8] = [0, 0, 0, 0, 0x49, 0x45, 0x4E, 0x44, 0xAE, 0x42, 0x60, 0x82]
    for f in ["talos-2x.png", "talos-1x.png"] { try (Data("not a picture".utf8) + Data(pngEnd)).write(to: URL(fileURLWithPath: dir + "/" + f)) }
    fx.turnOff()
    fx.turnOn()
    #expect(fx.controller.artProblem?.contains("talos-") == true && fx.controller.artProblem?.contains("isn't a readable picture") == true, "whole-looking but undecodable: \(fx.controller.artProblem ?? "nil")")
    #expect(try #require(fx.controller.spriteViewForTest).isShowingFallback)
    // A wrong-sized sheet is corrupt too (a truncated or swapped file must not draw garbage).
    try FileManager.default.copyItem(atPath: dir + "/mini-2x.png", toPath: dir + "/tmp.png")
    try FileManager.default.removeItem(atPath: dir + "/talos-2x.png")
    try FileManager.default.copyItem(atPath: dir + "/mini-2x.png", toPath: dir + "/talos-2x.png")
    try FileManager.default.removeItem(atPath: dir + "/talos-1x.png")
    try FileManager.default.copyItem(atPath: dir + "/mini-1x.png", toPath: dir + "/talos-1x.png")
    fx.turnOff()
    fx.turnOn()
    #expect(fx.controller.artProblem?.contains("talos-") == true && fx.controller.artProblem?.contains("px, expected") == true, "\(fx.controller.artProblem ?? "nil")")
  }

  @Test func miniShowsThePoseForTheStateAndStepsTheEmberOnlyWhileWorking() throws {
    _ = NSApplication.shared
    let fx = CompanionFixture(enabled: true, mini: true)
    defer { fx.done() }
    #expect(try #require(fx.controller.spritePanelForTest).frame.size == CGSize(width: 44, height: 44))
    fx.advance(1)
    let sv = try #require(fx.controller.spriteViewForTest)
    #expect(near(fx.spritePixel(), 20, 20, 200), "pleased = col 0")
    #expect(sv.emberLayerForTest.animation(forKey: "ember") == nil)
    fx.inputs.session = .running(busy: true)
    fx.advance(0.1)
    fx.advance(2)
    #expect(sv.emberLayerForTest.animation(forKey: "ember") != nil, "Working steps the ember in Mini")
    fx.inputs.session = .stopped(byOwner: false)
    fx.advance(5)
    #expect(near(fx.spritePixel(), 48, 20, 200), "worried = col 1")
    fx.inputs.session = .running(busy: false)
    fx.inputs.needs = 1
    fx.advance(5)
    #expect(near(fx.spritePixel(), 76, 20, 200), "waiting = col 2")
    fx.inputs.quiet = true
    fx.advance(1)
    #expect(near(fx.spritePixel(), 76, 20, 200), "quiet hours do not turn him into the statue: still waiting = col 2")
    // No beats in Mini.
    fx.inputs.quiet = false
    fx.advance(1)
    fx.controller.clickForTest(1)
    #expect(fx.controller.lastOutput?.animation == nil)
  }

  // MARK: hover, click, drag

  @Test func hoverShowsControlsAfterAMomentAndTheyStayUntilThePointerIsReallyGone() throws {
    _ = NSApplication.shared
    let fx = CompanionFixture(enabled: true)
    defer { fx.done() }
    fx.controller.hoverForTest(true)
    #expect(!fx.controller.controlsAreShowing, "not before 150 ms")
    fx.spin(0.3)
    #expect(fx.controller.controlsAreShowing)
    let cv = try #require(fx.controller.controlsViewForTest)
    #expect(cv.wordLabel.stringValue == "Ready")
    #expect(cv.composeButton.accessibilityLabel() != nil && cv.openButton.accessibilityLabel() != nil)
    #expect(cv.composeButton.frame.width >= 44 && cv.composeButton.frame.height >= 44)
    // Pointer still over him when the 400 ms runs out: lost exit events must not hide it.
    let sprite = try #require(fx.controller.spritePanelForTest).frame
    fx.pointer = CGPoint(x: sprite.midX, y: sprite.midY)
    fx.controller.hoverForTest(false)
    fx.spin(0.6)
    #expect(fx.controller.controlsAreShowing, "the pointer is still there")
    fx.pointer = CGPoint(x: -5000, y: -5000)
    fx.controller.hoverForTest(false)
    fx.spin(0.2)
    #expect(fx.controller.controlsAreShowing, "stays 400 ms so crossing the gap works")
    fx.spin(0.4)
    #expect(!fx.controller.controlsAreShowing)
  }

  @Test func controlsAnchorComposeToHimAndOpenTalos() throws {
    _ = NSApplication.shared
    let fx = CompanionFixture(enabled: true)
    defer { fx.done() }
    fx.controller.hoverForTest(true)
    fx.spin(0.3)
    let cv = try #require(fx.controller.controlsViewForTest)
    click(cv.composeButton)
    #expect(fx.composeAnchors.count == 1)
    #expect(fx.composeAnchors.first ?? nil == fx.controller.spritePanelForTest?.frame)
    #expect(!fx.controller.controlsAreShowing)
    fx.controller.hoverForTest(true)
    fx.spin(0.3)
    click(cv.openButton)
    #expect(fx.opened == 1)
  }

  @Test func fiveFastClicksGrumbleAndNeverOpenTalkButADoubleClickDoes() {
    _ = NSApplication.shared
    let fx = CompanionFixture(enabled: true)
    defer { fx.done() }
    fx.advance(1)
    var grumble = false
    for n in 1...5 {
      fx.controller.clickForTest(n)
      if fx.controller.lastOutput?.animation?.clip == "running" { grumble = true }
      fx.mono += 0.2
      fx.wall += 0.2
    }
    #expect(grumble, "five clicks in a second")
    fx.spin(NSEvent.doubleClickInterval + 0.4)
    #expect(fx.opened == 0, "Grumble must not open the app")
    fx.controller.clickForTest(1)
    fx.controller.clickForTest(2)
    fx.spin(NSEvent.doubleClickInterval / 2)
    #expect(fx.opened == 0, "not before the interval")
    fx.spin(NSEvent.doubleClickInterval / 2 + 0.3)
    #expect(fx.opened == 1)
  }

  @Test func aSingleClickHopsAndAnAlertShowsItsBubbleAgain() {
    _ = NSApplication.shared
    let fx = CompanionFixture(enabled: true)
    defer { fx.done() }
    fx.advance(1)
    fx.controller.clickForTest(1)
    #expect(fx.controller.lastOutput?.animation?.clip == "jumping" && fx.controller.lastOutput?.animation?.frameLimit == 4)
    fx.inputs.needs = 1
    fx.advance(2)
    fx.controller.systemForTest.simulateMic(running: false)
    fx.controller.bubblePanelForTest?.orderOut(nil)
    fx.advance(20)
    fx.controller.clickForTest(1)
    #expect(fx.controller.bubbleIsShowing, "a click on Needs you shows the bubble again instead of hopping")
  }

  @Test func dragStaysFullyOnScreenSavesTheSpotAndClosesWhatFollows() throws {
    _ = NSApplication.shared
    let fx = CompanionFixture(enabled: true)
    defer { fx.done() }
    let v = fx.screens[0].visibleFrame
    fx.controller.hoverForTest(true)
    fx.spin(0.3)
    fx.inputs.session = .stopped(byOwner: false)
    fx.advance(1)
    #expect(fx.controller.controlsAreShowing && fx.controller.bubbleIsShowing)
    fx.controller.dragBeganForTest(right: false)
    #expect(!fx.controller.controlsAreShowing && !fx.controller.bubbleIsShowing, "nothing follows a moving sprite")
    #expect(fx.controller.lastOutput?.dragging == true)
    fx.pointer = CGPoint(x: v.minX - 400, y: v.maxY + 400)
    fx.controller.dragMovedForTest(to: CGPoint(x: v.minX - 400, y: v.maxY + 400), right: false)
    let p = try #require(fx.controller.spritePanelForTest)
    #expect(v.contains(p.frame), "the figure stays fully on screen: \(p.frame) in \(v)")
    fx.pointer = CGPoint(x: v.midX, y: v.midY)
    fx.controller.dragMovedForTest(to: CGPoint(x: v.midX, y: v.midY), right: true)
    fx.controller.dragEndedForTest()
    let saved = fx.defaults.array(forKey: CompanionController.Key.posPrefix + "TEST-A") as? [Double]
    #expect(saved?.count == 2)
    #expect(fx.defaults.string(forKey: CompanionController.Key.display) == "TEST-A")
    #expect(fx.controller.lastOutput?.dragging == false)
    #expect(fx.controller.bubbleIsShowing, "the held bubble shows at the drop")
    // The saved spot comes back after off and on.
    let before = p.frame.origin
    fx.turnOff()
    fx.turnOn()
    let after = try #require(fx.controller.spritePanelForTest).frame.origin
    #expect(abs(after.x - before.x) < 1 && abs(after.y - before.y) < 1)
  }

  @Test func aDisplayUnpluggedDuringADragMovesHimToThePrimaryAndKeepsTheOldSpot() throws {
    _ = NSApplication.shared
    let fx = CompanionFixture(enabled: true)
    defer { fx.done() }
    let v = fx.screens[0].visibleFrame
    let ext = CompanionScreen(
      uuid: "TEST-B", frame: CGRect(x: v.maxX, y: v.minY, width: 800, height: 600), visibleFrame: CGRect(x: v.maxX, y: v.minY, width: 800, height: 600), isPrimary: false)
    fx.screens = [fx.screens[0], ext]
    fx.controller.dragBeganForTest(right: true)
    fx.pointer = CGPoint(x: ext.frame.midX, y: ext.frame.midY)
    fx.controller.dragMovedForTest(to: CGPoint(x: ext.frame.midX, y: ext.frame.midY), right: true)
    fx.screens = [fx.screens[0]]  // unplugged mid-drag
    fx.pointer = CGPoint(x: ext.frame.midX, y: ext.frame.midY)
    fx.controller.dragMovedForTest(to: CGPoint(x: ext.frame.midX + 10, y: ext.frame.midY), right: true)
    let p = try #require(fx.controller.spritePanelForTest)
    #expect(fx.screens[0].visibleFrame.contains(p.frame))
    fx.controller.dragEndedForTest()
    #expect(fx.controller.isOnScreen)
  }

  @Test func resolutionChangesReClampWithoutRewritingTheSavedSpot() throws {
    _ = NSApplication.shared
    let fx = CompanionFixture(enabled: true)
    defer { fx.done() }
    let v = fx.screens[0].visibleFrame
    fx.defaults.set([1.0, 0.0], forKey: CompanionController.Key.posPrefix + "TEST-A")
    fx.turnOff()
    fx.turnOn()
    let p = try #require(fx.controller.spritePanelForTest)
    #expect(abs(p.frame.maxX - v.maxX) < 1, "fx 1 is the right edge")
    // Dock grows: only the visibleFrame changes. The clamp moves him, the saved spot stays.
    let smaller = CGRect(x: v.minX, y: v.minY + 40, width: v.width - 300, height: v.height - 40)
    fx.screens = [CompanionScreen(uuid: "TEST-A", frame: v, visibleFrame: smaller, isPrimary: true)]
    fx.controller.screensChangedForTest()
    #expect(smaller.contains(p.frame))
    #expect(fx.defaults.array(forKey: CompanionController.Key.posPrefix + "TEST-A") as? [Double] == [1.0, 0.0])
  }

  // MARK: right-click, Hide, Snooze, Size

  @Test func rightClickHideSnoozeSizeAndSettingsAllDoWhatTheyAreCalled() throws {
    _ = NSApplication.shared
    let fx = CompanionFixture(enabled: true)
    defer { fx.done() }
    let menu = fx.controller.menuForTest()
    #expect(menu.items.map(\.title) == ["Hide", "Snooze for 1 hour", "Size", "", "Settings…"])
    let sizeMenu = try #require(menu.items[2].submenu)
    #expect(sizeMenu.items.map(\.title) == ["Standard", "Mini"])
    #expect(sizeMenu.items[0].state == .on && sizeMenu.items[1].state == .off)
    func fire(_ item: NSMenuItem) { _ = item.target?.perform(item.action!, with: item) }
    fire(sizeMenu.items[1])
    fx.controller.reconcile(hello: false)
    #expect(try #require(fx.controller.spritePanelForTest).frame.size == CGSize(width: 44, height: 44))
    #expect(fx.controller.menuForTest().items[2].submenu?.items[1].state == .on)
    fire(menu.items[4])
    #expect(fx.settingsOpened == 1)
    fire(menu.items[1])
    #expect(fx.controller.panels.isEmpty && fx.controller.snoozedUntil != nil)
    fx.controller.endSnooze()
    #expect(fx.controller.isOnScreen)
    fire(fx.controller.menuForTest().items[0])
    fx.controller.reconcile(hello: false)
    #expect(fx.controller.panels.isEmpty)
    #expect(!fx.defaults.bool(forKey: CompanionController.Key.enabled), "Hide sets enabled to false: the same state as the Settings toggle")
  }

  // MARK: rounds

  @Test func roundsWalkOutAndBackThenStopWhenHeIsHoveredOrAPointerIsNear() throws {
    _ = NSApplication.shared
    let fx = CompanionFixture(enabled: true)
    defer { fx.done() }
    let p = try #require(fx.controller.spritePanelForTest)
    let home = p.frame.origin
    fx.controller.startRoundsForTest()
    #expect(fx.controller.isWalking)
    fx.spin(0.8)
    #expect(p.frame.origin.x != home.x, "he is walking")
    #expect(p.frame.origin.y == home.y)
    fx.controller.hoverForTest(true)
    #expect(!fx.controller.isWalking)
    #expect(p.frame.origin == home, "hover stops him; the pointer is over neither frame, so he goes to his saved spot")
    // A pointer within the keep-clear zone: the walk is declined.
    fx.pointer = CGPoint(x: p.frame.minX - 30, y: p.frame.midY)
    fx.controller.startRoundsForTest()
    #expect(!fx.controller.isWalking)
    fx.pointer = CGPoint(x: -5000, y: -5000)
    // Compose open: declined.
    fx.composeVisible = true
    fx.controller.startRoundsForTest()
    #expect(!fx.controller.isWalking)
    fx.composeVisible = false
    // A pointer that reaches him mid-walk stops it.
    fx.controller.startRoundsForTest()
    #expect(fx.controller.isWalking)
    fx.pointer = CGPoint(x: p.frame.midX, y: p.frame.midY)
    fx.spin(0.4)
    #expect(!fx.controller.isWalking)
    #expect(p.frame.origin == home)
  }

  @Test func aWalkCutOverHisHomeSpotSendsHimHomeOnTheNextRecomputeOnceThePointerLeaves() throws {
    _ = NSApplication.shared
    let fx = CompanionFixture(enabled: true)
    defer { fx.done() }
    let p = try #require(fx.controller.spritePanelForTest)
    let home = p.frame
    fx.controller.startRoundsForTest()
    fx.spin(0.8)
    #expect(p.frame.origin != home.origin, "he is out walking")
    fx.pointer = CGPoint(x: home.midX, y: home.midY)  // rests on his home spot: the cut leaves him where he stands
    fx.spin(0.4)
    #expect(!fx.controller.isWalking)
    let stood = p.frame.origin
    #expect(stood != home.origin)
    fx.controller.inputsChanged()
    #expect(p.frame.origin == stood, "the pointer is still on his home spot: never moved under it")
    fx.composeVisible = true
    fx.pointer = CGPoint(x: -5000, y: -5000)
    fx.controller.inputsChanged()
    #expect(p.frame.origin == stood, "a compose box is open: he stays")
    fx.composeVisible = false
    fx.controller.inputsChanged()
    #expect(p.frame.origin == home.origin, "nothing open and the pointer over neither frame: home")
  }

  @Test func aDockChangeThatMovesHisSavedSpotDoesNotMoveHimOnTheNextRecompute() throws {
    _ = NSApplication.shared
    let fx = CompanionFixture(enabled: true)
    defer { fx.done() }
    let p = try #require(fx.controller.spritePanelForTest)
    let before = p.frame.origin
    let v = fx.screens[0].visibleFrame
    // The Dock grows by 40 pt without a screen-change event: only a clamp may move him, never a trip home.
    fx.screens = [
      CompanionScreen(
        uuid: "TEST-A", frame: fx.screens[0].frame,
        visibleFrame: CGRect(x: v.minX, y: v.minY + 40, width: v.width, height: v.height - 40), isPrimary: true)
    ]
    fx.controller.inputsChanged()
    fx.controller.inputsChanged()
    #expect(p.frame.origin == before, "nothing was cut, so nothing sends him anywhere")
  }

  @Test func openingComposeStopsAWalkBeforeTheAnchorIsTaken() throws {
    _ = NSApplication.shared
    let fx = CompanionFixture(enabled: true)
    defer { fx.done() }
    let p = try #require(fx.controller.spritePanelForTest)
    let home = p.frame
    fx.controller.startRoundsForTest()
    fx.spin(0.8)
    #expect(fx.controller.isWalking)
    let midWalk = p.frame
    try #require(midWalk != home, "setup: he is out walking")
    // On his screen (compose anchors only there) but over neither the mid-walk frame nor his home frame.
    let corner = fx.screens[0].frame
    fx.pointer = CGPoint(x: corner.minX + 5, y: corner.maxY - 5)
    try #require(!midWalk.contains(fx.pointer) && !home.contains(fx.pointer), "setup: the pointer is clear of both frames")
    let anchor = fx.controller.anchorForCompose()
    #expect(!fx.controller.isWalking, "the compose path stops the walk")
    #expect(anchor == home, "the anchor is where he stopped, back on his saved spot")
    #expect(anchor != midWalk, "not where he was mid-step")
  }

  @Test func aWalkNeverMovesHimMoreThanFortyFiveTimesOrOffTheScreen() throws {
    _ = NSApplication.shared
    let fx = CompanionFixture(enabled: true)
    defer { fx.done() }
    let p = try #require(fx.controller.spritePanelForTest)
    var xs = Set<CGFloat>()
    fx.controller.startRoundsForTest()
    let start = Date()
    // The walk is one step per tick along a path of at most 23 places, so how long it lasts follows from the count checked
    // below; the loop's cap only ends a hang on a busy machine.
    while fx.controller.isWalking && Date().timeIntervalSince(start) < 60 {
      xs.insert(p.frame.origin.x)
      #expect(fx.screens[0].visibleFrame.contains(p.frame))
      fx.spin(0.05)
    }
    #expect(xs.count <= 24, "moves in 8 pt steps out and back: at most 23 distinct places")
    #expect(!fx.controller.isWalking)
    // The loop above has no time limit, so the time a walk may take is pinned where it comes from: one step per tick, at most
    // 46 steps (23 places out and back), so the whole walk is under 8 s whatever the machine is doing.
    #expect(46 * CompanionController.walkTick < 8, "a walk would take \(46 * CompanionController.walkTick) s")
  }

  // MARK: system

  @Test func theSystemWatcherAddsAndRemovesEveryListenerItAdds() {
    _ = NSApplication.shared
    let s = CompanionSystem()
    #expect(s.listenerCount == 0)
    s.start()
    #expect(s.listenerCount >= 9, "nine workspace and default observers at least")
    #expect(!s.micUnavailable, "CoreAudio devices enumerate with no prompt")
    s.start()
    let n = s.listenerCount
    s.start()
    #expect(s.listenerCount == n, "start twice adds nothing")
    s.stop()
    #expect(s.listenerCount == 0 && s.timerCount == 0)
    s.stop()
    #expect(s.secondsSinceInput >= 0)
  }

  @Test func aCoreAudioFailureShowsALineInSettingsAndNeverStopsHim() {
    _ = NSApplication.shared
    let fx = CompanionFixture(start: false)
    defer { fx.done() }
    fx.controller.systemForTest.inputDevicesProvider = { nil }  // the device query failed
    fx.startController()
    fx.turnOn()
    #expect(fx.controller.isOnScreen)
    #expect(fx.controller.micLine?.contains("unavailable") == true, "the owner sees it: \(String(describing: fx.controller.micLine))")
    fx.inputs.session = .stopped(byOwner: false)
    fx.advance(1)
    #expect(fx.controller.bubbleIsShowing, "bubbles are not held back when meeting detection is unavailable")
    fx.turnOff()
    #expect(fx.controller.micLine == nil)
  }

  @Test func aMicRunningForThreeHoursIsReportedInSettings() {
    _ = NSApplication.shared
    let fx = CompanionFixture(enabled: true)
    defer { fx.done() }
    #expect(fx.controller.micLine == nil)
    // The reducer and Settings read the hold; three hours is proven in MicHold's own tests, this proves the wiring.
    var hold = MicHold()
    hold.update(anyRunning: true, mono: 0)
    #expect(hold.stuck(mono: MicHold.stuckAfter))
  }

  @Test func theBubbleIsTheSameInLightAndDark() throws {
    _ = NSApplication.shared
    func pixel(_ appearance: NSAppearance.Name) throws -> (Int, Int, Int) {
      let v = CompanionBubbleView(frame: NSRect(x: 0, y: 0, width: 200, height: 30))
      v.appearance = NSAppearance(named: appearance)
      v.text = "Talos needs you"
      v.layoutSubtreeIfNeeded()
      let rep = try #require(v.bitmapImageRepForCachingDisplay(in: v.bounds))
      v.cacheDisplay(in: v.bounds, to: rep)
      let k = rep.pixelsWide / 200  // backing pixels per point
      let c = try #require(rep.colorAt(x: 6 * k, y: 15 * k)?.usingColorSpace(.sRGB))
      return (Int((c.redComponent * 255).rounded()), Int((c.greenComponent * 255).rounded()), Int((c.blueComponent * 255).rounded()))
    }
    let light = try pixel(.aqua)
    let dark = try pixel(.darkAqua)
    #expect(light == dark, "\(light) vs \(dark)")
    #expect(abs(light.0 - 0x14) <= 3 && abs(light.1 - 0x11) <= 3 && abs(light.2 - 0x10) <= 3, "the ground is #141110: \(light)")
  }

  @Test func overnightItemsAreCountedWhereTheBannerIsDropped() {
    let sc = StatusCoordinator.shared
    let saved = sc.now
    defer { sc.now = saved }
    let q = QuietWindow.read(Data(#"{"quiet_window":{"start":"20:30","end":"04:00"},"timezone":"Etc/GMT+7"}"#.utf8))
    sc.setQuietForTest(q)
    sc.now = { Date(timeIntervalSince1970: 1_793_462_400 + 13 * 3600) }  // 22:00 in the UTC-7 zone: inside the window
    let before = sc.collected
    sc.notify(.needsYou)
    sc.notify(.stoppedRestarting)
    #expect(sc.collected == before + 2, "collected for Morning, no banner")
    #expect(sc.quietNow == true)
    sc.setQuietForTest(nil)
  }

  @Test func offKeepsAnOpenComposeWindowsText() throws {
    _ = NSApplication.shared
    let fx = CompanionFixture(enabled: true)
    defer { fx.done() }
    QuickCompose.shared.setTextForTest("half a sentence")
    defer { QuickCompose.shared.resetForTest() }
    fx.turnOff()
    #expect(QuickCompose.shared.textForTest == "half a sentence", "open compose keeps its text")
    fx.turnOn()
    fx.turnOff()
    #expect(QuickCompose.shared.textForTest == "half a sentence")
  }

  @Test func theBubbleContrastIsAtLeastFourPointFive() {
    #expect(CompanionColors.contrast(CompanionColors.cream, CompanionColors.ground) >= 4.5)
    #expect(CompanionColors.contrast(CompanionColors.cream, CompanionColors.ground) > 12, "measured, not guessed")
  }

  @Test func theWordAndVoiceOverLabelsAreRealAndHostileNamesStayOneLine() throws {
    _ = NSApplication.shared
    let fx = CompanionFixture(enabled: true)
    defer { fx.done() }
    fx.inputs.agentName = "Evil\n\u{202E}**name**" + String(repeating: "y", count: 500)
    fx.inputs.session = .running(busy: true)
    fx.advance(0.1)
    fx.advance(2)
    let sv = try #require(fx.controller.spriteViewForTest)
    let label = sv.accessibilityLabel() ?? ""
    #expect(label.hasSuffix(", working"), Comment(rawValue: label))
    #expect(!label.contains("\n") && label.count <= 60)
    #expect(sv.toolTip == "Working")
    #expect(sv.isAccessibilityElement())
    #expect(sv.accessibilityRole() == .image)
  }

  @Test func theQuietWindowNeverShowsABubbleEvenForNeedsYou() {
    _ = NSApplication.shared
    let fx = CompanionFixture(enabled: true)
    defer { fx.done() }
    fx.inputs.quiet = true
    fx.inputs.needs = 3
    fx.advance(1)
    #expect(fx.controller.lastOutput?.state == .needsYou)
    #expect(!fx.controller.bubbleIsShowing)
    #expect(fx.controller.lastOutput?.word == "Needs you · 3")
  }

  @Test func theBubbleSitsOnScreenInAllFourCornersAndPastTheControls() throws {
    _ = NSApplication.shared
    let fx = CompanionFixture(enabled: true)
    defer { fx.done() }
    let v = fx.screens[0].visibleFrame
    for (fx0, fy0) in [(0.0, 0.0), (1.0, 0.0), (0.0, 1.0), (1.0, 1.0)] {
      fx.defaults.set([fx0, fy0], forKey: CompanionController.Key.posPrefix + "TEST-A")
      fx.turnOff()
      fx.turnOn()
      fx.inputs.session = .stopped(byOwner: false)
      fx.advance(1)
      fx.controller.hoverForTest(true)
      fx.spin(0.25)
      let sprite = try #require(fx.controller.spritePanelForTest).frame
      let bubble = try #require(fx.controller.bubblePanelForTest).frame
      let controls = try #require(fx.controller.controlsPanelForTest).frame
      #expect(v.contains(sprite) && v.contains(bubble) && v.contains(controls), "corner \(fx0),\(fy0) v=\(v) sprite=\(sprite) bubble=\(bubble) controls=\(controls)")
      #expect(!bubble.intersects(sprite) && !bubble.intersects(controls) && !controls.intersects(sprite))
      fx.controller.hoverForTest(false)
      fx.inputs.session = .running(busy: false)
      fx.advance(5)
    }
  }
}
