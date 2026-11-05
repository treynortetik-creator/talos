import AppKit
import ApplicationServices
import Foundation
import OSLog
import TalosDesktopCore

/// The Talos desktop companion (DESKTOP-COMPANION-SPEC): a small character on the Mac desktop. Off by default. This class owns
/// the windows, the timers and the listeners, and nothing else: every decision is `CompanionModel`'s. It talks to the Talos page
/// through nothing at all; a send goes through the existing `QuickCompose` path, which signs in the page.
@MainActor
final class CompanionController: NSObject, ObservableObject {
  static let shared = CompanionController(defaults: .standard)

  enum Key {
    static let enabled = "companion.enabled"
    static let size = "companion.size"
    static let moments = "companion.moments"
    static let snoozeUntil = "companion.snoozeUntil"
    static let display = "companion.display"
    static let posPrefix = "companion.pos."
    /// C-LIVE: also post the page's reply banners while he is on (spec 4.3). Off by default.
    static let replyBanners = "companion.replyBanners"
  }

  /// Everything the controller needs from the rest of the app, so tests can stand in for it.
  @MainActor struct Host {
    var openTalos: () -> Void = {}
    var openSettings: () -> Void = {}
    var showCompose: (_ anchor: NSRect?) -> Void = { _ in }
    var composeIsVisible: () -> Bool = { false }
    var screens: () -> [CompanionScreen] = { CompanionController.liveScreens() }
    /// Opens Talos at an in-app path (`/t/<id>`, or `/` for Home): `web.show()` then `navigate`.
    var openPath: (_ path: String) -> Void = { _ in }
    var showTerminal: () -> Void = {}
    /// The page's newest agent reply in a thread, as plain text; the outcome comes once.
    var requestReply: (_ thread: String, _ done: @escaping @MainActor (LastReplyTracker.Outcome) -> Void) -> Void = { _, done in done(.unavailable) }
    var cancelReply: () -> Void = {}
  }

  // Settings reads these.
  nonisolated static let log = Logger(subsystem: "app.talos.desktop", category: "companion")
  @Published private(set) var artProblem: String?
  @Published private(set) var micLine: String?
  @Published private(set) var snoozedUntil: Date?
  /// Bumps when the status list's rows change, so the menu bar submenu redraws. Not per frame.
  @Published private(set) var trayRevision = 0
  private var lastTray: CompanionTray?

  private let defaults: UserDefaults
  var host = Host()
  var inputsProvider: () -> CompanionInputs = { CompanionInputs() }
  /// Tests: adjust what the machine reports (Reduce Motion, Low Power) without touching System Settings.
  var envAdjust: ((inout CompanionEnv) -> Void)?
  /// Tests: the test runner is not a regular app, so its windows report as occluded; this stands in for the occlusion state.
  var visibilityOverride: Bool?
  /// Tests: where the pointer is.
  var pointerProvider: () -> CGPoint = { NSEvent.mouseLocation }
  /// Tests: pins the clock.
  var nowProvider: () -> (mono: TimeInterval, wall: Date) = { (ProcessInfo.processInfo.systemUptime, Date()) }

  /// Tests: the model's dice (fidget gaps, the day's three Rounds slots). Left alone, a test that pins the clock still meets a
  /// different day's slots on every run, and a Rounds walk that starts in the middle of it takes the ember away.
  var modelRandom: (ClosedRange<Double>) -> Double = { Double.random(in: $0) }
  private lazy var model = CompanionModel(random: modelRandom)
  private let system = CompanionSystem()
  private var atlas: LoadedAtlas?
  /// The Settings line for a failed reload at the other display's scale, and the scale it failed at (not retried each recompute).
  private var reloadStatus = ArtReloadStatus()
  private var started = false
  private var builtMini = false
  private var observer: NSObjectProtocol?

  private var spritePanel: CompanionPanel?
  private var bubblePanel: CompanionPanel?
  private var controlsPanel: CompanionPanel?
  private var spriteView: CompanionSpriteView?
  private var trayPanel: CompanionPanel?
  private var trayView: CompanionTrayView?
  private var cardPanel: CompanionPanel?
  private var cardView: CompanionReplyCardView?
  private var outsideMonitors: [Any] = []
  private var cardTimer: Timer?
  private var cardToken = 0
  /// The thread the open card shows, for its Open in Talos button.
  private var cardThread: String?
  /// The bubble on screen, so a click knows what it is a click on.
  private var currentBubble: CompanionBubble?
  private var bubbleView: CompanionBubbleView?
  private var controlsView: CompanionControlsView?
  private var occlusionObserver: NSObjectProtocol?
  private var backingObserver: NSObjectProtocol?
  /// Alive only while a snooze is pending: a snooze removes the panels and the system watcher, but a Mac that slept through the
  /// snooze's end must still end it at the wake (timers don't count sleep).
  private var snoozeWakeObservers: [(NotificationCenter, NSObjectProtocol)] = []
  private var atlasDirectory: URL?
  /// What the model has already reported or planned, kept across a rebuild of the model.
  private var carry = CompanionModel.Carry()
  private var startingRounds = false

  private var deadlineTimer: Timer?
  private var bubbleTimer: Timer?
  private var hoverShowTimer: Timer?
  private var hoverHideTimer: Timer?
  private var walkTimer: Timer?
  private var clickTimer: Timer?
  private var snoozeTimer: Timer?

  private var output: CompanionOutput?
  private var lastBubbleSeq = 0
  private var bubbleVisible = false
  private var hovering = false
  private var dragging = false
  private var clickGate = ClickGate()
  private var currentScreenUUID: String?
  private var lastFrames: [String: CGRect] = [:]
  private var walk: Walk?
  /// Where a walk cut short left him wanting to go: that walk's home, set only when `restOrigin` kept him off it because the
  /// pointer rested on him or on home. It is the one case he goes home on his own; any other move of his saved spot (a Dock
  /// change, a Space) leaves him where he is. A drag, a display change, a new walk or a rebuild ends it.
  private var homeAfterCutWalk: CGPoint?
  /// His right-click menu is open: he does not move under it.
  private var contextMenuOpen = false
  private var roundsSeq = 1_000_000
  /// A bubble that was up when a drag began comes back at the drop.
  private var heldBubble: CompanionBubble?

  private struct Walk {
    var xs: [CGFloat]
    var index = 0
    var home: CGPoint
    var right: Bool
    var zone: CGRect
    var stateAtStart: CompanionState
    /// Which way the figure faces now; the clip is swapped when the path turns.
    var facingRight: Bool
    var anim: CompanionAnimation?
  }

  init(defaults: UserDefaults) {
    self.defaults = defaults
    super.init()
  }

  // MARK: observable state for tests and Settings

  var isEnabled: Bool {
    get { defaults.bool(forKey: Key.enabled) }
    set { defaults.set(newValue, forKey: Key.enabled) }
  }
  var isMini: Bool { defaults.string(forKey: Key.size) == "mini" }
  var momentsOn: Bool { defaults.object(forKey: Key.moments) == nil ? true : defaults.bool(forKey: Key.moments) }
  var isOnScreen: Bool { spritePanel?.isVisible == true }
  var panels: [NSPanel] { [spritePanel, bubblePanel, controlsPanel, trayPanel, cardPanel].compactMap { $0 } }
  var trayPanelForTest: NSPanel? { trayPanel }
  var trayViewForTest: CompanionTrayView? { trayView }
  var cardPanelForTest: NSPanel? { cardPanel }
  var cardViewForTest: CompanionReplyCardView? { cardView }
  var trayIsShowing: Bool { trayPanel?.isVisible == true }
  var cardIsShowing: Bool { cardPanel?.isVisible == true }
  var outsideMonitorCount: Int { outsideMonitors.count }
  var currentBubbleForTest: CompanionBubble? { currentBubble }
  var replyBannersOn: Bool { defaults.bool(forKey: Key.replyBanners) }
  var spritePanelForTest: NSPanel? { spritePanel }
  var spriteViewForTest: CompanionSpriteView? { spriteView }
  var bubblePanelForTest: NSPanel? { bubblePanel }
  var controlsPanelForTest: NSPanel? { controlsPanel }
  var bubbleViewForTest: CompanionBubbleView? { bubbleView }
  var controlsViewForTest: CompanionControlsView? { controlsView }
  var lastOutput: CompanionOutput? { output }
  var atlasIsLoaded: Bool { atlas != nil }
  var systemForTest: CompanionSystem { system }
  var isWalking: Bool { walk != nil }
  var bubbleIsShowing: Bool { bubblePanel?.isVisible == true }
  /// The walk's one timer (the get-up delay or the step timer) is alive.
  var walkTimerIsLive: Bool { walkTimer?.isValid == true }
  var controlsAreShowing: Bool { controlsPanel?.isVisible == true }

  /// Live timers of this controller and its system watcher. Zero when he is off.
  var activeTimerCount: Int {
    [deadlineTimer, bubbleTimer, hoverShowTimer, hoverHideTimer, walkTimer, clickTimer, cardTimer].compactMap { $0 }.filter(\.isValid).count
      + system.timerCount + (spriteView?.clipTimerCount ?? 0)
  }
  /// Observers and CoreAudio listeners alive.
  var activeListenerCount: Int {
    system.listenerCount + (occlusionObserver == nil ? 0 : 1) + (backingObserver == nil ? 0 : 1) + snoozeWakeObservers.count
      + outsideMonitors.count
  }
  var snoozeWakeObserverCount: Int { snoozeWakeObservers.count }
  var atlasScale: Int? { atlas?.scale }

  // MARK: start

  /// Called once from the menu bar label's `.task`, never from `TalosApp.init` (`NSApp` is nil there).
  func start(inputs: @escaping () -> CompanionInputs, host: Host) {
    guard !started else { return }
    started = true
    inputsProvider = inputs
    self.host = host
    system.onChange = { [weak self] in
      self?.updateProblemLines()
      self?.pump { $0.update(self?.inputsProvider() ?? CompanionInputs(), env: self?.currentEnv() ?? CompanionEnv(), mono: $1, wall: $2) } }
    system.onWake = { [weak self] in self?.wake() }
    system.onScreensChanged = { [weak self] in self?.screensChanged() }
    observer = NotificationCenter.default.addObserver(forName: UserDefaults.didChangeNotification, object: defaults, queue: .main) {
      [weak self] _ in
      MainActor.assumeIsolated { self?.reconcile(hello: true) }
    }
    QuickCompose.shared.anchorProvider = { [weak self] in self?.anchorForCompose() }
    QuickCompose.shared.onShown = { [weak self] in self?.noteActivity() }
    reconcile(hello: false)
  }

  /// Stops everything for good (the app is quitting, or a test is done).
  func shutdown() {
    if let o = observer { NotificationCenter.default.removeObserver(o) }
    observer = nil
    teardown()
    snoozeTimer?.invalidate()
    snoozeTimer = nil
    armSnoozeWake(false)
    started = false
    QuickCompose.shared.anchorProvider = nil
    QuickCompose.shared.onShown = nil
  }

  // MARK: on, off, snooze

  /// Brings the screen in line with the settings: on and not snoozed means panels; anything else means none.
  func reconcile(hello: Bool) {
    guard started else { return }
    let now = nowProvider().wall
    var stored: Date?
    if let t = defaults.object(forKey: Key.snoozeUntil) as? Double { stored = Date(timeIntervalSince1970: t) }
    let snooze = CompanionPlacement.snoozeEnd(stored: stored, now: now)
    if let s = stored, snooze != s {  // past, or more than an hour ahead (a clock jump): cut it
      if let snooze { defaults.set(snooze.timeIntervalSince1970, forKey: Key.snoozeUntil) } else { defaults.removeObject(forKey: Key.snoozeUntil) }
    }
    if snoozedUntil != snooze { snoozedUntil = snooze }
    snoozeTimer?.invalidate()
    snoozeTimer = nil
    armSnoozeWake(snooze != nil && isEnabled)
    if let snooze, isEnabled {
      let t = Timer(timeInterval: max(0.05, snooze.timeIntervalSince(now)), repeats: false) { [weak self] _ in
        MainActor.assumeIsolated { self?.reconcile(hello: false) }
      }
      RunLoop.main.add(t, forMode: .common)
      snoozeTimer = t
    }
    let want = isEnabled && snooze == nil
    if want {
      if spritePanel == nil {
        build(hello: hello)
      } else if builtMini != isMini {
        teardown()
        build(hello: false)
      } else {
        pump { $0.update(self.inputsProvider(), env: self.currentEnv(), mono: $1, wall: $2) }
      }
    } else if spritePanel != nil {
      teardown()
    }
  }

  private func armSnoozeWake(_ on: Bool) {
    if !on {
      for (c, o) in snoozeWakeObservers { c.removeObserver(o) }
      snoozeWakeObservers.removeAll()
      return
    }
    guard snoozeWakeObservers.isEmpty else { return }
    let ws = NSWorkspace.shared.notificationCenter
    for (center, name) in [(ws, NSWorkspace.didWakeNotification), (NotificationCenter.default, NSNotification.Name.NSSystemClockDidChange)] {
      let token = center.addObserver(forName: name, object: nil, queue: .main) { [weak self] _ in
        MainActor.assumeIsolated { self?.reconcile(hello: false) }
      }
      snoozeWakeObservers.append((center, token))
    }
  }

  func hide() { isEnabled = false }

  func snooze(hours: Double = 1) {
    defaults.set(nowProvider().wall.addingTimeInterval(hours * 3600).timeIntervalSince1970, forKey: Key.snoozeUntil)
    reconcile(hello: false)
  }

  func endSnooze() {
    defaults.removeObject(forKey: Key.snoozeUntil)
    reconcile(hello: false)
  }

  func setSize(mini: Bool) { defaults.set(mini ? "mini" : "standard", forKey: Key.size) }

  // MARK: build and teardown

  private func build(hello: Bool) {
    builtMini = isMini
    let size = CompanionPlacement.size(mini: builtMini)
    loadAtlas(scale: placementScale())

    let sprite = CompanionPanel(size: size, sharing: .readOnly)  // the character shows in screenshots and shares; the other four stay .none
    let sv = CompanionSpriteView(frame: NSRect(origin: .zero, size: size))
    sprite.contentView = sv
    sv.setAtlas(atlas, mini: builtMini)
    sv.onHoverChanged = { [weak self] in self?.spriteHover($0) }
    sv.onClick = { [weak self] in self?.spriteClicked($0) }
    sv.onArtFailed = { [weak self] in self?.spriteArtFailed($0) }
    sv.onDragBegan = { [weak self] in self?.dragBegan(right: $0) }
    sv.onDragMoved = { [weak self] in self?.dragMoved(to: $0, right: $1) }
    sv.onDragEnded = { [weak self] in self?.dragEnded() }
    sv.menuProvider = { [weak self] in self?.makeMenu() ?? NSMenu() }
    spritePanel = sprite
    spriteView = sv

    let bubble = CompanionPanel(size: CGSize(width: 120, height: CompanionPlacement.bubbleHeight))
    let bv = CompanionBubbleView(frame: NSRect(origin: .zero, size: bubble.frame.size))
    bubble.contentView = bv
    bv.onClick = { [weak self] in self?.bubbleClicked() }
    bv.onHoverChanged = { [weak self] in self?.bubbleHover($0) }
    bubblePanel = bubble
    bubbleView = bv

    let controls = CompanionPanel(size: CompanionPlacement.controlsSize)
    let cv = CompanionControlsView(frame: NSRect(origin: .zero, size: CompanionPlacement.controlsSize))
    controls.contentView = cv
    cv.onCompose = { [weak self] in
      guard let self else { return }
      self.hideControls()
      self.host.showCompose(self.spritePanel?.frame)
    }
    cv.onStatus = { [weak self] in self?.toggleTray() }
    cv.onOpen = { [weak self] in
      self?.hideControls()
      self?.host.openTalos()
    }
    cv.onHoverChanged = { [weak self] in self?.controlsHover($0) }
    controlsPanel = controls
    controlsView = cv

    place(sprite)
    sprite.orderFrontRegardless()
    occlusionObserver = NotificationCenter.default.addObserver(
      forName: NSWindow.didChangeOcclusionStateNotification, object: sprite, queue: .main
    ) { [weak self] _ in MainActor.assumeIsolated { self?.reapply() } }
    backingObserver = NotificationCenter.default.addObserver(
      forName: NSWindow.didChangeBackingPropertiesNotification, object: sprite, queue: .main
    ) { [weak self] _ in MainActor.assumeIsolated { self?.reloadAtlasIfNeeded() } }

    system.start()
    model = CompanionModel(random: modelRandom, carry: carry)
    lastBubbleSeq = 0
    let n = nowProvider()
    var o = model.update(inputsProvider(), env: currentEnv(), mono: n.mono, wall: n.wall)
    if hello { o = model.turnedOn(mono: n.mono, wall: n.wall) }
    render(o)
    updateProblemLines()
  }

  /// The backing scale of the display he is about to be drawn on (never `NSScreen.main`, which is the key window's screen).
  private func placementScale() -> Int {
    let screens = host.screens()
    let size = CompanionPlacement.size(mini: builtMini)
    let s = CompanionPlacement.resolve(spots: spots(screens), preferred: defaults.string(forKey: Key.display), screens: screens, size: size)?.screen
      ?? screens.first { $0.isPrimary }
    return (s?.backingScale ?? 2) >= 1.5 ? 2 : 1
  }

  private func currentScale() -> Int {
    guard let p = spritePanel else { return placementScale() }
    let screens = host.screens()
    let s = screenContaining(CGPoint(x: p.frame.midX, y: p.frame.midY), screens)
    return (s?.backingScale ?? 2) >= 1.5 ? 2 : 1
  }

  /// Dragged or moved to a display with the other scale: the matching atlas comes in at the next pose (spec 6).
  private func reloadAtlasIfNeeded() {
    guard let sv = spriteView, let old = atlas, !dragging, let dir = atlasDirectory else { return }
    let want = currentScale()
    guard want != old.scale else {
      clearReloadProblem()  // back on the display the loaded art is for: the line about the other scale is stale
      return
    }
    if !reloadStatus.shouldTry(want: want) { return }  // already said; the disk is not asked again on every recompute
    let fresh: LoadedAtlas
    switch LoadedAtlas.load(directory: dir, scale: want, mini: builtMini) {
    case .success(let a): fresh = a
    case .failure(let e):  // keep the old one on screen, but say so
      let line = "Character art for the \(want)x display can't be loaded: \(e)"
      reloadStatus.failed(scale: want, line: line)
      artProblem = line
      Self.log.error("companion art: \(line, privacy: .public)")
      return
    }
    clearReloadProblem()
    atlas = fresh
    if artProblem == nil { artProblem = Self.rejectedLine(fresh) }
    sv.setAtlas(fresh, mini: builtMini)
    old.release()
    reapply()
  }

  private func clearReloadProblem() {
    if let r = reloadStatus.cleared(), artProblem == r { artProblem = nil }
  }

  /// The view met a sheet it can't draw from (loaded fine at enable, gone since): say which file and why.
  private func spriteArtFailed(_ e: LoadedAtlas.LoadError) {
    guard artProblem == nil else { return }
    let line = "Character art can't be drawn: \(e)"
    artProblem = line
    Self.log.error("companion art: \(line, privacy: .public)")
  }

  private func loadAtlas(scale: Int) {
    atlas = nil
    artProblem = nil
    reloadStatus = ArtReloadStatus()
    let dir = CompanionAtlas.locate(
      bundleResources: Bundle.main.resourceURL, environment: ProcessInfo.processInfo.environment,
      exists: { FileManager.default.fileExists(atPath: $0.path) })
    guard let dir else {
      let tried = Bundle.main.resourceURL?.appendingPathComponent("companion").path ?? "the app bundle"
      artProblem = "Character art is missing: no companion.json in \(tried)"
      Self.log.error("companion art: \(self.artProblem ?? "", privacy: .public)")
      return
    }
    atlasDirectory = dir
    switch LoadedAtlas.load(directory: dir, scale: scale, mini: isMini) {
    case .success(let a):
      atlas = a
      artProblem = Self.rejectedLine(a)
    case .failure(let e):
      artProblem = "Character art can't be loaded: \(e)"
      Self.log.error("companion art: \(self.artProblem ?? "", privacy: .public) (folder \(dir.lastPathComponent, privacy: .public), scale \(scale)x)")
    }
  }

  /// Clips the manifest carries but the loader refused. Each one falls back to something else on screen (a rejected nap shows
  /// the statue), so Settings says which.
  static func rejectedLine(_ a: LoadedAtlas) -> String? {
    let r = a.manifest.rejected
    return r.isEmpty ? nil : "Character art has clips that can't be used: \(r.sorted().joined(separator: ", "))"
  }

  private func updateProblemLines() {
    if system.micUnavailable {
      micLine = "Meeting detection is unavailable: he can't tell when a mic is on, so bubbles are not held back"
    } else if system.micStuck {
      micLine = "Bubbles are held: a mic has been in use for 3 hours"
    } else {
      micLine = nil
    }
  }

  /// Everything off: panels closed, animations removed, timers invalidated, listeners and monitors removed, atlases released.
  /// An open compose window stays, with its text (it is not ours).
  func teardown() {
    if spritePanel != nil { carry = model.carry }
    hideTray()
    hideCard()
    for p in [trayPanel, cardPanel] {
      p?.orderOut(nil)
      p?.contentView = nil
      p?.close()
    }
    trayPanel = nil
    trayView = nil
    cardPanel = nil
    cardView = nil
    for t in [deadlineTimer, bubbleTimer, hoverShowTimer, hoverHideTimer, walkTimer, clickTimer] { t?.invalidate() }
    deadlineTimer = nil
    bubbleTimer = nil
    hoverShowTimer = nil
    hoverHideTimer = nil
    walkTimer = nil
    clickTimer = nil
    walk = nil
    clickGate.cancel()
    system.stop()
    if let o = occlusionObserver { NotificationCenter.default.removeObserver(o) }
    occlusionObserver = nil
    if let o = backingObserver { NotificationCenter.default.removeObserver(o) }
    backingObserver = nil
    spriteView?.release()
    atlas?.release()
    atlas = nil
    for p in [spritePanel, bubblePanel, controlsPanel] {
      p?.orderOut(nil)
      p?.contentView = nil
      p?.close()
    }
    spritePanel = nil
    bubblePanel = nil
    controlsPanel = nil
    spriteView = nil
    bubbleView = nil
    controlsView = nil
    output = nil
    bubbleVisible = false
    currentBubble = nil
    hovering = false
    dragging = false
    homeAfterCutWalk = nil
    contextMenuOpen = false
    artProblem = nil
    micLine = nil
  }

  // MARK: the reducer loop

  private func currentEnv() -> CompanionEnv {
    var e = CompanionEnv()
    e.micRunning = system.micHeld
    e.reduceMotion = system.reduceMotion
    e.lowPower = system.lowPower
    e.mini = builtMini
    e.moments = momentsOn
    e.secondsSinceInput = system.secondsSinceInput
    e.bubbleOpen = bubbleVisible || cardIsShowing
    // No antic under the tray, the compose box, the controls, the right-click menu or a pointer resting on him: any of them means the owner is there.
    e.anticHold = trayIsShowing || host.composeIsVisible() || controlsPanel?.isVisible == true || hovering || contextMenuOpen
    // Only the antics the art on screen has; no art, no antics.
    e.antics = atlas?.manifest.antics(among: CompanionModel.idleAntics.keys) ?? [:]
    e.needsClips = atlas?.manifest.antics(among: CompanionModel.needsAntics.keys) ?? [:]
    envAdjust?(&e)
    return e
  }

  private func pump(_ f: (inout CompanionModel, TimeInterval, Date) -> CompanionOutput) {
    guard spritePanel != nil else { return }
    let n = nowProvider()
    render(f(&model, n.mono, n.wall))
  }

  /// StatusCoordinator calls this after each recompute.
  func inputsChanged() {
    guard spritePanel != nil else { return }
    pump { $0.update(self.inputsProvider(), env: self.currentEnv(), mono: $1, wall: $2) }
  }

  func noteActivity() {
    guard spritePanel != nil else { return }
    pump { $0.activity(mono: $1, wall: $2) }
  }

  private func wake() {
    guard started else { return }
    // The model first: its sleep is measured against the wall time of its last evaluation, and reconcile pumps an update that
    // moves that to now. Reconciling first made an 8-hour lid close read as no time at all and he never napped.
    pump { $0.woke(mono: $1, wall: $2) }
    reconcile(hello: false)  // a snooze may have ended while asleep
  }

  private func render(_ o: CompanionOutput) {
    output = o
    guard let sv = spriteView else { return }
    let env = currentEnv()
    let allowed = animationsAllowed
    // A walk is a beat: any clamp (Reduce Motion, Low Power, a mic, quiet, a hidden panel) or a new state stops it, and he is
    // back at his saved spot, as Hover and a drag do.
    if let w = walk, !startingRounds,
      o.state != w.stateAtStart || env.stillOnly || env.micRunning || o.quiet || !allowed
    { stopWalk() }
    var look = o
    if let a = walk?.anim { look.animation = a }  // the model knows nothing of the walk: keep asserting its clip
    sv.apply(CompanionLook(output: look, stillOnly: env.stillOnly, animationsAllowed: allowed, mini: builtMini))
    controlsView?.wordLabel.stringValue = o.word
    if bubbleVisible, env.micRunning || o.quiet { hideBubble() }  // a bubble already up when a clamp starts goes too
    // The reply card holds message text: a mic starting (a call), the quiet window, or the page going away closes it.
    let feedLive = inputsProvider().feed != nil
    if cardIsShowing, env.micRunning || o.quiet || !feedLive { hideCard() }
    if trayIsShowing { refreshTray() }
    let tray = trayContent()
    controlsView?.statusCount = tray.rows.count + tray.more
    if tray != lastTray {  // the menu bar submenu redraws on a change of rows, not on every frame
      lastTray = tray
      trayRevision &+= 1
    }
    if let b = o.bubble, b.seq != lastBubbleSeq {
      lastBubbleSeq = b.seq
      showBubble(b.bubble)
    }
    if o.dragging, bubbleVisible { hideBubble() }
    if let kind = CompanionWalkKind.requested(roundsDue: o.roundsDue, wanderDue: o.wanderDue, walking: walk != nil) { startRounds(kind) }
    returnHomeIfOff(micRunning: env.micRunning)
    scheduleDeadline(o.nextDeadline)
  }

  /// A walk cut while the pointer rested on him or on his home spot leaves him off home (`restOrigin`). Once nothing has him and
  /// the pointer is over neither place, he finishes the trip to where that walk began. Only then: `homeAfterCutWalk` is nil
  /// otherwise, so a moved saved spot (Dock, Space) never moves him.
  private func returnHomeIfOff(micRunning: Bool) {
    guard let p = spritePanel, let target = homeAfterCutWalk else { return }
    let panelOpen =
      bubbleVisible || trayIsShowing || cardIsShowing || controlsPanel?.isVisible == true || host.composeIsVisible() || contextMenuOpen
    guard CompanionPlacement.shouldReturnHome(
      home: target, current: p.frame.origin, size: p.frame.size, pointer: pointerProvider(),
      walking: walk != nil, dragging: dragging, onCall: micRunning, panelOpen: panelOpen)
    else { return }
    homeAfterCutWalk = nil
    p.setFrameOrigin(CompanionPlacement.snap(target, scale: p.backingScaleFactor))
  }

  private func scheduleDeadline(_ at: TimeInterval?) {
    deadlineTimer?.invalidate()
    deadlineTimer = nil
    guard let at else { return }
    let delay = max(0.05, at - nowProvider().mono)
    let t = Timer(timeInterval: delay, repeats: false) { [weak self] _ in
      MainActor.assumeIsolated {
        guard let self else { return }
        self.deadlineTimer = nil
        self.pump { $0.update(self.inputsProvider(), env: self.currentEnv(), mono: $1, wall: $2) }
      }
    }
    RunLoop.main.add(t, forMode: .common)
    deadlineTimer = t
  }

  /// Animations run only while the screens are awake, the session is active and the panel is not occluded.
  private var animationsAllowed: Bool {
    !system.animationsPaused && (visibilityOverride ?? spritePanel?.occlusionState.contains(.visible) ?? true)
  }

  private func reapply() {
    guard let o = output, let sv = spriteView else { return }
    let env = currentEnv()
    let allowed = animationsAllowed
    if !allowed { sv.removeAllMotion() }
    sv.apply(CompanionLook(output: o, stillOnly: env.stillOnly, animationsAllowed: allowed, mini: builtMini))
  }

  // MARK: screens and position

  static func liveScreens() -> [CompanionScreen] {
    NSScreen.screens.enumerated().compactMap { i, s in
      guard let uuid = displayUUID(s) else { return nil }
      return CompanionScreen(uuid: uuid, frame: s.frame, visibleFrame: s.visibleFrame, isPrimary: i == 0, backingScale: Double(s.backingScaleFactor))
    }
  }

  /// Keyed by the ColorSync display UUID, never by an `NSScreen` index.
  static func displayUUID(_ s: NSScreen) -> String? {
    guard let num = s.deviceDescription[NSDeviceDescriptionKey("NSScreenNumber")] as? NSNumber else { return nil }
    guard let u = CGDisplayCreateUUIDFromDisplayID(num.uint32Value)?.takeRetainedValue() else { return nil }
    return CFUUIDCreateString(nil, u) as String
  }

  private func spots(_ screens: [CompanionScreen]) -> [String: CompanionSpot] {
    var out: [String: CompanionSpot] = [:]
    for s in screens {
      if let a = defaults.array(forKey: Key.posPrefix + s.uuid) as? [Double], a.count == 2 {
        out[s.uuid] = CompanionSpot(fx: a[0], fy: a[1])
      }
    }
    return out
  }

  private func place(_ panel: NSPanel) {
    let screens = host.screens()
    let size = CompanionPlacement.size(mini: builtMini)
    guard let r = CompanionPlacement.resolve(
      spots: spots(screens), preferred: defaults.string(forKey: Key.display), screens: screens, size: size)
    else { return }
    currentScreenUUID = r.screen.uuid
    homeAfterCutWalk = nil
    lastFrames = Dictionary(uniqueKeysWithValues: screens.map { ($0.uuid, $0.frame) })
    panel.setFrame(NSRect(origin: CompanionPlacement.snap(r.origin, scale: CGFloat(r.screen.backingScale)), size: size), display: false)
  }

  /// Resolution, Dock or display changes. The clamp moves him; it never rewrites the saved spot. Fractions are re-applied only
  /// when a display's `frame` changes, never when only `visibleFrame` does, or a full-screen Space could shift him.
  private func screensChanged() {
    guard let p = spritePanel, !dragging else { return }
    let screens = host.screens()
    let size = CompanionPlacement.size(mini: builtMini)
    let cur = screens.first { $0.uuid == currentScreenUUID }
    let frameChanged = cur.map { lastFrames[$0.uuid] != $0.frame } ?? true
    lastFrames = Dictionary(uniqueKeysWithValues: screens.map { ($0.uuid, $0.frame) })
    // The display he was last put on has come back: he goes back to its saved spot, even if the display he stands on is fine.
    let preferred = defaults.string(forKey: Key.display)
    let preferredReturned = preferred != nil && preferred != currentScreenUUID && screens.contains { $0.uuid == preferred }
    stopWalk()  // before anything moves him: its jump home is to the OLD display
    homeAfterCutWalk = nil
    if let cur, !frameChanged, !preferredReturned {
      p.setFrameOrigin(CompanionPlacement.clamp(p.frame.origin, size: size, in: cur.visibleFrame))
    } else {
      place(p)
    }
    reloadAtlasIfNeeded()
  }

  private func screenContaining(_ point: CGPoint, _ screens: [CompanionScreen]) -> CompanionScreen? {
    screens.first { $0.frame.contains(point) } ?? screens.first { $0.isPrimary } ?? screens.first
  }

  private func saveSpot() {
    guard let p = spritePanel else { return }
    let screens = host.screens()
    let size = CompanionPlacement.size(mini: builtMini)
    guard let s = screenContaining(CGPoint(x: p.frame.midX, y: p.frame.midY), screens) else { return }
    let spot = CompanionPlacement.spot(of: p.frame.origin, size: size, in: s.visibleFrame)
    currentScreenUUID = s.uuid  // before the writes: the defaults observer re-renders at once and must see the new display
    defaults.set([spot.fx, spot.fy], forKey: Key.posPrefix + s.uuid)
    defaults.set(s.uuid, forKey: Key.display)
  }

  /// The spot he is saved at, for Rounds to go back to.
  private func savedOrigin() -> CGPoint? {
    guard let p = spritePanel else { return nil }
    let screens = host.screens()
    let size = CompanionPlacement.size(mini: builtMini)
    return CompanionPlacement.resolve(spots: spots(screens), preferred: currentScreenUUID, screens: screens, size: size)?.origin ?? p.frame.origin
  }

  // MARK: compose anchor

  /// Compose anchors to him only if he is visible on the pointer's screen; otherwise it centers as it does today.
  func anchorForCompose() -> NSRect? {
    stopWalk()  // the hotkey and both menu items ask here first: take the frame after he has stopped, not mid-step
    guard let p = spritePanel, p.isVisible else { return nil }
    let screens = host.screens()
    guard let under = screens.first(where: { NSMouseInRect(self.pointerProvider(), $0.frame, false) }),
      let mine = screenContaining(CGPoint(x: p.frame.midX, y: p.frame.midY), screens), under.uuid == mine.uuid
    else { return nil }
    return p.frame
  }

  // MARK: hover and controls

  private func spriteHover(_ inside: Bool) {
    hovering = inside
    if inside {
      noteActivity()
      hoverHideTimer?.invalidate()
      hoverHideTimer = nil
      bubbleTimer?.invalidate()  // hover pauses the 6 s timer
      bubbleTimer = nil
      if walk != nil { stopWalk() }
      guard !dragging, controlsPanel?.isVisible != true else { return }
      hoverShowTimer?.invalidate()
      let t = Timer(timeInterval: 0.15, repeats: false) { [weak self] _ in
        MainActor.assumeIsolated {
          self?.hoverShowTimer = nil
          if self?.hovering == true { self?.showControls() }
        }
      }
      RunLoop.main.add(t, forMode: .common)
      hoverShowTimer = t
    } else {
      hoverShowTimer?.invalidate()
      hoverShowTimer = nil
      scheduleHideControls()
      if bubbleVisible { startBubbleTimer() }
    }
  }

  private func controlsHover(_ inside: Bool) {
    if inside {
      hoverHideTimer?.invalidate()
      hoverHideTimer = nil
    } else {
      scheduleHideControls()
    }
  }

  private func bubbleHover(_ inside: Bool) {
    if inside {
      bubbleTimer?.invalidate()
      bubbleTimer = nil
    } else if bubbleVisible {
      startBubbleTimer()
    }
  }

  private func scheduleHideControls() {
    guard controlsPanel?.isVisible == true else { return }
    hoverHideTimer?.invalidate()
    let t = Timer(timeInterval: 0.4, repeats: false) { [weak self] _ in
      MainActor.assumeIsolated {
        guard let self else { return }
        self.hoverHideTimer = nil
        // Exit events are lost when a window moves or closes under the pointer: check where the pointer is now.
        let m = self.pointerProvider()
        let zone = (self.spritePanel?.frame ?? .zero).insetBy(dx: -2, dy: -2)
        let czone = (self.controlsPanel?.frame ?? .zero).insetBy(dx: -2, dy: -2)
        if zone.contains(m) || czone.contains(m) { return }
        self.hideControls()
      }
    }
    RunLoop.main.add(t, forMode: .common)
    hoverHideTimer = t
  }

  private func showControls() {
    // The tray and the card sit directly under him: Controls over them would cover the top of the list.
    guard let sp = spritePanel, let cp = controlsPanel, !dragging, !trayIsShowing, !cardIsShowing else { return }
    let screens = host.screens()
    guard let s = screenContaining(CGPoint(x: sp.frame.midX, y: sp.frame.midY), screens) else { return }
    cp.setFrame(CompanionPlacement.controlsFrame(sprite: sp.frame, in: s.visibleFrame), display: false)
    cp.orderFrontRegardless()
    if bubbleVisible { positionBubble() }  // it moves past the controls
  }

  private func hideControls() {
    hoverShowTimer?.invalidate()
    hoverShowTimer = nil
    hoverHideTimer?.invalidate()
    hoverHideTimer = nil
    controlsPanel?.orderOut(nil)
    if bubbleVisible { positionBubble() }
  }

  // MARK: bubble

  private func showBubble(_ bubble: CompanionBubble) {
    guard let bp = bubblePanel, let bv = bubbleView, !dragging else { return }
    stopWalk()
    currentBubble = bubble
    bv.text = bubble.text
    bubbleVisible = true
    positionBubble()
    bp.orderFrontRegardless()
    startBubbleTimer()
  }

  private func positionBubble() {
    guard let sp = spritePanel, let bp = bubblePanel, let bv = bubbleView else { return }
    let screens = host.screens()
    guard let s = screenContaining(CGPoint(x: sp.frame.midX, y: sp.frame.midY), screens) else { return }
    let controls = controlsPanel?.isVisible == true ? controlsPanel?.frame : nil
    let f = CompanionPlacement.bubbleFrame(
      sprite: sp.frame, textWidth: CompanionBubbleView.width(of: bv.text), controls: controls, in: s.visibleFrame)
    bp.setFrame(f.frame, display: false)
    bv.frame = NSRect(origin: .zero, size: f.frame.size)
    bv.needsLayout = true
  }

  private func startBubbleTimer() {
    bubbleTimer?.invalidate()
    guard !hovering else { return }
    let t = Timer(timeInterval: 6, repeats: false) { [weak self] _ in
      MainActor.assumeIsolated { self?.hideBubble() }
    }
    RunLoop.main.add(t, forMode: .common)
    bubbleTimer = t
  }

  private func hideBubble() {
    bubbleTimer?.invalidate()
    bubbleTimer = nil
    bubbleVisible = false
    currentBubble = nil
    bubblePanel?.orderOut(nil)
  }

  // MARK: status list and reply card (C-LIVE)

  /// The rows the tray and the menu bar submenu show, from the same inputs the reducer reads.
  func trayContent() -> CompanionTray { CompanionTray.build(inputs: inputsProvider()) }

  /// Pressing the status button again closes it.
  private func toggleTray() {
    if trayIsShowing { hideTray() } else { showTray() }
  }

  func showTray() {
    guard let sp = spritePanel, !dragging else { return }
    hideCard()
    hideControls()
    stopWalk()
    if trayPanel == nil {
      let p = CompanionPanel(size: CGSize(width: CompanionPlacement.traySize.width, height: 60))
      let v = CompanionTrayView(frame: NSRect(origin: .zero, size: p.frame.size))
      p.contentView = v
      v.onRow = { [weak self] row in self?.trayRowClicked(row) }
      v.onMore = { [weak self] in
        self?.hideTray()
        self?.host.openPath("/")
      }
      v.onOpenTalos = { [weak self] in
        self?.hideTray()
        self?.host.openTalos()
      }
      trayPanel = p
      trayView = v
    }
    refreshTray()
    guard let p = trayPanel else { return }
    place(card: p, below: sp)
    p.orderFrontRegardless()
    installOutsideMonitors()
    noteActivity()
  }

  private func refreshTray() {
    guard let v = trayView, let p = trayPanel, let sp = spritePanel else { return }
    let content = trayContent()
    v.still = content.showsStill ? helloStill() : nil
    let h = v.apply(content)
    p.setContentSize(CGSize(width: CompanionPlacement.traySize.width, height: h))
    v.frame = NSRect(origin: .zero, size: p.frame.size)
    place(card: p, below: sp)
  }

  /// Hello's still (the waving clip's resting frame) cut from the loaded atlas, for the empty list.
  private func helloStill() -> CGImage? {
    guard let a = atlas, let clip = a.manifest.clip("waving"), let img = a.image(clip.sheet) else { return nil }
    let cw = a.manifest.cell.width * CGFloat(a.scale)
    let ch = a.manifest.cell.height * CGFloat(a.scale)
    return img.cropping(to: CGRect(x: CGFloat(clip.still) * cw, y: CGFloat(clip.row) * ch, width: cw, height: ch))
  }

  private func place(card p: NSPanel, below sp: NSPanel) {
    let screens = host.screens()
    guard let s = screenContaining(CGPoint(x: sp.frame.midX, y: sp.frame.midY), screens) else { return }
    p.setFrame(CompanionPlacement.cardFrame(sprite: sp.frame, size: p.frame.size, in: s.visibleFrame), display: false)
  }

  func hideTray() {
    trayPanel?.orderOut(nil)
    removeOutsideMonitorsIfIdle()
  }

  private func trayRowClicked(_ row: CompanionTray.Row) {
    hideTray()
    switch row.action {
    case .terminal: host.showTerminal()
    case .thread(let id): host.openPath("/t/\(id)")
    }
  }

  /// A click on his bubble: a reply opens the reply card, a bubble that names a thread opens that thread, the rest open Talos.
  private func bubbleClicked() {
    let b = currentBubble
    hideBubble()
    switch b {
    case .newReply(_, let id): openReplyCard(thread: id)
    case .needsYouIn(_, let id): host.openPath("/t/\(id)")
    default: host.openTalos()
    }
  }

  /// The last reply of a thread: asked of the page now, on this click, never stored. The card closes after 20 s, on a click
  /// elsewhere, when a mic starts, at sign-out, and when he goes off.
  func openReplyCard(thread: String) {
    guard let sp = spritePanel, !dragging else { return }
    // A bubble that was up when the feed went away (a reload, a wake) still opens the thread: the click is never dropped.
    guard cardAllowed else { return host.openPath("/t/\(thread)") }
    hideTray()
    hideControls()
    stopWalk()
    cardThread = thread
    cardToken += 1
    let token = cardToken
    if cardPanel == nil {
      let p = CompanionPanel(size: CGSize(width: CompanionPlacement.replyCardWidth, height: 80))
      let v = CompanionReplyCardView(frame: NSRect(origin: .zero, size: p.frame.size))
      p.contentView = v
      v.onOpenTalos = { [weak self] in
        guard let self else { return }
        let thread = self.cardThread
        self.hideCard()
        if let thread { self.host.openPath("/t/\(thread)") } else { self.host.openTalos() }
      }
      cardPanel = p
      cardView = v
    }
    guard let p = cardPanel else { return }
    sizeCard(text: "Fetching the reply…", isReply: false)
    place(card: p, below: sp)
    p.orderFrontRegardless()
    installOutsideMonitors()
    startCardTimer()
    host.requestReply(thread) { [weak self] outcome in
      guard let self, self.cardToken == token, self.cardIsShowing else { return }  // closed, or a newer click replaced it
      switch outcome {
      case .text(let t, let truncated):
        let clean = CompanionPhrase.replyText(t)
        self.sizeCard(text: truncated ? clean + "…" : clean, isReply: true)
      case .empty: self.sizeCard(text: "Nothing to show yet.", isReply: false)
      case .timedOut, .unavailable: self.sizeCard(text: "Couldn't load the reply.", isReply: false)
      case .superseded: return
      }
      if let sp = self.spritePanel { self.place(card: p, below: sp) }
    }
  }

  /// The card is for a real reply only while he can show one: not in a call, not in the quiet window, with a live feed.
  private var cardAllowed: Bool {
    let i = inputsProvider()
    return i.quiet == false && !currentEnv().micRunning && i.feed != nil
  }

  private func sizeCard(text: String, isReply: Bool) {
    guard let p = cardPanel, let v = cardView else { return }
    let h = v.show(text, isReply: isReply)
    p.setContentSize(CGSize(width: CompanionPlacement.replyCardWidth, height: h))
    v.frame = NSRect(origin: .zero, size: p.frame.size)
    v.needsLayout = true
  }

  private func startCardTimer() {
    cardTimer?.invalidate()
    let t = Timer(timeInterval: 20, repeats: false) { [weak self] _ in
      MainActor.assumeIsolated { self?.hideCard() }
    }
    RunLoop.main.add(t, forMode: .common)
    cardTimer = t
  }

  func hideCard() {
    cardTimer?.invalidate()
    cardTimer = nil
    cardToken += 1  // a late answer for the card that just closed is dropped
    if cardPanel?.isVisible == true { host.cancelReply() }
    cardView?.clear()
    cardThread = nil
    cardPanel?.orderOut(nil)
    removeOutsideMonitorsIfIdle()
  }

  /// Both exist only while a tray or card is open: a global monitor for clicks in other apps, a local one for our own panels
  /// (a global monitor never sees this app's events).
  private func installOutsideMonitors() {
    guard outsideMonitors.isEmpty else { return }
    let mask: NSEvent.EventTypeMask = [.leftMouseDown, .rightMouseDown, .otherMouseDown]
    if let g = NSEvent.addGlobalMonitorForEvents(matching: mask, handler: { [weak self] _ in
      MainActor.assumeIsolated { self?.closeCards() }
    }) {
      outsideMonitors.append(g)
    }
    if let l = NSEvent.addLocalMonitorForEvents(matching: mask, handler: { [weak self] e in
      let target = e.window.map(ObjectIdentifier.init)
      MainActor.assumeIsolated {
        guard let self else { return }
        let inside = target.map { $0 == self.trayPanel.map(ObjectIdentifier.init) || $0 == self.cardPanel.map(ObjectIdentifier.init) } ?? false
        if !inside { self.closeCards() }
      }
      return e
    }) {
      outsideMonitors.append(l)
    }
  }

  private func removeOutsideMonitorsIfIdle() {
    guard !trayIsShowing, !cardIsShowing else { return }
    for m in outsideMonitors { NSEvent.removeMonitor(m) }
    outsideMonitors.removeAll()
  }

  /// A click outside closes whichever of the two is open.
  func closeCards() {
    hideTray()
    hideCard()
  }

  /// The menu bar submenu's actions: the same ones a tray row has.
  func openRow(_ row: CompanionTray.Row) { trayRowClicked(row) }
  func openHome() { host.openPath("/") }
  func openTalosFromMenu() { host.openTalos() }

  /// Spec 4.3: his bubble replaces the page's reply banner only while he can actually show it.
  func dropsReplyBanner(body: String) -> Bool {
    let i = inputsProvider()
    return CompanionBannerPolicy.drops(
      body: body,
      pet: .init(
        onScreen: spritePanel != nil && !system.animationsPaused, quiet: i.quiet, micRunning: currentEnv().micRunning, feedLive: i.feed != nil,
        state: output?.state ?? .idle, replyBanners: replyBannersOn))
  }

  // MARK: clicks

  private func spriteClicked(_ count: Int) {
    stopWalk()
    pump { $0.click(mono: $1, wall: $2) }
    // Open Talos only after the double-click interval with no third click, so five fast clicks (Grumble) never open the app.
    let interval = NSEvent.doubleClickInterval
    clickTimer?.invalidate()
    clickTimer = nil
    if clickGate.click(count: count, mono: nowProvider().mono, interval: interval) != nil {
      let t = Timer(timeInterval: interval, repeats: false) { [weak self] _ in
        MainActor.assumeIsolated {
          guard let self else { return }
          self.clickTimer = nil
          if self.clickGate.due(mono: .greatestFiniteMagnitude) { self.host.openTalos() }  // the timer is the wait
        }
      }
      RunLoop.main.add(t, forMode: .common)
      clickTimer = t
    }
  }

  // MARK: drag

  private func dragBegan(right: Bool) {
    stopWalk()
    homeAfterCutWalk = nil
    dragging = true
    hideControls()
    if bubbleVisible { heldBubble = currentBubble }
    hideBubble()
    hideTray()
    hideCard()
    clickGate.cancel()
    clickTimer?.invalidate()
    clickTimer = nil
    pump { $0.dragBegan(directionRight: right, mono: $1, wall: $2) }
  }

  private func dragMoved(to origin: CGPoint, right: Bool) {
    guard let p = spritePanel else { return }
    let screens = host.screens()
    let size = CompanionPlacement.size(mini: builtMini)
    let mouse = pointerProvider()
    // Clamped on the display under the pointer; if that display went away mid-drag, on the primary.
    guard let s = screenContaining(mouse, screens) else { return }
    p.setFrameOrigin(CompanionPlacement.clamp(origin, size: size, in: s.visibleFrame))
    pump { $0.dragMoved(directionRight: right, mono: $1, wall: $2) }
  }

  private func dragEnded() {
    dragging = false
    if let p = spritePanel {
      let scale = p.backingScaleFactor
      p.setFrameOrigin(CompanionPlacement.snap(p.frame.origin, scale: scale))
    }
    homeAfterCutWalk = nil  // the drop is his new saved spot
    saveSpot()
    reloadAtlasIfNeeded()
    pump { $0.dragEnded(mono: $1, wall: $2) }
    // The held bubble goes through the same gate as every other: known quiet state, not quiet, no mic.
    let open = inputsProvider().quiet == false && !currentEnv().micRunning
    if let b = heldBubble, open, !bubbleVisible, output?.state != .idle { showBubble(b) }
    heldBubble = nil
  }

  // MARK: rounds

  func startRoundsForTest() { startRounds(.rounds) }
  func stopWalkForTest() { stopWalk() }
  func hoverForTest(_ inside: Bool) { spriteHover(inside) }
  func clickForTest(_ n: Int) { spriteClicked(n) }
  func dragBeganForTest(right: Bool) { dragBegan(right: right) }
  func dragMovedForTest(to o: CGPoint, right: Bool) { dragMoved(to: o, right: right) }
  func dragEndedForTest() { dragEnded() }
  func screensChangedForTest() { screensChanged() }
  func wakeForTest() { wake() }

  /// Rounds and the short wander are the same walk: a wander goes out a shorter way, and the model keeps its own clock for it.
  private func startRounds(_ kind: CompanionWalkKind) {
    guard let p = spritePanel, walk == nil, !dragging else { return decline(kind) }
    // The window moving under a still pointer would eat his next click and fire no enter event: only start with nothing open
    // and the pointer well away from the whole path. A walk also waits until he can be seen: the next recompute would cut it.
    guard !host.composeIsVisible(), controlsPanel?.isVisible != true, !bubbleVisible, !trayIsShowing, !cardIsShowing,
      kind.mayStart(visible: animationsAllowed), let home = savedOrigin()
    else { return decline(kind) }
    let screens = host.screens()
    let size = CompanionPlacement.size(mini: builtMini)
    guard let s = screenContaining(CGPoint(x: p.frame.midX, y: p.frame.midY), screens) else { return decline(kind) }
    let (xs, right) = CompanionPlacement.roundsPath(
      start: home, size: size, in: s.visibleFrame, reach: kind.reach)
    guard !xs.isEmpty else { return decline(kind) }
    let zone = CompanionPlacement.roundsKeepClear(start: home, size: size, path: xs)
    guard !zone.contains(pointerProvider()) else { return decline(kind) }
    p.setFrameOrigin(home)
    homeAfterCutWalk = nil
    walk = Walk(xs: xs, home: home, right: right, zone: zone, stateAtStart: output?.state ?? .idle, facingRight: right, anim: nil)
    // Rounds can wake him from Asleep, and that changes the state the walk started from. Take the state after the pump, and
    // let the pump's own render leave the walk alone.
    let napping = output?.rest == .nap
    startingRounds = true
    pump { $0.walkStarted(kind, mono: $1, wall: $2) }
    startingRounds = false
    guard walk != nil, walkTimer == nil else { return }
    walk?.stateAtStart = output?.state ?? .idle
    // Lying in the nap, he gets up first (the `wake` clip the pump just started) and only then sets off: no flat-to-running pop.
    // The delay rides in `walkTimer`, so a hover, a drag or any stop kills it with the walk.
    let wakeClip = output?.animation?.clip ?? "wake"
    let getUp = napping && wakeClip.hasPrefix("wake") ? Double(atlas?.manifest.clip(wakeClip)?.totalMs ?? 0) / 1000 : 0
    if getUp > 0 {
      let t = Timer(timeInterval: getUp, repeats: false) { [weak self] _ in
        MainActor.assumeIsolated {
          guard let self, self.walk != nil else { return }
          self.walkTimer = nil
          self.beginWalk(right: right)
        }
      }
      RunLoop.main.add(t, forMode: .common)
      walkTimer = t
      return
    }
    beginWalk(right: right)
  }

  /// Seconds between two steps of a walk. A walk is at most 46 steps (out and back), so this is what keeps one under 8 s.
  static let walkTick: TimeInterval = 1.0 / 6.0

  private func beginWalk(right: Bool) {
    setWalkClip(right: right)
    let t = Timer(timeInterval: Self.walkTick, repeats: true) { [weak self] _ in
      MainActor.assumeIsolated { self?.walkStep() }
    }
    RunLoop.main.add(t, forMode: .common)
    walkTimer = t
  }

  /// The running clip that faces the way he is going; swapped when the path turns.
  private func setWalkClip(right: Bool) {
    roundsSeq += 1
    walk?.facingRight = right
    walk?.anim = CompanionAnimation(clip: right ? "running-right" : "running-left", untilCleared: true, seq: roundsSeq)
    guard var o = output, let sv = spriteView else { return }
    o.animation = walk?.anim
    let env = currentEnv()
    sv.apply(CompanionLook(output: o, stillOnly: env.stillOnly, animationsAllowed: animationsAllowed, mini: builtMini))
  }

  private func decline(_ kind: CompanionWalkKind) { pump { $0.walkDeclined(kind, mono: $1, wall: $2) } }

  private func walkStep() {
    guard var w = walk, let p = spritePanel else { return stopWalk() }
    // Each step checks the pointer; within 60 pt of him, he stops and goes home.
    let near = p.frame.insetBy(dx: -60, dy: -60)
    if near.contains(pointerProvider()) { return stopWalk() }
    guard w.index < w.xs.count else { return stopWalk() }
    let x = w.xs[w.index]
    let right = x > p.frame.origin.x ? true : (x < p.frame.origin.x ? false : w.facingRight)
    p.setFrameOrigin(CGPoint(x: x, y: w.home.y))
    w.index += 1
    walk = w
    if right != w.facingRight { setWalkClip(right: right) }  // the way back faces back
    if w.index >= w.xs.count { stopWalk() }
  }

  /// Hover, a drag, a click, a bubble, a priority rise, a clamp or a display change stops him and he jumps to his saved spot, unless
  /// the pointer is over where he stands or over that spot: then he stays where he stands until the pointer leaves both
  /// (`returnHomeIfOff`) or the next walk starts from his saved spot.
  private func stopWalk() {
    walkTimer?.invalidate()  // always: a timer must never outlive the walk it was made for
    walkTimer = nil
    guard let w = walk else { return }
    walk = nil
    homeAfterCutWalk = nil
    if let p = spritePanel {
      let rest = CompanionPlacement.restOrigin(home: w.home, current: p.frame.origin, size: p.frame.size, pointer: pointerProvider())
      p.setFrameOrigin(rest)
      if rest != w.home { homeAfterCutWalk = w.home }  // kept off home by the pointer: `returnHomeIfOff` finishes the trip
    }
    if let o = output, let sv = spriteView {
      sv.removeAllMotion()
      let env = currentEnv()
      var rest = o
      rest.animation = nil
      sv.apply(CompanionLook(output: rest, stillOnly: env.stillOnly, animationsAllowed: animationsAllowed, mini: builtMini))
    }
  }

  // MARK: menu

  private func makeMenu() -> NSMenu {
    let m = NSMenu()
    m.autoenablesItems = false
    m.delegate = self
    let hide = NSMenuItem(title: "Hide", action: #selector(menuHide), keyEquivalent: "")
    hide.target = self
    m.addItem(hide)
    let snooze = NSMenuItem(title: "Snooze for 1 hour", action: #selector(menuSnooze), keyEquivalent: "")
    snooze.target = self
    m.addItem(snooze)
    let size = NSMenuItem(title: "Size", action: nil, keyEquivalent: "")
    let sub = NSMenu()
    for (title, mini) in [("Standard", false), ("Mini", true)] {
      let i = NSMenuItem(title: title, action: #selector(menuSize(_:)), keyEquivalent: "")
      i.target = self
      i.tag = mini ? 1 : 0
      i.state = isMini == mini ? .on : .off
      sub.addItem(i)
    }
    size.submenu = sub
    m.addItem(size)
    m.addItem(.separator())
    let settings = NSMenuItem(title: "Settings…", action: #selector(menuSettings), keyEquivalent: "")
    settings.target = self
    m.addItem(settings)
    return m
  }

  /// Tests: the menu a right-click would show.
  func menuForTest() -> NSMenu { makeMenu() }

  @objc private func menuHide() { hide() }
  @objc private func menuSnooze() { snooze() }
  @objc private func menuSize(_ item: NSMenuItem) { setSize(mini: item.tag == 1) }
  @objc private func menuSettings() { host.openSettings() }
}

extension CompanionController: NSMenuDelegate {
  func menuWillOpen(_ menu: NSMenu) { contextMenuOpen = true }
  func menuDidClose(_ menu: NSMenu) { contextMenuOpen = false }
}
