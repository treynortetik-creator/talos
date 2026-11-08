import AppKit
import CoreGraphics
import ImageIO
import QuartzCore
import Testing
import UniformTypeIdentifiers

@testable import TalosDesktop
@testable import TalosDesktopCore

/// Draws the real sprite view with the real bundled art, no window and no screen: the view's layer tree rendered into a bitmap on a
/// transparent background. The figure and the glow must be there, the app icon fallback must not be. Set `TALOS_RENDER_OUT` to
/// a folder to keep the PNGs (the worktree's `.build/render-proof`); without it the test still draws and checks.
@MainActor
@Suite("Companion render", .serialized, .guiExclusive, .enabled(if: guiTestsEnabled))
struct CompanionRenderGuiTests {
  static let art = URL(fileURLWithPath: #filePath).deletingLastPathComponent().appendingPathComponent("../../Resources/companion", isDirectory: true).standardized

  struct Pose {
    var name: String
    var state: CompanionState
    var rest: CompanionRest
  }
  static let standardPoses: [Pose] = [
    Pose(name: "idle", state: .idle, rest: .idle),
    Pose(name: "waving", state: .needsYou, rest: .holdStill("waving")),
    Pose(name: "running", state: .working, rest: .holdLast("running")),
    Pose(name: "waiting", state: .needsYou, rest: .holdStill("waiting")),
    Pose(name: "failed", state: .down, rest: .holdLast("failed")),
    Pose(name: "statue", state: .asleep, rest: .statue),
  ]

  func output(_ p: Pose, quiet: Bool = false) -> CompanionOutput {
    CompanionOutput(
      state: p.state, quiet: quiet, animation: nil, rest: p.rest, bubble: nil, word: p.name,
      accessibilityLabel: p.name, dot: false, dragging: false, roundsDue: false, anticStop: 0, nextDeadline: nil)
  }

  struct Rendered {
    var image: CGImage
    var opaque: Int
    var emberPixels: Int
  }

  /// The whole view layer tree, at `scale`, into a transparent bitmap. `emberPixels` counts the visible pixels of the
  /// ember layer alone, so a glow in the wrong place or a missing glow is a number and not a guess.
  func render(_ view: CompanionSpriteView, scale: Int) throws -> Rendered {
    view.layoutSubtreeIfNeeded()
    let w = Int(view.bounds.width) * scale
    let h = Int(view.bounds.height) * scale
    func bitmap(_ draw: (CGContext) -> Void) throws -> (CGImage, [UInt8]) {
      let cs = CGColorSpace(name: CGColorSpace.sRGB)!
      let ctx = try #require(
        CGContext(data: nil, width: w, height: h, bitsPerComponent: 8, bytesPerRow: w * 4, space: cs, bitmapInfo: CGImageAlphaInfo.premultipliedLast.rawValue))
      ctx.scaleBy(x: CGFloat(scale), y: CGFloat(scale))
      draw(ctx)
      let img = try #require(ctx.makeImage())
      let p = ctx.data!.assumingMemoryBound(to: UInt8.self)
      return (img, Array(UnsafeBufferPointer(start: p, count: w * h * 4)))
    }
    let (img, px) = try bitmap { view.layer!.render(in: $0) }
    var opaque = 0
    for i in stride(from: 3, to: px.count, by: 4) where px[i] > 200 { opaque += 1 }
    let ember = view.emberLayerForTest
    let wasHidden = ember.isHidden
    let (_, epx) = try bitmap { ctx in
      if !wasHidden { ember.render(in: ctx) }
    }
    var warm = 0
    for i in stride(from: 0, to: epx.count, by: 4) where epx[i + 3] > 60 { warm += 1 }
    return Rendered(image: img, opaque: opaque, emberPixels: warm)
  }

  func save(_ img: CGImage, as name: String) throws {
    guard let out = ProcessInfo.processInfo.environment["TALOS_RENDER_OUT"], !out.isEmpty else { return }
    try FileManager.default.createDirectory(atPath: out, withIntermediateDirectories: true)
    let url = URL(fileURLWithPath: out).appendingPathComponent(name + ".png")
    let dest = try #require(CGImageDestinationCreateWithURL(url as CFURL, UTType.png.identifier as CFString, 1, nil))
    CGImageDestinationAddImage(dest, img, nil)
    #expect(CGImageDestinationFinalize(dest), "\(name).png written")
  }

  /// The real art as an older build shipped it: no loops sheet and no loop clips. A copy in a temp folder; the caller removes it.
  static func artWithoutLoops() throws -> URL {
    let tmp = URL(fileURLWithPath: NSTemporaryDirectory() + "companion-noloops-\(UUID().uuidString)", isDirectory: true)
    try FileManager.default.copyItem(at: art, to: tmp)
    var m = try #require(try JSONSerialization.jsonObject(with: Data(contentsOf: tmp.appendingPathComponent("companion.json"))) as? [String: Any])
    var clips = m["clips"] as! [String: Any]
    var atlases = m["atlases"] as! [String: Any]
    for n in ["idle-loop", "idle-look", "needs-loop", "needs-beckon", "needs-tap"] { clips[n] = nil }
    atlases["talos-loops"] = nil
    m["clips"] = clips
    m["atlases"] = atlases
    try JSONSerialization.data(withJSONObject: m).write(to: tmp.appendingPathComponent("companion.json"))
    for f in ["talos-loops-1x.png", "talos-loops-2x.png"] { try FileManager.default.removeItem(at: tmp.appendingPathComponent(f)) }
    return tmp
  }

  func view(mini: Bool, scale: Int) throws -> CompanionSpriteView {
    _ = NSApplication.shared
    let atlas: LoadedAtlas
    switch LoadedAtlas.load(directory: Self.art, scale: scale, mini: mini) {
    case .success(let a): atlas = a
    case .failure(let e): throw Failure("real art did not load: \(e)")
    }
    let size = CompanionPlacement.size(mini: mini)
    let v = CompanionSpriteView(frame: NSRect(origin: .zero, size: size))
    v.setAtlas(atlas, mini: mini)
    return v
  }
  struct Failure: Error, CustomStringConvertible {
    var description: String
    init(_ d: String) { description = d }
  }

  @Test(arguments: [1, 2])
  func theStandardCharacterDrawsForEveryPoseWithItsGlowAndNoFallback(scale: Int) throws {
    for p in Self.standardPoses {
      let v = try view(mini: false, scale: scale)
      v.apply(CompanionLook(output: output(p), stillOnly: true, animationsAllowed: false, mini: false))
      #expect(!v.isShowingFallback, "\(p.name): the app icon fallback is showing")
      let r = try render(v, scale: scale)
      try save(r.image, as: "standard-\(p.name)-\(scale)x")
      // A figure fills a good part of its 96 x 104 cell; the icon square would be nearly all opaque, a blank cell nearly none.
      let total = 96 * 104 * scale * scale
      #expect(r.opaque > total / 20 && r.opaque < total * 3 / 4, "\(p.name) \(scale)x: \(r.opaque) of \(total) pixels opaque")
      if p.name == "statue" {
        #expect(v.emberIsHidden, "the statue has no glow")
      } else {
        #expect(!v.emberIsHidden, "\(p.name): the glow is missing")
        // Read straight from the JSON, not through the code under test: the clip's ember cell of the 11-cell sheet.
        let raw = try #require(try JSONSerialization.jsonObject(with: Data(contentsOf: Self.art.appendingPathComponent("companion.json"))) as? [String: Any])
        let clip = try #require(((raw["clips"] as? [String: Any])?[p.name]) as? [String: Any])
        let cell = try #require((clip["ember"] as? [String: Any])?["cell"] as? Int)
        let want = CGRect(x: Double(cell) / 11, y: 0, width: 1.0 / 11, height: 1)
        let got = v.emberLayerForTest.contentsRect
        #expect(abs(got.origin.x - want.origin.x) < 1e-9 && abs(got.width - want.width) < 1e-9 && got.height == 1, "\(p.name): glow shows \(got), wanted \(want)")
        #expect(r.emberPixels > 4 * scale * scale, "\(p.name) \(scale)x: glow drawn as \(r.emberPixels) pixels")
        // The glow is one cell of the 11-cell sheet, not the strip squeezed in: a squeezed strip is a wash across the whole cell.
        #expect(r.emberPixels < 400 * scale * scale, "\(p.name): glow too big: \(r.emberPixels)")
      }
    }
  }

  @Test(arguments: [1, 2])
  func theMiniCharacterDrawsForEveryPoseWithItsGlowAndNoFallback(scale: Int) throws {
    let looks: [(String, CompanionState, Bool)] = [
      ("pleased", .idle, false), ("worried", .down, false), ("waiting", .needsYou, false), ("statue", .asleep, true),
    ]
    for (name, state, quiet) in looks {
      let v = try view(mini: true, scale: scale)
      let p = Pose(name: name, state: state, rest: .idle)
      v.apply(CompanionLook(output: output(p, quiet: quiet), stillOnly: true, animationsAllowed: false, mini: true))
      #expect(!v.isShowingFallback, "\(name): the app icon fallback is showing")
      let r = try render(v, scale: scale)
      try save(r.image, as: "mini-\(name)-\(scale)x")
      let total = 44 * 44 * scale * scale
      #expect(r.opaque > total / 10, "mini \(name) \(scale)x: \(r.opaque) of \(total) opaque")
      if name == "statue" {
        #expect(r.emberPixels == 0, "the statue's glow cell is blank")
      } else {
        #expect(r.emberPixels > 2 * scale * scale, "mini \(name) \(scale)x: glow \(r.emberPixels)")
        let got = v.emberLayerForTest.contentsRect
        let col = ["pleased": 0, "worried": 1, "waiting": 2][name]!
        #expect(abs(got.origin.x - 0.25 * Double(col)) < 1e-9 && abs(got.width - 0.25) < 1e-9, "mini \(name): glow shows \(got)")
      }
    }
  }

  @Test func theIdleGlowIsOffForTheBlinkFramesOnTheSameClockAsTheEyesForArtWithoutTheLoops() throws {
    _ = NSApplication.shared
    let tmp = try Self.artWithoutLoops()
    defer { try? FileManager.default.removeItem(at: tmp) }
    let atlas = try LoadedAtlas.load(directory: tmp, scale: 2, mini: false).get()
    let v = CompanionSpriteView(frame: NSRect(origin: .zero, size: CompanionPlacement.size(mini: false)))
    v.setAtlas(atlas, mini: false)
    v.apply(CompanionLook(output: output(Self.standardPoses[0]), stillOnly: false, animationsAllowed: true, mini: false))
    #expect(!v.isLoopingRest, "no loops in this art: the old still idle with planned blinks")
    let frames = try #require(v.spriteLayerForTest.animation(forKey: "frames") as? CAKeyframeAnimation)
    let blink = try #require(v.emberLayerForTest.animation(forKey: "blink") as? CAKeyframeAnimation, "the glow has no blink animation")
    #expect(blink.keyTimes == frames.keyTimes && blink.duration == frames.duration && blink.repeatCount == .infinity)
    let cols = try #require(frames.values).map { ($0 as! NSValue).rectValue.origin.x }
    let hidden = try #require(blink.values).map { ($0 as! NSNumber).boolValue }
    #expect(cols.count == hidden.count && hidden.contains(true) && hidden.contains(false), "eyes close on some frames, not all")
    // Column 0 is open (x = 0 of 8); any other column is half or closed.
    for (x, h) in zip(cols, hidden) { #expect(h == (x > 0.0001), "x \(x): glow hidden \(h)") }
  }

  /// Idle and Needs you on the real art play their loop: one repeating frame animation over real cells of the loops sheet, the glow
  /// in the body, no ember layer, no bob, no timer.
  @Test(arguments: [(0, "idle-loop"), (3, "needs-loop")])
  func theRestsPlayTheirBaseLoopAsOneFrameAnimationWithNothingElse(pose: Int, clipName: String) throws {
    let v = try view(mini: false, scale: 2)
    v.apply(CompanionLook(output: output(Self.standardPoses[pose]), stillOnly: false, animationsAllowed: true, mini: false))
    #expect(v.isLoopingRest && !v.isShowingFallback)
    let clip = try #require(v.atlas?.manifest.clip(clipName))
    let frames = try #require(v.spriteLayerForTest.animation(forKey: "frames") as? CAKeyframeAnimation, "no frame animation")
    #expect(frames.calculationMode == .discrete && frames.repeatCount == .infinity)
    #expect(abs(frames.duration - Double(clip.totalMs) / 1000) < 1e-9 && frames.keyTimes?.count == clip.frames.count + 1)
    let want = clip.frames.map { v.atlas!.manifest.contentsRect(sheet: .talosLoops, col: $0.col, row: clip.row) }
    #expect(try #require(frames.values).map { ($0 as! NSValue).rectValue } == want, "the cells of \(clipName), in its own row")
    #expect(v.attachedAnimationCount == 1, "one animation on the sprite and nothing on the glow: \(v.spriteLayerForTest.animationKeys() ?? [])")
    #expect(v.spriteLayerForTest.animation(forKey: "breath") == nil && v.emberIsHidden && v.emberLayerForTest.animationKeys() == nil)
    #expect(v.clipTimerCount == 0, "no timer per frame, and none for a loop")
    for k in v.spriteLayerForTest.animationKeys() ?? [] { #expect(!(v.spriteLayerForTest.animation(forKey: k) is CABasicAnimation), "\(k) is smooth") }
    // Reduce Motion and Low Power: the one still pose, nothing attached, the glow back
    v.apply(CompanionLook(output: output(Self.standardPoses[pose]), stillOnly: true, animationsAllowed: true, mini: false))
    #expect(v.attachedAnimationCount == 0 && !v.isLoopingRest && !v.emberIsHidden)
    // occluded or screens asleep: everything off the layers, and back on when he can be seen
    v.apply(CompanionLook(output: output(Self.standardPoses[pose]), stillOnly: false, animationsAllowed: true, mini: false))
    #expect(v.attachedAnimationCount == 1)
    v.removeAllMotion()
    #expect(v.attachedAnimationCount == 0 && !v.isLoopingRest)
    v.apply(CompanionLook(output: output(Self.standardPoses[pose]), stillOnly: false, animationsAllowed: true, mini: false))
    #expect(v.isLoopingRest && v.attachedAnimationCount == 1, "playing again once he is visible")
  }

  /// The loop is body pose, not a moving picture: the cells really differ (many pixels change between cells), and the feet stay
  /// where they are (the lowest opaque row is the same in every cell).
  @Test(arguments: [(0, "idle-loop"), (3, "needs-loop")])
  func theLoopCellsDrawDifferentBodiesOnPlantedFeet(pose: Int, clipName: String) throws {
    let v = try view(mini: false, scale: 2)
    v.apply(CompanionLook(output: output(Self.standardPoses[pose]), stillOnly: false, animationsAllowed: true, mini: false))
    let clip = try #require(v.atlas?.manifest.clip(clipName))
    v.removeAllMotion()  // hold each cell by hand
    var images: [[UInt8]] = []
    var soles: [Int] = []
    for f in clip.frames {
      v.spriteLayerForTest.contentsRect = v.atlas!.manifest.contentsRect(sheet: .talosLoops, col: f.col, row: clip.row)
      let r = try render(v, scale: 2)
      images.append(pixelBytes(r.image))
      soles.append(lowestOpaqueRow(r.image))
    }
    #expect(Set(soles).count <= 2 && (soles.max()! - soles.min()!) <= 1, "feet planted: lowest rows \(soles)")
    var maxChanged = 0
    for k in 1..<images.count {
      var n = 0
      for i in stride(from: 3, to: images[0].count, by: 4) where abs(Int(images[0][i]) - Int(images[k][i])) > 100 { n += 1 }
      maxChanged = max(maxChanged, n)
    }
    #expect(maxChanged > 300, "\(clipName): the biggest change from cell 0 is only \(maxChanged) pixels: that is a sliding picture, not a body moving")
  }

  func pixelBytes(_ img: CGImage) -> [UInt8] {
    let w = img.width, h = img.height
    var px = [UInt8](repeating: 0, count: w * h * 4)
    let ctx = CGContext(data: &px, width: w, height: h, bitsPerComponent: 8, bytesPerRow: w * 4, space: CGColorSpace(name: CGColorSpace.sRGB)!, bitmapInfo: CGImageAlphaInfo.premultipliedLast.rawValue)!
    ctx.draw(img, in: CGRect(x: 0, y: 0, width: w, height: h))
    return px
  }

  func lowestOpaqueRow(_ img: CGImage) -> Int {
    let px = pixelBytes(img)
    var low = 0
    for y in 0..<img.height where (0..<img.width).contains(where: { px[(y * img.width + $0) * 4 + 3] > 200 }) { low = y }
    return low
  }

  @Test func aStillIdleHasNoBlinkAnimationAndKeepsItsGlow() throws {
    let v = try view(mini: false, scale: 2)
    v.apply(CompanionLook(output: output(Self.standardPoses[0]), stillOnly: true, animationsAllowed: false, mini: false))
    #expect(v.emberLayerForTest.animation(forKey: "blink") == nil && !v.emberIsHidden)
  }

  @Test func theFixtureArtThatNamesNoEmberCellStillGlowsAtRest() throws {
    _ = NSApplication.shared
    let dir = URL(fileURLWithPath: #filePath).deletingLastPathComponent().appendingPathComponent("../Fixtures/companion", isDirectory: true).standardized
    let atlas = try LoadedAtlas.load(directory: dir, scale: 2, mini: false).get()
    let v = CompanionSpriteView(frame: NSRect(origin: .zero, size: CompanionPlacement.size(mini: false)))
    v.setAtlas(atlas, mini: false)
    v.apply(CompanionLook(output: output(Self.standardPoses[0]), stillOnly: true, animationsAllowed: false, mini: false))
    #expect(!v.emberIsHidden, "one-pose ember art serves the rest pose")
  }

  @Test func aSheetThatVanishesAfterEnableFallsBackAndTheOwnerIsToldWhichFile() throws {
    _ = NSApplication.shared
    let tmp = URL(fileURLWithPath: NSTemporaryDirectory() + "companion-vanish-\(UUID().uuidString)", isDirectory: true)
    try FileManager.default.copyItem(at: Self.art, to: tmp)
    defer { try? FileManager.default.removeItem(at: tmp) }
    let atlas = try LoadedAtlas.load(directory: tmp, scale: 2, mini: false).get()
    let v = CompanionSpriteView(frame: NSRect(origin: .zero, size: CompanionPlacement.size(mini: false)))
    var told: [LoadedAtlas.LoadError] = []
    v.onArtFailed = { told.append($0) }
    v.setAtlas(atlas, mini: false)
    try FileManager.default.removeItem(at: tmp.appendingPathComponent("talos-ext-2x.png"))
    v.apply(CompanionLook(output: output(Self.standardPoses[5]), stillOnly: true, animationsAllowed: false, mini: false))
    #expect(v.isShowingFallback)
    #expect(told == [.missing(file: "talos-ext-2x.png")], "\(told)")
  }
}
