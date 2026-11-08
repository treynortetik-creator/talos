import AppKit
import CoreGraphics
import ImageIO
import QuartzCore
import TalosDesktopCore

/// What the sprite is told. The controller decides; the view only draws.
struct CompanionLook {
  var output: CompanionOutput
  var stillOnly: Bool
  var animationsAllowed: Bool
  var mini: Bool
}

/// Ember opacity, as discrete steps. Smooth opacity loops made WindowServer run at full refresh (PROBE 15.1% of a core against
/// 0.87%), so the ember changes at most twice a second and never uses a smooth animation (spec 3.2).
enum EmberMode: Equatable {
  case resting, dim, breath, pulse, glow

  var values: [Float] {
    switch self {
    case .resting: return [0.7]
    case .dim: return [0.25]
    case .breath: return [0.55, 0.7, 0.85, 1.0, 0.85, 0.7]
    case .pulse: return [0.4, 0.6, 0.85, 1.0, 1.0, 0.85, 0.6, 0.4]
    case .glow: return [0.85, 1.0, 0.9, 1.0]
    }
  }

  /// Where the ember sits when nothing animates (spec 5): resting, except asleep where it stays dim.
  var stillValue: Float { self == .dim ? 0.25 : 0.7 }

  /// Base period in seconds; the controller adds the +-15% jitter.
  var period: Double {
    switch self {
    case .breath: return 3.6
    case .pulse: return 5
    case .glow: return 3
    case .resting, .dim: return 0
    }
  }
}

@MainActor
final class CompanionSpriteView: NSView {
  // Callbacks into the controller.
  var onHoverChanged: ((Bool) -> Void)?
  var onClick: ((Int) -> Void)?
  var onDragBegan: ((Bool) -> Void)?
  var onDragMoved: ((CGPoint, Bool) -> Void)?
  var onDragEnded: (() -> Void)?
  var menuProvider: (() -> NSMenu)?
  /// A sheet that loaded at enable and can't be read now. The view falls back to the app icon; the controller says why.
  var onArtFailed: ((LoadedAtlas.LoadError) -> Void)?

  private let spriteLayer = CALayer()
  private let emberLayer = CALayer()
  private let fallbackLayer = CALayer()
  /// The still dot of the quiet window (spec 2.3): something was collected while he slept.
  private let dotLayer = CALayer()
  private(set) var atlas: LoadedAtlas?
  private var mini = false
  private var playGeneration = 0
  private var lastSeq = 0
  private var lastAnticStop = 0
  private var currentRest: CompanionRest = .idle
  /// True once the rest was drawn with its idle loop and ember steps running; false after a still draw or a removal.
  private var restAnimated = false
  /// True while the rest is drawn as its base loop (Idle's breathing, Needs you's rock): one frame animation, glow baked into the
  /// body, no ember layer, no bob.
  private var restLooping = false
  /// How many times a rest was drawn from scratch (a test hook: the 2 s recompute must not redraw a rest that is already moving).
  private(set) var restDrawCount = 0
  var isLoopingRest: Bool { restLooping }
  private var playingUntilCleared = false
  private(set) var playingClip: String?
  private(set) var playingSeq = 0
  private(set) var emberMode: EmberMode = .resting
  /// Animations currently attached to the layers: zero when everything is removed.
  var attachedAnimationCount: Int {
    (spriteLayer.animationKeys()?.count ?? 0) + (emberLayer.animationKeys()?.count ?? 0)
  }
  var spriteContentsRect: CGRect { spriteLayer.contentsRect }
  var isShowingFallback: Bool { !fallbackLayer.isHidden }
  var emberOpacity: Float { emberLayer.opacity }
  var emberIsHidden: Bool { emberLayer.isHidden }
  var dotIsShowing: Bool { !dotLayer.isHidden }
  var dotLayerForTest: CALayer { dotLayer }
  var emberAnimationSignature: String? {
    guard let a = emberLayer.animation(forKey: "ember") as? CAKeyframeAnimation else { return nil }
    return "\(a.duration)|\(a.values?.count ?? 0)"
  }
  var spriteLayerForTest: CALayer { spriteLayer }
  var emberLayerForTest: CALayer { emberLayer }

  /// The period of the ember's steps now running, 0 when it does not step: the idle bob uses it so the two change on the same frames.
  private var emberPeriod: Double = 0
  private var clipTimer: Timer?
  var clipTimerCount: Int { clipTimer?.isValid == true ? 1 : 0 }
  private var tracking: NSTrackingArea?
  private var downAt: CGPoint?
  private var downOrigin: CGPoint?
  private var lastMouseX: CGFloat = 0
  private var lastRight = true
  private var dragging = false
  /// A drag keeps its facing until the pointer has really moved the other way this far (pt).
  static let facingDeadZone: CGFloat = 2
  /// A drag starts past 4 pt (spec 3.3).
  static let dragThreshold: CGFloat = 4

  override init(frame: NSRect) {
    super.init(frame: frame)
    wantsLayer = true
    layer?.backgroundColor = NSColor.clear.cgColor
    for l in [spriteLayer, emberLayer, fallbackLayer] {
      l.magnificationFilter = .nearest
      l.minificationFilter = .nearest
      l.contentsGravity = .resize
      l.isGeometryFlipped = false
      // No implicit animation, ever: a property change on a layer otherwise adds a smooth CABasicAnimation, which made
      // WindowServer run at full refresh (spec 3.2, PROBE 15.1% of a core).
      l.actions = [
        "opacity": NSNull(), "contentsRect": NSNull(), "contents": NSNull(), "hidden": NSNull(), "bounds": NSNull(),
        "position": NSNull(), "frame": NSNull(), "contentsScale": NSNull(),
      ]
      layer?.addSublayer(l)
    }
    fallbackLayer.contentsGravity = .resizeAspect
    fallbackLayer.isHidden = true
    emberLayer.isHidden = true
    dotLayer.actions = ["hidden": NSNull(), "position": NSNull(), "frame": NSNull(), "bounds": NSNull(), "contentsScale": NSNull()]
    dotLayer.backgroundColor = CompanionColors.cream.cgColor
    dotLayer.borderColor = CompanionColors.ground.cgColor
    dotLayer.borderWidth = 1
    dotLayer.isHidden = true
    layer?.addSublayer(dotLayer)
    setAccessibilityRole(.image)
    setAccessibilityElement(true)
  }
  required init?(coder: NSCoder) { fatalError("not used") }

  override var acceptsFirstResponder: Bool { false }
  override func acceptsFirstMouse(for event: NSEvent?) -> Bool { true }
  override var mouseDownCanMoveWindow: Bool { false }

  override func layout() {
    super.layout()
    for l in [spriteLayer, emberLayer, fallbackLayer] { l.frame = bounds }
    let s = window?.backingScaleFactor ?? 2
    for l in [spriteLayer, emberLayer, fallbackLayer] { l.contentsScale = s }
    dotLayer.contentsScale = s
    let d: CGFloat = 9
    dotLayer.frame = CGRect(x: bounds.maxX - d - 8, y: bounds.maxY - d - 8, width: d, height: d)
    dotLayer.cornerRadius = d / 2
  }

  override func viewDidChangeBackingProperties() {
    super.viewDidChangeBackingProperties()
    needsLayout = true  // contentsScale follows the display he is on
  }

  // MARK: atlas

  func setAtlas(_ a: LoadedAtlas?, mini: Bool) {
    atlas = a
    self.mini = mini
    spriteLayer.removeAllAnimations()
    emberLayer.removeAllAnimations()
    playingClip = nil
    playingUntilCleared = false
    restAnimated = false
    restLooping = false
    if a == nil {
      showFallback()
    } else {
      fallbackLayer.isHidden = true
      spriteLayer.isHidden = false
    }
  }

  private func showFallback() {
    spriteLayer.isHidden = true
    emberLayer.isHidden = true
    fallbackLayer.isHidden = false
    if let icon = NSApp?.applicationIconImage, let cg = icon.cgImage(forProposedRect: nil, context: nil, hints: nil) {
      fallbackLayer.contents = cg
    }
  }

  /// Takes everything off the layers: panel off, screens asleep, occluded, Reduce Motion.
  func removeAllMotion() {
    playGeneration += 1
    clipTimer?.invalidate()
    clipTimer = nil
    spriteLayer.removeAllAnimations()
    emberLayer.removeAllAnimations()
    playingClip = nil
    playingUntilCleared = false
    restAnimated = false
    restLooping = false
  }

  func release() {
    removeAllMotion()
    spriteLayer.contents = nil
    emberLayer.contents = nil
    fallbackLayer.contents = nil
    atlas = nil
  }

  // MARK: drawing

  func apply(_ look: CompanionLook) {
    setAccessibilityLabel(look.output.accessibilityLabel)
    toolTip = look.output.word
    dotLayer.isHidden = !look.output.dot
    guard let atlas else {
      showFallback()
      return
    }
    fallbackLayer.isHidden = true
    spriteLayer.isHidden = false
    if mini {
      applyMini(look, atlas)
      return
    }
    let o = look.output
    let still = look.stillOnly || !look.animationsAllowed
    if still {
      removeAllMotion()
      showRest(o.rest, atlas: atlas, animated: false, state: o.state)
      return
    }
    if o.anticStop != lastAnticStop {
      // An antic that was playing must stop now (he is not alone any more, or a clamp closed): cut it to the rest. Another clip is
      // left alone, and so is one that no longer plays.
      lastAnticStop = o.anticStop
      if let p = playingClip, CompanionModel.isAntic(p) {
        removeAllMotion()
        showRest(o.rest, atlas: atlas, animated: true, state: o.state)
      }
    }
    if let a = o.animation, a.seq != lastSeq {
      lastSeq = a.seq
      play(a, rest: o.rest, state: o.state, atlas: atlas)
    } else if playingClip == nil {
      // Nothing changes while the same rest is already drawn and moving: redrawing would restart the ember with a new period,
      // so a slow pulse would never get past its first steps (a 2 s recompute is enough to do it).
      let wantEmber = Self.ember(for: o.rest, state: o.state)
      let framesGone = spriteLayer.animation(forKey: "frames") == nil
      let idleLoopGone = restLooping ? framesGone : (o.rest == .idle && (framesGone || spriteLayer.animation(forKey: "breath") == nil))
      let emberGone = !restLooping && emberMode.period > 0 && emberLayer.animation(forKey: "ember") == nil
      if currentRest != o.rest || emberMode != wantEmber || !restAnimated || idleLoopGone || emberGone {
        showRest(o.rest, atlas: atlas, animated: true, state: o.state)
      }
    } else {
      // A clip keeps playing while the rest it will settle on is unchanged; a different rest (quiet, Asleep, a new state) cuts it.
      // A clip that loops until cleared (Carried, a Rounds walk) also needs the model to keep asserting it: when it stops
      // (a mic started mid-drag), the loop must not outlive it.
      let held = !playingUntilCleared || o.animation?.untilCleared == true
      if held, let p = pendingRest, p.0 == o.rest, p.1 == o.state { return }
      removeAllMotion()
      showRest(o.rest, atlas: atlas, animated: true, state: o.state)
    }
  }

  private var pendingRest: (CompanionRest, CompanionState)?

  private func applyMini(_ look: CompanionLook, _ atlas: LoadedAtlas) {
    guard let img = sheet(.mini, in: atlas) else { return showFallback() }
    playGeneration += 1
    clipTimer?.invalidate()
    clipTimer = nil
    spriteLayer.removeAllAnimations()
    playingClip = nil
    playingUntilCleared = false
    spriteLayer.contents = img
    let pose = CompanionAtlas.miniPose(look.output.state)
    spriteLayer.contentsRect = atlas.manifest.contentsRect(sheet: .mini, col: pose.rawValue, row: 0)
    emberLayer.contents = sheet(.miniEmber, in: atlas)
    emberLayer.contentsRect = atlas.manifest.miniEmberRect(pose: pose)
    emberLayer.isHidden = emberLayer.contents == nil
    // Working is the only state that steps the ember in Mini; without it Working and Idle look the same.
    let mode: EmberMode = pose == .statue ? .dim : (look.output.state == .working && !look.stillOnly && look.animationsAllowed ? .glow : .resting)
    let animated = !look.stillOnly && look.animationsAllowed
    // The same Mini look again (the 2 s recompute) leaves a running glow alone instead of restarting it.
    if emberMode == mode, restAnimated == animated, !emberLayer.isHidden, (mode.period == 0 || emberLayer.animationKeys() != nil || !animated) {
      return
    }
    restAnimated = animated
    setEmber(mode, animated: animated)
  }

  static func ember(for rest: CompanionRest, state: CompanionState) -> EmberMode {
    switch rest {
    case .idle: return .breath
    case .statue, .nap: return .dim
    case .holdStill: return .pulse
    case .holdLast: return state == .working ? .glow : .resting
    }
  }

  /// A sheet for drawing, reporting a failure to the owner (Settings, log) instead of swallowing it.
  private func sheet(_ s: CompanionAtlas.Sheet, in atlas: LoadedAtlas) -> CGImage? {
    switch atlas.load(s) {
    case .success(let i): return i
    case .failure(let e):
      onArtFailed?(e)
      return nil
    }
  }

  private func rectFor(_ clip: CompanionAtlas.Clip, col: Int, in atlas: LoadedAtlas) -> CGRect {
    atlas.manifest.contentsRect(sheet: clip.sheet, col: col, row: clip.row)
  }

  /// The still pose for a rest, with the ember beside it.
  private func showRest(_ rest: CompanionRest, atlas: LoadedAtlas, animated: Bool, state: CompanionState) {
    currentRest = rest
    playingClip = nil
    playingUntilCleared = false
    restAnimated = animated
    restDrawCount += 1
    spriteLayer.removeAnimation(forKey: "frames")
    spriteLayer.removeAnimation(forKey: "breath")
    emberLayer.removeAnimation(forKey: "blink")
    emberLayer.removeAnimation(forKey: "breath")
    restLooping = false
    // The base loop: Idle breathes and shifts his weight, Needs you rocks and glances, for as long as nothing else plays. Real frames
    // of the body (chest, shoulders, hips, arms, head, eyes), one frame animation on the sprite layer and nothing else: no timer, no
    // bob, and the glow is in the body, so the ember layer stays off.
    if animated, let loopName = CompanionAtlas.restLoopName(rest), let loop = atlas.manifest.clip(loopName), loop.frames.count >= 2,
      let loopImg = sheet(loop.sheet, in: atlas)
    {
      spriteLayer.contents = loopImg
      spriteLayer.contentsRect = rectFor(loop, col: loop.frames[0].col, in: atlas)
      spriteLayer.add(Self.frameAnimation(atlas: atlas.manifest, clip: loop, frames: loop.frames, repeatCount: .infinity, repeatDuration: nil), forKey: "frames")
      emberLayer.removeAllAnimations()
      emberLayer.isHidden = true
      emberMode = Self.ember(for: rest, state: state)
      emberPeriod = 0
      emberLayer.opacity = emberMode.stillValue
      restLooping = true
      return
    }
    let name = Self.restName(rest, atlas: atlas)
    guard let clip = atlas.manifest.clip(name), let img = sheet(clip.sheet, in: atlas) else { return showFallback() }
    spriteLayer.contents = img
    let col: Int
    if case .holdLast = rest { col = clip.frames.last?.col ?? clip.still } else { col = clip.still }
    spriteLayer.contentsRect = rectFor(clip, col: col, in: atlas)
    if case .idle = rest, animated, clip.frames.count >= 3 {
      let loop = CompanionAtlas.idleLoop(clip, random: { Double.random(in: $0) })
      spriteLayer.add(Self.frameAnimation(atlas: atlas.manifest, clip: clip, frames: loop, repeatCount: .infinity, repeatDuration: nil), forKey: "frames")
      setEmberImage(atlas, clip: clip, col: col)
      setEmber(Self.ember(for: rest, state: state), animated: animated)
      // The glow is cut for the open eyes: it is off for the blink frames, on the same clock as the eyes (one animation, no timer).
      if let e = clip.ember, !emberLayer.isHidden {
        emberLayer.add(Self.blinkAnimation(ember: e, frames: loop), forKey: "blink")
      }
      // The bob rides on the same steps as the ember, on both layers, so the glow stays on his eyes.
      let bob = Self.breathAnimation(period: emberPeriod > 0 ? emberPeriod : CompanionAtlas.breathPeriod)
      spriteLayer.add(bob, forKey: "breath")
      if !emberLayer.isHidden { emberLayer.add(bob, forKey: "breath") }
      return
    }
    setEmberImage(atlas, clip: clip, col: col)
    setEmber(Self.ember(for: rest, state: state), animated: animated)
  }

  private func play(_ a: CompanionAnimation, rest: CompanionRest, state: CompanionState, atlas: LoadedAtlas) {
    guard let clip = atlas.manifest.clip(a.clip), let img = sheet(clip.sheet, in: atlas) else {
      showRest(rest, atlas: atlas, animated: true, state: state)
      return
    }
    playGeneration += 1
    let gen = playGeneration
    playingClip = a.clip
    playingSeq = a.seq
    playingUntilCleared = a.untilCleared
    restLooping = false
    pendingRest = (rest, state)
    spriteLayer.removeAnimation(forKey: "breath")  // a clip is its own motion
    // The model value is the rest frame, so a removed animation lands on the right pose (spec 3.2).
    let restClip = Self.restClip(rest, atlas: atlas)
    spriteLayer.contents = img
    // Ember runs only while no clip is playing: one mover.
    // The ember sheet is one pose, and a clip turns, hops and waves: the glow would sit at the front-facing eye on a figure
    // looking sideways. It comes back with the rest pose.
    emberLayer.removeAllAnimations()
    emberLayer.isHidden = true
    let frames = a.frameLimit.map { Array(clip.frames.prefix($0)) } ?? clip.frames
    let anim = Self.frameAnimation(
      atlas: atlas.manifest, clip: clip, frames: frames, repeatCount: a.untilCleared ? .infinity : 1, repeatDuration: a.repeatFor)
    spriteLayer.add(anim, forKey: "frames")
    // The end of a clip is a one-shot timer, not the animation delegate: CoreAnimation can drop an animation on a layer it
    // isn't rendering (occluded, off screen) without ever calling back, and the ember must then still take over.
    clipTimer?.invalidate()
    clipTimer = nil
    if !a.untilCleared {
      let total = a.repeatFor ?? (Double(frames.reduce(0) { $0 + $1.ms }) / 1000)
      let t = Timer(timeInterval: total + 0.02, repeats: false) { [weak self] _ in
        MainActor.assumeIsolated {
          guard let self, gen == self.playGeneration else { return }
          self.clipTimer = nil
          self.finished(a.clip)
        }
      }
      RunLoop.main.add(t, forMode: .common)
      clipTimer = t
    }
    // After the add, so the animation's start state is its first value and the model value is the rest.
    if let rc = restClip {
      let col: Int
      if case .holdLast = rest { col = rc.frames.last?.col ?? rc.still } else { col = rc.still }
      if rc.sheet == clip.sheet {
        spriteLayer.contentsRect = rectFor(rc, col: col, in: atlas)
      } else {
        // Another sheet holds the rest pose (talking, landed): the model value must still be a cell of THIS sheet until the
        // end timer swaps it, or the gap shows the old rect cropped from the wrong picture.
        spriteLayer.contentsRect = rectFor(clip, col: clip.frames.last?.col ?? clip.still, in: atlas)
      }
    }
  }

  private static func restClip(_ rest: CompanionRest, atlas: LoadedAtlas) -> CompanionAtlas.Clip? {
    atlas.manifest.clip(restName(rest, atlas: atlas))
  }

  /// The clip whose still a rest shows. The nap falls back to the statue for art that has no antics sheet.
  static func restName(_ rest: CompanionRest, atlas: LoadedAtlas) -> String {
    switch rest {
    case .idle: return "idle"
    case .statue: return "statue"
    case .nap: return atlas.manifest.clip("nap") == nil ? "statue" : "nap"
    case .holdStill(let c), .holdLast(let c): return c
    }
  }

  private func finished(_ clip: String) {
    playingClip = nil
    guard let atlas else { return }
    let (rest, state) = pendingRest ?? (.idle, .idle)
    showRest(rest, atlas: atlas, animated: true, state: state)
  }

  /// A discrete animation on `contentsRect`. keyTimes has n+1 entries for n values: with n the last frame never shows (PROBE).
  static func frameAnimation(atlas: CompanionAtlas, clip: CompanionAtlas.Clip, frames: [CompanionAtlas.Frame], repeatCount: Float, repeatDuration: TimeInterval?)
    -> CAKeyframeAnimation
  {
    let total = Double(frames.reduce(0) { $0 + $1.ms })
    var times: [NSNumber] = [0]
    var acc = 0.0
    for f in frames {
      acc += Double(f.ms)
      times.append(NSNumber(value: acc / total))
    }
    let a = CAKeyframeAnimation(keyPath: "contentsRect")
    a.calculationMode = .discrete
    a.values = frames.map { NSValue(rect: atlas.contentsRect(sheet: clip.sheet, col: $0.col, row: clip.row)) }
    a.keyTimes = times
    a.duration = total / 1000
    if let d = repeatDuration { a.repeatDuration = d } else { a.repeatCount = repeatCount }
    a.isRemovedOnCompletion = true
    return a
  }

  /// The idle bob: stepped, never smooth (a smooth animation keeps WindowServer drawing at full refresh), a point or so up and back
  /// once a period. Stepping on the ember's own period puts its two changes on frames the ember already redraws.
  static func breathAnimation(period: Double) -> CAKeyframeAnimation {
    let lifts = CompanionAtlas.breathLifts
    let a = CAKeyframeAnimation(keyPath: "transform.translation.y")
    a.calculationMode = .discrete
    a.values = lifts.map { NSNumber(value: $0) }
    a.keyTimes = (0...lifts.count).map { NSNumber(value: Double($0) / Double(lifts.count)) }
    a.duration = period
    a.repeatCount = .infinity
    return a
  }

  /// Hidden on every frame of the idle loop whose column the glow was not cut for, shown on the others. Same keyTimes and
  /// duration as the frame animation, added in the same transaction, so the two stay together.
  static func blinkAnimation(ember: CompanionAtlas.Ember, frames: [CompanionAtlas.Frame]) -> CAKeyframeAnimation {
    let total = Double(frames.reduce(0) { $0 + $1.ms })
    var times: [NSNumber] = [0]
    var acc = 0.0
    for f in frames {
      acc += Double(f.ms)
      times.append(NSNumber(value: acc / total))
    }
    let a = CAKeyframeAnimation(keyPath: "hidden")
    a.calculationMode = .discrete
    a.values = frames.map { NSNumber(value: !ember.cols.contains($0.col)) }
    a.keyTimes = times
    a.duration = total / 1000
    a.repeatCount = .infinity
    a.isRemovedOnCompletion = true
    return a
  }

  /// The glow cell the manifest names for this clip, laid over the pose on screen. No cell for this pose, no glow: a glow cut
  /// for another frame would sit off the eyes.
  private func setEmberImage(_ atlas: LoadedAtlas, clip: CompanionAtlas.Clip, col: Int) {
    if let img = sheet(.ember, in: atlas), let r = atlas.manifest.emberRect(for: clip, col: col) {
      emberLayer.contents = img
      emberLayer.contentsRect = r
      emberLayer.isHidden = false
    } else {
      emberLayer.isHidden = true
    }
  }

  func setEmber(_ mode: EmberMode, animated: Bool) {
    emberMode = mode
    emberPeriod = 0
    emberLayer.removeAnimation(forKey: "ember")
    let v = mode.values
    // Unanimated (Reduce Motion, Low Power, occluded) it sits at its resting opacity, not at the first step of a pulse.
    emberLayer.opacity = animated ? (v.first ?? 0.7) : mode.stillValue
    guard animated, v.count > 1, mode.period > 0 else { return }
    let period = mode.period * Double.random(in: 0.85...1.15)
    emberPeriod = period
    // At most 2 changes a second: never more steps than two per second of period.
    let maxSteps = max(2, Int(period * 2))
    let steps = Array(v.prefix(maxSteps))
    var times: [NSNumber] = [0]
    for i in 1...steps.count { times.append(NSNumber(value: Double(i) / Double(steps.count))) }
    let a = CAKeyframeAnimation(keyPath: "opacity")
    a.calculationMode = .discrete
    a.values = steps
    a.keyTimes = times
    a.duration = period
    a.repeatCount = .infinity
    emberLayer.add(a, forKey: "ember")
  }

  // MARK: mouse

  override func updateTrackingAreas() {
    super.updateTrackingAreas()
    if let t = tracking { removeTrackingArea(t) }
    let t = NSTrackingArea(rect: .zero, options: [.activeAlways, .mouseEnteredAndExited, .inVisibleRect], owner: self, userInfo: nil)
    addTrackingArea(t)
    tracking = t
  }

  override func mouseEntered(with event: NSEvent) { onHoverChanged?(true) }
  override func mouseExited(with event: NSEvent) { onHoverChanged?(false) }

  override func mouseDown(with event: NSEvent) {
    if event.modifierFlags.contains(.control) {  // control-click is the right-click menu
      if let m = menuProvider?() { NSMenu.popUpContextMenu(m, with: event, for: self) }
      return
    }
    downAt = NSEvent.mouseLocation
    downOrigin = window?.frame.origin
    lastMouseX = NSEvent.mouseLocation.x
    lastRight = true
    dragging = false
  }

  override func mouseDragged(with event: NSEvent) {
    // From NSEvent.mouseLocation, never locationInWindow: the window moves under the event and jitters.
    guard let start = downAt, let origin = downOrigin else { return }
    let now = NSEvent.mouseLocation
    if !dragging {
      guard hypot(now.x - start.x, now.y - start.y) > Self.dragThreshold else { return }
      dragging = true
      lastRight = now.x >= start.x
      lastMouseX = now.x
      onDragBegan?(lastRight)
    }
    // Facing follows real movement: a sample with no x change (a vertical or very slow drag) keeps the last facing instead of
    // flipping and restarting the clip at frame 0.
    (lastRight, lastMouseX) = Self.facing(lastRight: lastRight, lastX: lastMouseX, nowX: now.x)
    let right = lastRight
    onDragMoved?(CGPoint(x: origin.x + now.x - start.x, y: origin.y + now.y - start.y), right)
  }

  /// Which way a drag faces after a pointer sample. Only a move past the dead zone turns him; the reference x moves with it.
  static func facing(lastRight: Bool, lastX: CGFloat, nowX: CGFloat) -> (right: Bool, lastX: CGFloat) {
    let dx = nowX - lastX
    guard abs(dx) > facingDeadZone else { return (lastRight, lastX) }
    return (dx > 0, nowX)
  }

  override func mouseUp(with event: NSEvent) {
    defer {
      downAt = nil
      dragging = false
    }
    if dragging { onDragEnded?() } else if downAt != nil { onClick?(event.clickCount) }
  }

  override func menu(for event: NSEvent) -> NSMenu? { menuProvider?() }
}
