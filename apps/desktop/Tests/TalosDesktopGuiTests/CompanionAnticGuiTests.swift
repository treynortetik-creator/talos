import AppKit
import CoreGraphics
import ImageIO
import QuartzCore
import Testing
import UniformTypeIdentifiers

@testable import TalosDesktop
@testable import TalosDesktopCore

/// The idle antics through the real sprite view and the real bundled art: no window, no screen, no sound. Each clip is handed to
/// the view the way the controller hands it (an output with an animation), the keyframes the view builds are read back, and every
/// frame is drawn from the layer tree. Set `TALOS_RENDER_OUT` to keep the frames (the contact sheet is made from them).
@MainActor
@Suite("Companion antics render", .serialized, .guiExclusive, .enabled(if: guiTestsEnabled))
struct CompanionAnticGuiTests {
  static let art = CompanionRenderGuiTests.art
  static let clips = ["sit", "nap", "stretch", "scratch", "stumble", "tinker", "sleep", "wake", "wake-low"]

  func output(rest: CompanionRest = .idle, state: CompanionState = .idle, animation: CompanionAnimation? = nil, stop: Int = 0) -> CompanionOutput {
    CompanionOutput(
      state: state, displayState: state, quiet: false, animation: animation, rest: rest, bubble: nil, word: "w", accessibilityLabel: "w",
      dot: false, dragging: false, roundsDue: false, anticStop: stop, nextDeadline: nil)
  }

  func view(scale: Int) throws -> (CompanionSpriteView, LoadedAtlas) {
    _ = NSApplication.shared
    guard case .success(let atlas) = LoadedAtlas.load(directory: Self.art, scale: scale, mini: false) else {
      throw CompanionRenderGuiTests.Failure("real art did not load")
    }
    let v = CompanionSpriteView(frame: NSRect(origin: .zero, size: CompanionPlacement.size(mini: false)))
    v.setAtlas(atlas, mini: false)
    return (v, atlas)
  }

  func render(_ v: CompanionSpriteView, scale: Int) throws -> CGImage {
    v.layoutSubtreeIfNeeded()
    let w = Int(v.bounds.width) * scale, h = Int(v.bounds.height) * scale
    let ctx = try #require(
      CGContext(data: nil, width: w, height: h, bitsPerComponent: 8, bytesPerRow: w * 4, space: CGColorSpace(name: CGColorSpace.sRGB)!, bitmapInfo: CGImageAlphaInfo.premultipliedLast.rawValue))
    ctx.scaleBy(x: CGFloat(scale), y: CGFloat(scale))
    v.layer!.render(in: ctx)
    return try #require(ctx.makeImage())
  }

  func opaque(_ img: CGImage) -> Int {
    let w = img.width, h = img.height
    var px = [UInt8](repeating: 0, count: w * h * 4)
    let ctx = CGContext(data: &px, width: w, height: h, bitsPerComponent: 8, bytesPerRow: w * 4, space: CGColorSpace(name: CGColorSpace.sRGB)!, bitmapInfo: CGImageAlphaInfo.premultipliedLast.rawValue)!
    ctx.draw(img, in: CGRect(x: 0, y: 0, width: w, height: h))
    return stride(from: 3, to: px.count, by: 4).reduce(0) { $0 + (px[$1] > 200 ? 1 : 0) }
  }

  func save(_ img: CGImage, as name: String) throws {
    guard let out = ProcessInfo.processInfo.environment["TALOS_RENDER_OUT"], !out.isEmpty else { return }
    try FileManager.default.createDirectory(atPath: out, withIntermediateDirectories: true)
    let url = URL(fileURLWithPath: out).appendingPathComponent(name + ".png")
    let dest = try #require(CGImageDestinationCreateWithURL(url as CFURL, UTType.png.identifier as CFString, 1, nil))
    CGImageDestinationAddImage(dest, img, nil)
    #expect(CGImageDestinationFinalize(dest), "\(name).png written")
  }

  @Test(arguments: [1, 2])
  func everyNewClipLoadsPlaysThroughTheRealViewAndEveryFrameDraws(scale: Int) throws {
    for name in Self.clips {
      let (v, atlas) = try view(scale: scale)
      let clip = try #require(atlas.manifest.clip(name), "\(name)")
      let anim = CompanionAnimation(clip: name, seq: 1)
      v.apply(CompanionLook(output: output(rest: name == "sleep" ? .nap : .idle, animation: anim), stillOnly: false, animationsAllowed: true, mini: false))
      #expect(!v.isShowingFallback, "\(name): the app icon fallback is showing")
      #expect(v.playingClip == name, "\(name) is playing")
      #expect(v.clipTimerCount == 1, "\(name): one one-shot timer ends it, nothing per frame")
      let ka = try #require(v.spriteLayerForTest.animation(forKey: "frames") as? CAKeyframeAnimation, "\(name) has no frame animation")
      #expect(ka.calculationMode == .discrete)
      let values = try #require(ka.values).map { ($0 as! NSValue).rectValue }
      #expect(values.count == clip.frames.count, "\(name): \(values.count) keyframes for \(clip.frames.count) frames")
      #expect(abs(ka.duration - Double(clip.totalMs) / 1000) < 0.001, "\(name): the view plays \(ka.duration) s, the manifest says \(clip.totalMs) ms")
      // Reading the keyframes back gives the manifest's cells, on the antics sheet (not one of the other two).
      let g = atlas.manifest.grid(.talosLife)
      for (f, r) in zip(clip.frames, values) {
        #expect(abs(r.origin.x - Double(f.col) / Double(g.columns)) < 1e-9, "\(name) col \(f.col): x \(r.origin.x)")
        #expect(abs(r.origin.y - (1.0 - Double(clip.row + 1) / Double(g.rows))) < 1e-9, "\(name): row \(clip.row), y \(r.origin.y)")
        #expect(abs(r.width - 1.0 / Double(g.columns)) < 1e-9 && abs(r.height - 1.0 / Double(g.rows)) < 1e-9)
      }
      #expect(v.emberIsHidden, "\(name): no ember layer over an antic (the glow is in the body)")
      // Draw every distinct frame from the layer tree, the way the screen would.
      var seen = Set<Int>()
      for (i, f) in clip.frames.enumerated() where !seen.contains(f.col) {
        seen.insert(f.col)
        v.spriteLayerForTest.removeAllAnimations()
        v.spriteLayerForTest.contentsRect = values[i]
        let img = try render(v, scale: scale)
        let total = 96 * 104 * scale * scale
        #expect(opaque(img) > total / 30, "\(name) col \(f.col) \(scale)x: \(opaque(img)) of \(total) opaque, nearly blank")
        try save(img, as: "life-\(name)-\(f.col)-\(scale)x")
      }
    }
  }

  @Test func theAsleepNapIsOneStillFrameWithNoAnimationNoTimerAndNoEmber() throws {
    for animated in [true, false] {
      let (v, atlas) = try view(scale: 2)
      v.apply(CompanionLook(output: output(rest: .nap, state: .asleep), stillOnly: !animated, animationsAllowed: animated, mini: false))
      let nap = try #require(atlas.manifest.clip("nap"))
      #expect(v.spriteContentsRect == atlas.manifest.contentsRect(sheet: .talosLife, col: nap.still, row: nap.row), "the nap's lying frame")
      #expect(v.attachedAnimationCount == 0, "Asleep runs nothing (animated look: \(animated))")
      #expect(v.clipTimerCount == 0)
      #expect(v.emberIsHidden)
      #expect(!v.isShowingFallback)
      let img = try render(v, scale: 2)
      #expect(opaque(img) > 96 * 104 * 4 / 30)
      try save(img, as: "life-asleep-rest")
    }
  }

  @Test func reduceMotionAndLowPowerShowTheStillOfAnAnticAndAttachNothing() throws {
    let (v, _) = try view(scale: 2)
    let anim = CompanionAnimation(clip: "sit", seq: 1)
    v.apply(CompanionLook(output: output(animation: anim), stillOnly: true, animationsAllowed: true, mini: false))
    #expect(v.attachedAnimationCount == 0, "a still look attaches no animation")
    #expect(v.playingClip == nil, "a still look never plays the clip")
    #expect(v.clipTimerCount == 0)
    #expect(v.spriteLayerForTest.animation(forKey: "frames") == nil)
  }

  @Test func theIdleBobIsSteppedOnBothLayersOnTheEmbersPeriodAndGoneForAClipAndAStillForArtWithoutTheLoops() throws {
    _ = NSApplication.shared
    let tmp = try CompanionRenderGuiTests.artWithoutLoops()
    defer { try? FileManager.default.removeItem(at: tmp) }
    let atlas = try LoadedAtlas.load(directory: tmp, scale: 2, mini: false).get()
    let v = CompanionSpriteView(frame: NSRect(origin: .zero, size: CompanionPlacement.size(mini: false)))
    v.setAtlas(atlas, mini: false)
    v.apply(CompanionLook(output: output(), stillOnly: false, animationsAllowed: true, mini: false))
    let bob = try #require(v.spriteLayerForTest.animation(forKey: "breath") as? CAKeyframeAnimation, "the sprite bobs at rest")
    #expect(bob.keyPath == "transform.translation.y")
    #expect(bob.calculationMode == .discrete, "stepped: a smooth animation would keep WindowServer at full refresh")
    #expect(bob.repeatCount == .infinity)
    #expect((bob.values as? [NSNumber])?.map(\.doubleValue) == CompanionAtlas.breathLifts)
    #expect(bob.keyTimes?.count == CompanionAtlas.breathLifts.count + 1)
    let glowBob = try #require(v.emberLayerForTest.animation(forKey: "breath") as? CAKeyframeAnimation, "the glow bobs with him")
    let steps = try #require(v.emberLayerForTest.animation(forKey: "ember") as? CAKeyframeAnimation)
    #expect(bob.duration == steps.duration && glowBob.duration == steps.duration, "the bob steps on the ember's own period")
    for layer in [v.spriteLayerForTest, v.emberLayerForTest] {
      for k in layer.animationKeys() ?? [] { #expect(!(layer.animation(forKey: k) is CABasicAnimation), "\(k) is a smooth animation") }
    }
    v.apply(CompanionLook(output: output(animation: CompanionAnimation(clip: "stretch", seq: 1)), stillOnly: false, animationsAllowed: true, mini: false))
    #expect(v.spriteLayerForTest.animation(forKey: "breath") == nil, "a clip is its own motion")
    #expect(v.attachedAnimationCount == 1)
    v.apply(CompanionLook(output: output(), stillOnly: true, animationsAllowed: true, mini: false))
    #expect(v.attachedAnimationCount == 0, "Reduce Motion: no bob, no blink")
  }

  @Test func aNewAnticStopCutsARunningAnticOrIdleWaveToItsRestAndLeavesOtherClipsAlone() throws {
    let (v, _) = try view(scale: 2)
    v.apply(CompanionLook(output: output(animation: CompanionAnimation(clip: "stretch", seq: 1)), stillOnly: false, animationsAllowed: true, mini: false))
    #expect(v.playingClip == "stretch")
    v.apply(CompanionLook(output: output(stop: 1), stillOnly: false, animationsAllowed: true, mini: false))
    #expect(v.playingClip == nil, "the antic is cut")
    #expect(v.clipTimerCount == 0)
    // The idle wave is part of the pool: the owner coming back mid-wave cuts it like the others.
    v.apply(CompanionLook(output: output(animation: CompanionAnimation(clip: "waving", seq: 2), stop: 1), stillOnly: false, animationsAllowed: true, mini: false))
    #expect(v.playingClip == "waving")
    v.apply(CompanionLook(output: output(stop: 2), stillOnly: false, animationsAllowed: true, mini: false))
    #expect(v.playingClip == nil, "the wave is cut")
    // A clip that is not an antic is left alone by the same stop value.
    v.apply(CompanionLook(output: output(animation: CompanionAnimation(clip: "talking", seq: 3), stop: 2), stillOnly: false, animationsAllowed: true, mini: false))
    #expect(v.playingClip == "talking")
    v.apply(CompanionLook(output: output(stop: 3), stillOnly: false, animationsAllowed: true, mini: false))
    #expect(v.playingClip == "talking", "an antic stop never cuts another clip")
  }

  @Test func anAnticThatRunsOutReturnsToIdleOnItsOwnWithoutAPerFrameTimer() throws {
    let (v, _) = try view(scale: 2)
    v.apply(CompanionLook(output: output(animation: CompanionAnimation(clip: "stumble", seq: 1)), stillOnly: false, animationsAllowed: true, mini: false))
    #expect(v.playingClip == "stumble")
    let until = Date().addingTimeInterval(4)
    while v.playingClip != nil, Date() < until { RunLoop.main.run(until: Date().addingTimeInterval(0.05)) }
    #expect(v.playingClip == nil, "the clip's one-shot timer ended it")
    #expect(v.clipTimerCount == 0)
  }

  @Test func theWakeFromANapStartsLyingAndEndsStanding() throws {
    let (v, atlas) = try view(scale: 2)
    v.apply(CompanionLook(output: output(animation: CompanionAnimation(clip: "wake", seq: 1)), stillOnly: false, animationsAllowed: true, mini: false))
    let ka = try #require(v.spriteLayerForTest.animation(forKey: "frames") as? CAKeyframeAnimation)
    let rects = try #require(ka.values).map { ($0 as! NSValue).rectValue }
    let nap = try #require(atlas.manifest.clip("nap"))
    #expect(rects.first == atlas.manifest.contentsRect(sheet: .talosLife, col: nap.still, row: nap.row))
    #expect(rects.last == atlas.manifest.contentsRect(sheet: .talosLife, col: 0, row: nap.row))
  }

  @Test func theLowWakeStartsSeatedAndEndsStanding() throws {
    let (v, atlas) = try view(scale: 2)
    v.apply(CompanionLook(output: output(animation: CompanionAnimation(clip: "wake-low", seq: 1)), stillOnly: false, animationsAllowed: true, mini: false))
    let ka = try #require(v.spriteLayerForTest.animation(forKey: "frames") as? CAKeyframeAnimation)
    let rects = try #require(ka.values).map { ($0 as! NSValue).rectValue }
    let nap = try #require(atlas.manifest.clip("nap"))
    #expect(rects.first == atlas.manifest.contentsRect(sheet: .talosLife, col: 2, row: nap.row), "the seated cell, not the lying one")
    #expect(rects.last == atlas.manifest.contentsRect(sheet: .talosLife, col: 0, row: nap.row))
  }

  @Test func roundsFromTheNapGetHimUpBeforeHeRuns() throws {
    _ = NSApplication.shared
    let fx = CompanionFixture(art: Self.art.path, enabled: true)
    defer { fx.done() }
    fx.makeAsleep()
    fx.controller.envAdjust = { $0.secondsSinceInput = 5 }
    let sv = try #require(fx.controller.spriteViewForTest)
    #expect(fx.controller.lastOutput?.rest == .nap)
    let timersBefore = fx.controller.activeTimerCount
    fx.controller.startRoundsForTest()
    #expect(fx.controller.isWalking)
    fx.spin(0.3)
    #expect(sv.playingClip?.hasPrefix("wake") == true, "getting up first, \(String(describing: sv.playingClip))")
    fx.spin(2.5)
    #expect(sv.playingClip?.hasPrefix("running-") == true, "then running, \(String(describing: sv.playingClip))")
    fx.untilWalkEnds()
    #expect(!fx.controller.isWalking)
    #expect(fx.controller.activeTimerCount <= timersBefore, "no walk timer outlives the walk: \(fx.controller.activeTimerCount) vs \(timersBefore)")
  }

  @Test func aWalkCutWhileHeIsStillGettingUpLeavesNoTimerBehind() throws {
    _ = NSApplication.shared
    let fx = CompanionFixture(art: Self.art.path, enabled: true)
    defer { fx.done() }
    fx.makeAsleep()
    fx.controller.envAdjust = { $0.secondsSinceInput = 5 }
    let timersBefore = fx.controller.activeTimerCount
    fx.controller.startRoundsForTest()
    #expect(fx.controller.isWalking)
    #expect(fx.controller.walkTimerIsLive, "the get-up delay is a live timer")
    fx.controller.stopWalkForTest()
    #expect(!fx.controller.isWalking)
    #expect(!fx.controller.walkTimerIsLive, "the delay died with the walk")
    #expect(fx.controller.activeTimerCount <= timersBefore, "\(fx.controller.activeTimerCount) vs \(timersBefore)")
    fx.spin(3)
    #expect(!fx.controller.isWalking, "the cancelled delay did not start a walk later")
  }

  // MARK: review fixes

  /// A fixture on the real art with only the sit antic in the pool, the owner at the keyboard.
  func sitFixture() -> CompanionFixture {
    let fx = CompanionFixture(art: Self.art.path, enabled: true)
    fx.controller.envAdjust = { $0.secondsSinceInput = 1; $0.antics = ["sit": 7.02] }
    return fx
  }

  @Test func aLongMacSleepEndsInTheNapThroughTheRealWakePath() throws {
    _ = NSApplication.shared
    let fx = CompanionFixture(enabled: true)
    defer { fx.done() }
    fx.advance(60)
    #expect(fx.controller.lastOutput?.state == .idle)
    fx.wall += 8 * 3600  // the lid closed: the wall clock ran and the uptime clock the model uses stood still (sleep is not counted)
    fx.controller.wakeForTest()
    #expect(fx.controller.lastOutput?.state == .asleep, "the model is told about the sleep before anything refreshes its clock")
    #expect(fx.controller.lastOutput?.rest == .nap)
  }

  @Test func aShortLidCloseDoesNotNap() throws {
    _ = NSApplication.shared
    let fx = CompanionFixture(enabled: true)
    defer { fx.done() }
    fx.advance(60)
    fx.wall += 120
    fx.controller.wakeForTest()
    #expect(fx.controller.lastOutput?.state == .idle)
  }

  @Test func noAnticStartsWithTheComposeBoxOpenOrDuringAHover() throws {
    _ = NSApplication.shared
    let fx = sitFixture()
    defer { fx.done() }
    let sv = try #require(fx.controller.spriteViewForTest)
    fx.composeVisible = true
    fx.advance(200)
    #expect(sv.playingClip == nil, "compose is open")
    fx.advance(1)
    fx.composeVisible = false
    fx.advance(1)
    #expect(sv.playingClip == "sit", "due since compose opened, so it starts when compose closes: \(String(describing: sv.playingClip))")
  }

  /// The name of the extra clip `longAnticFixture` adds. It is a test clip: the shipped art and the idle pool know nothing of it.
  static let longClip = "long-antic"

  /// A fixture on a copy of the test art that has one more clip, as long as the old nap antic was (15.62 s), as the only antic in the
  /// pool (the env hook), the owner at the keyboard. A sit lasts 7.02 s and the old nap 15.62 s: this test was weaker on the sit.
  /// The caller removes the copy at `dir`.
  func longAnticFixture() throws -> (fx: CompanionFixture, dir: String) {
    let dir = NSTemporaryDirectory() + "companion-long-antic-\(UUID().uuidString)"
    try FileManager.default.copyItem(atPath: companionFixtures, toPath: dir)
    let url = URL(fileURLWithPath: dir + "/companion.json")
    var json = try #require(try JSONSerialization.jsonObject(with: Data(contentsOf: url)) as? [String: Any])
    var clips = try #require(json["clips"] as? [String: Any])
    let frames: [[Int]] = [[0, 4000], [1, 4000], [2, 4000], [0, 3620]]  // a frame may last 4 s at most
    try #require(frames.reduce(0) { $0 + $1[1] } == 15_620, "as long as the old nap")
    clips[Self.longClip] = ["atlas": "talos", "row": 8, "frames": frames, "loop": false, "still": 0] as [String: Any]
    json["clips"] = clips
    try JSONSerialization.data(withJSONObject: json).write(to: url)
    let fx = CompanionFixture(art: dir, enabled: true)
    let name = Self.longClip
    fx.controller.envAdjust = { $0.secondsSinceInput = 1; $0.antics = [name: 15.62] }
    return (fx, dir)
  }

  @Test func noAnticStartsDuringALongHover() throws {
    _ = NSApplication.shared
    let (fx, dir) = try longAnticFixture()
    defer {
      fx.done()
      try? FileManager.default.removeItem(atPath: dir)
    }
    let sv = try #require(fx.controller.spriteViewForTest)
    fx.controller.hoverForTest(true)  // no spin: the controls have not appeared yet, only the pointer is on him
    #expect(!fx.controller.controlsAreShowing)
    fx.advance(200)
    #expect(sv.playingClip != Self.longClip, "a pointer resting on him: \(String(describing: sv.playingClip))")
    fx.advance(1)
    #expect(sv.playingClip != Self.longClip)
  }

  @Test func aRejectedNapClipIsNamedInSettingsNotSilentlyTheStatue() throws {
    _ = NSApplication.shared
    let dir = NSTemporaryDirectory() + "companion-rejected-\(UUID().uuidString)"
    try FileManager.default.copyItem(atPath: Self.art.path, toPath: dir)
    defer { try? FileManager.default.removeItem(atPath: dir) }
    let url = URL(fileURLWithPath: dir + "/companion.json")
    var json = try #require(try JSONSerialization.jsonObject(with: Data(contentsOf: url)) as? [String: Any])
    var clips = try #require(json["clips"] as? [String: Any])
    var nap = try #require(clips["nap"] as? [String: Any])
    nap["row"] = 99  // outside the sheet: the loader refuses this clip
    clips["nap"] = nap
    json["clips"] = clips
    try JSONSerialization.data(withJSONObject: json).write(to: url)
    let fx = CompanionFixture(art: dir, enabled: true)
    defer { fx.done() }
    #expect(fx.controller.atlasIsLoaded, "the rest of the art still draws")
    #expect(fx.controller.artProblem?.contains("nap") == true, "Settings names the clip: \(fx.controller.artProblem ?? "nil")")
  }

  @Test func goodArtLeavesNoArtProblemLine() throws {
    _ = NSApplication.shared
    let fx = CompanionFixture(art: Self.art.path, enabled: true)
    defer { fx.done() }
    #expect(fx.controller.artProblem == nil, "\(fx.controller.artProblem ?? "")")
  }
}
