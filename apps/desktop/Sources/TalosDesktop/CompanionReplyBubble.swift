import AppKit
import TalosDesktopCore

/// The reply bubble: what he says when a thread has a new reply. A header ("WORK · new reply"), the first line, and Open and
/// Later. Cream on black like the rest of him, in a never-key `CompanionPanel`. It holds message text: the panel asks macOS to keep
/// it out of captures, but that is a request and not relied on (a mirrored display shows it). All words come from
/// `ReplyBubbleContent`; this view draws what it is given.
final class CompanionReplyBubbleView: NSView {
  static let pad: CGFloat = 12
  static let buttonHeight: CGFloat = 34
  let headerField = NSTextField(labelWithString: "")
  let bodyField = NSTextField(wrappingLabelWithString: "")
  let openButton: CompanionLinkView
  let laterButton: CompanionLinkView
  var onOpen: (() -> Void)?
  var onLater: (() -> Void)?
  var onClick: (() -> Void)?
  var onHoverChanged: ((Bool) -> Void)?
  private var tracking: NSTrackingArea?

  override init(frame: NSRect) {
    openButton = CompanionLinkView(text: "Open", width: frame.width / 2, height: Self.buttonHeight)
    laterButton = CompanionLinkView(text: "Later", width: frame.width / 2, height: Self.buttonHeight)
    super.init(frame: frame)
    headerField.font = .systemFont(ofSize: 11, weight: .semibold)
    headerField.textColor = CompanionColors.cream.withAlphaComponent(0.78)
    headerField.lineBreakMode = .byTruncatingTail
    bodyField.font = .systemFont(ofSize: 12, weight: .medium)
    bodyField.textColor = CompanionColors.cream
    bodyField.isSelectable = false
    bodyField.maximumNumberOfLines = 2
    bodyField.lineBreakMode = .byWordWrapping
    bodyField.cell?.truncatesLastVisibleLine = true
    for f in [headerField, bodyField] {
      f.setAccessibilityElement(false)  // the bubble reads as one line to VoiceOver
      addSubview(f)
    }
    openButton.onClick = { [weak self] in self?.onOpen?() }
    laterButton.onClick = { [weak self] in self?.onLater?() }
    addSubview(openButton)
    addSubview(laterButton)
    setAccessibilityElement(true)
    setAccessibilityRole(.group)
  }
  required init?(coder: NSCoder) { fatalError("not used") }

  override var isFlipped: Bool { true }
  override func acceptsFirstMouse(for event: NSEvent?) -> Bool { true }
  override var mouseDownCanMoveWindow: Bool { false }

  /// Sets the words and returns the height the bubble needs.
  @discardableResult
  func show(_ c: ReplyBubbleContent) -> CGFloat {
    let w = CompanionPlacement.replyBubbleWidth
    let textW = w - 2 * Self.pad
    headerField.stringValue = c.header
    bodyField.stringValue = c.body
    setAccessibilityLabel(c.spoken)
    let lineH = ceil(bodyField.font.map { $0.ascender - $0.descender + $0.leading } ?? 15)
    let measured = ceil(bodyField.cell?.cellSize(forBounds: NSRect(x: 0, y: 0, width: textW, height: 100_000)).height ?? lineH)
    let bodyH = min(measured, 2 * lineH)
    headerField.frame = NSRect(x: Self.pad, y: 10, width: textW, height: 15)
    bodyField.frame = NSRect(x: Self.pad, y: 28, width: textW, height: bodyH)
    let y = bodyField.frame.maxY + 6
    openButton.frame = NSRect(x: 0, y: y, width: w / 2, height: Self.buttonHeight)
    laterButton.frame = NSRect(x: w / 2, y: y, width: w / 2, height: Self.buttonHeight)
    needsDisplay = true
    return openButton.frame.maxY + 8
  }

  /// The text must not outlive the bubble, in the view or in the accessibility tree.
  func clear() {
    headerField.stringValue = ""
    bodyField.stringValue = ""
    setAccessibilityLabel(nil)
  }

  override func draw(_ dirtyRect: NSRect) { CompanionTrayView.paintGround(bounds) }
  override func mouseUp(with event: NSEvent) {
    if bounds.contains(convert(event.locationInWindow, from: nil)) { onClick?() }
  }
  override func updateTrackingAreas() {
    super.updateTrackingAreas()
    if let t = tracking { removeTrackingArea(t) }
    let t = NSTrackingArea(rect: .zero, options: [.activeAlways, .mouseEnteredAndExited, .inVisibleRect], owner: self, userInfo: nil)
    addTrackingArea(t)
    tracking = t
  }
  override func mouseEntered(with event: NSEvent) { onHoverChanged?(true) }
  override func mouseExited(with event: NSEvent) { onHoverChanged?(false) }
}

/// Owns the reply bubble's panel, clock and pile of replies, and speaks for the page's held list through `ReplyLedger`. The
/// controller says when a reply arrives (his own Done, or the page's `held`) and when he cannot show it any more; the rest (asking
/// the page for the text, joining a second reply, the 30 s clock, Open and Later, telling the page what was shown) is here.
@MainActor
final class CompanionReplyBubble {
  /// What it needs from him, so tests can stand in for him.
  struct Hooks {
    /// The frame for a panel of this size, or nil when he is not on screen.
    var frame: (CGSize) -> CGRect?
    /// Not quiet, no mic, a live feed.
    var canShow: () -> Bool
    /// The page's one open question is free (the reply card is not using it).
    var askPage: () -> Bool
    var open: (String) -> Void
    var fetch: (String, @escaping @MainActor (LastReplyTracker.Outcome) -> Void) -> Void
    /// The fixed-phrase banner for a reply he took and never showed: (thread id, thread name).
    var banner: (String, String) -> Void
    /// Shown or gone: he stops walking, and a plain bubble restacks.
    var moved: () -> Void
    /// Tells the page whether he delivers now, and which held replies he showed or posted (it forgets those).
    var flag: (Bool, [HeldReply], Int) -> Void
    var pointer: () -> CGPoint
    var spriteFrame: () -> CGRect?
  }

  private enum Phase { case idle, pending, showing }

  var lifetime = ReplyBubbleContent.lifetime
  private let hooks: Hooks
  private(set) var panel: CompanionPanel?
  private(set) var view: CompanionReplyBubbleView?
  private var content = ReplyBubbleContent()
  private var phase = Phase.idle
  /// The panel has been in front of the owner at least once for this content.
  private var shownOnce = false
  private var fetchToken = 0
  private var timer: Timer?
  private var suspended = false
  private var ledger = ReplyLedger()
  private var lastKey = false
  private var lastQuiet = false
  private var names: [String: String] = [:]
  /// A pointer on him or on the bubble keeps it up.
  var spriteHovered = false { didSet { syncClock() } }
  var bubbleHovered = false { didSet { syncClock() } }

  init(hooks: Hooks) { self.hooks = hooks }

  var isShowing: Bool { panel?.isVisible == true }
  var isBusy: Bool { phase != .idle }
  var flagOn: Bool { ledger.flagOn }
  var frame: CGRect? { isShowing ? panel?.frame : nil }
  var timerCount: Int { timer?.isValid == true ? 1 : 0 }

  // MARK: the page's list

  /// Called on every update. Keeps the page told whether he delivers, takes what the page holds, and decides how a reply ends
  /// when he cannot say it (`ReplyLedger`).
  func sync(_ i: CompanionInputs, canDeliver: Bool, mono: TimeInterval) {
    lastKey = i.windowIsKey
    lastQuiet = i.quiet == true
    for t in i.threads { names[t.id] = t.name }
    let working = Set((i.feed?.rows ?? []).filter { $0.state == .working }.map(\.threadId))
    let fx = ledger.update(
      .init(
        held: i.feed?.held ?? [], working: working, windowIsKey: lastKey, quiet: lastQuiet, canDeliver: canDeliver, mono: mono, frameEpoch: i.feed?.repliesEpoch))
    apply(fx)
  }

  private func apply(_ fx: ReplyLedger.Effects) {
    for b in fx.banners { hooks.banner(b.thread, names[b.thread] ?? "A thread") }
    if fx.send { hooks.flag(ledger.flagOn, fx.ack, ledger.epoch) }
    if fx.flag == false { forgetHeld() }
    for d in fx.deliver { deliver(thread: d.thread, name: names[d.thread] ?? "A thread", seq: d.seq, askPage: hooks.askPage()) }
  }

  /// The ledger let the page have what he had taken: it must not also be shown. A bubble that was already shown stays.
  private func forgetHeld() {
    guard phase != .idle, !shownOnce else { return }
    content.removeHeld()
    if content.count == 0 { dismiss() }
  }

  // MARK: a reply to say

  /// A reply in thread `id`: the reducer's own (`seq` nil), or one the page holds. With the page in reach (`askPage`) the bubble
  /// waits for the first line (the page answers within 3 s); a reply that comes meanwhile, or while it is up, joins the bubble.
  func deliver(thread id: String, name: String, seq: Int? = nil, askPage: Bool) {
    let first = phase == .idle
    names[id] = name
    content.add(thread: id, name: name, seq: seq)
    if first { phase = .pending }
    if askPage && content.count == 1 {
      fetchToken += 1
      let token = fetchToken
      hooks.fetch(id) { [weak self] outcome in self?.answered(token, outcome) }
    } else if first {
      present()
    } else if phase == .showing {
      refresh()
    }
  }

  private func answered(_ token: Int, _ outcome: LastReplyTracker.Outcome) {
    guard token == fetchToken, phase != .idle else { return }  // dismissed, or a newer question replaced this one
    if content.count == 1, case .text(let t, let truncated) = outcome {
      content.line = ReplyBubbleContent.firstLine(of: t, truncated: truncated)
    }
    if phase == .pending { present() } else { refresh() }
  }

  private func present() {
    guard hooks.canShow() else { return giveUp() }
    phase = .showing
    if !suspended { refresh() }
  }

  /// He cannot show what he took. If the owner never saw it, the held ones go back to the ledger (a banner outside a key window,
  /// else the page's toast) and the reducer's own become banners; quiet hours get no banner. Then the text goes.
  private func giveUp() {
    if !shownOnce {
      apply(ledger.abandoned(content.held, windowIsKey: lastKey, quiet: lastQuiet))
      if !lastQuiet { for i in content.items where i.seq == nil { hooks.banner(i.id, i.name) } }
    }
    dismiss()
  }

  private func refresh() {
    let v = view ?? makeView()
    let h = v.show(content)
    guard let p = panel, let f = hooks.frame(CGSize(width: CompanionPlacement.replyBubbleWidth, height: h)) else { return giveUp() }
    p.setContentSize(f.size)
    v.frame = NSRect(origin: .zero, size: f.size)
    p.setFrame(f, display: false)
    let wasShowing = p.isVisible
    p.orderFrontRegardless()
    shownOnce = true
    bubbleHovered = f.contains(hooks.pointer())
    restartClock()
    if !wasShowing { hooks.moved() }
    apply(ledger.shown(content.held))  // now the page may forget them
  }

  private func makeView() -> CompanionReplyBubbleView {
    let size = CGSize(width: CompanionPlacement.replyBubbleWidth, height: 100)
    let p = CompanionPanel(size: size)  // never relied on for privacy: see docs/desktop.md
    let v = CompanionReplyBubbleView(frame: NSRect(origin: .zero, size: size))
    p.contentView = v
    v.onOpen = { [weak self] in self?.openNow() }
    v.onClick = { [weak self] in self?.openNow() }
    v.onLater = { [weak self] in self?.dismiss() }
    v.onHoverChanged = { [weak self] in self?.bubbleHovered = $0 }
    panel = p
    view = v
    return v
  }

  private func openNow() {
    let path = content.openPath
    dismiss()
    hooks.open(path)
  }

  /// Later, Open, the clock, or a reason he cannot show it. The text goes with it.
  func dismiss() {
    fetchToken += 1  // an answer still on its way is dropped
    timer?.invalidate()
    timer = nil
    let wasShowing = isShowing
    phase = .idle
    shownOnce = false
    content = ReplyBubbleContent()
    view?.clear()
    panel?.orderOut(nil)
    bubbleHovered = false
    // The pointer may still be on him: read it, do not assume it left.
    spriteHovered = hooks.spriteFrame().map { $0.insetBy(dx: -2, dy: -2).contains(hooks.pointer()) } ?? false
    if wasShowing { hooks.moved() }
  }

  /// A mic, the quiet window or the page going away while a reply is up or on its way.
  func interrupt() {
    guard phase != .idle else { return }
    giveUp()
  }

  /// A drag hides it; the drop brings it back (the reply is still there).
  func suspend(_ on: Bool) {
    suspended = on
    if on {
      timer?.invalidate()
      timer = nil
      let wasShowing = isShowing
      panel?.orderOut(nil)
      if wasShowing { hooks.moved() }
    } else if phase == .showing {
      if hooks.canShow() { refresh() } else { giveUp() }
    }
  }

  /// The controls came or went: sit past them.
  func relayout() {
    if phase == .showing, !suspended, let v = view, let p = panel,
      let f = hooks.frame(CGSize(width: CompanionPlacement.replyBubbleWidth, height: v.frame.height))
    {
      p.setFrame(f, display: false)
      if bubbleHovered && !f.contains(hooks.pointer()) { bubbleHovered = false }  // it moved out from under the pointer
    }
  }

  /// The space this bubble and the controls take, for a plain bubble to sit past.
  func stack(past controls: CGRect?) -> CGRect? {
    guard let mine = frame else { return controls }
    return controls.map { $0.union(mine) } ?? mine
  }

  func restartClock() {
    timer?.invalidate()
    timer = nil
    guard phase == .showing, !suspended, !spriteHovered, !bubbleHovered else { return }
    let t = Timer(timeInterval: lifetime, repeats: false) { [weak self] _ in
      MainActor.assumeIsolated { self?.dismiss() }
    }
    RunLoop.main.add(t, forMode: .common)
    timer = t
  }

  private func syncClock() {
    guard phase == .showing else { return }
    if spriteHovered || bubbleHovered {
      timer?.invalidate()
      timer = nil
    } else {
      restartClock()
    }
  }

  /// Everything off: no panel, no timer, no text; what he took and never showed is accounted for, and the page's banner is back.
  func close() {
    if phase != .idle { giveUp() }
    apply(ledger.stop(windowIsKey: lastKey, quiet: lastQuiet))
    dismiss()
    panel?.contentView = nil
    panel?.close()
    panel = nil
    view = nil
  }
}

extension CompanionReplyBubble.Hooks {
  /// His hooks into the controller, held weakly.
  @MainActor static func make(for c: CompanionController) -> CompanionReplyBubble.Hooks {
    .init(
      frame: { [weak c] in c?.replyFrame($0) }, canShow: { [weak c] in c?.cardAllowed ?? false },
      askPage: { [weak c] in c?.cardIsShowing == false }, open: { [weak c] in c?.host.openPath($0) },
      fetch: { [weak c] in c?.host.requestReply($0, $1) }, banner: { [weak c] in c?.host.postReplyBanner($0, $1) },
      moved: { [weak c] in c?.replyMoved() }, flag: { [weak c] in c?.host.setRepliesFlag($0, $1, $2) },
      pointer: { [weak c] in c?.pointerProvider() ?? .zero }, spriteFrame: { [weak c] in c?.spritePanel?.frame })
  }
}

extension CompanionController {
  func replyMoved() {
    stopWalk()
    if bubbleVisible { positionBubble() }
  }

  /// Above him by default, past the hover controls, on screen.
  func replyFrame(_ size: CGSize) -> CGRect? {
    guard let sp = spritePanel, let s = screenContaining(CGPoint(x: sp.frame.midX, y: sp.frame.midY), host.screens()) else { return nil }
    return CompanionPlacement.replyBubbleFrame(
      sprite: sp.frame, size: size, past: controlsPanel?.isVisible == true ? controlsPanel?.frame : nil, in: s.visibleFrame)
  }

  /// What the banner decision needs to know about him right now.
  func petNow() -> CompanionBannerPolicy.Pet {
    let i = inputsProvider()
    let working = Set((i.feed?.rows ?? []).filter { $0.state == .working }.map(\.threadId))
    return .init(
      onScreen: spritePanel != nil && !system.animationsPaused, quiet: i.quiet, micRunning: currentEnv().micRunning, feedLive: i.feed != nil,
      state: output?.state ?? .idle, replyBanners: replyBannersOn, viewedThread: i.viewedThread, windowIsKey: i.windowIsKey,
      workingThreads: working)
  }
}
