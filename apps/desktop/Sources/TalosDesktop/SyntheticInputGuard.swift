import AppKit
import Foundation
import SwiftTerm
import TalosDesktopCore
import WebKit

/// The AppKit side of `SyntheticInput` (docs/SECURITY.md "An agent in Talos"): what an event's origin is, how the Talos window tells its
/// page, and which native windows and views drop a synthetic event outright (prompt windows, every terminal view). The rules are in
/// Core; this file only reads events and wires them.
enum SyntheticInputGuard {
  /// The token Talos put on an event it posted for an agent (0: not one of ours).
  static func token(of event: NSEvent) -> Int64 { event.cgEvent?.getIntegerValueField(.eventSourceUserData) ?? 0 }

  /// The origin of an event: its CGEvent's source and token, and whether an event of ours still awaits its answer. An event with no
  /// CGEvent is synthetic (hardware events always have one).
  static func origin(of event: NSEvent, flight: SyntheticInput.Flight = SyntheticInput.flight) -> SyntheticInput.Origin {
    let cg = event.cgEvent
    return SyntheticInput.classify(
      sourcePid: cg?.getIntegerValueField(.eventSourceUnixProcessID), sourceStateId: cg?.getIntegerValueField(.eventSourceStateID),
      userData: cg?.getIntegerValueField(.eventSourceUserData), postedByThisProcessNow: flight.active)
  }

  /// The events a page stamp is made for (the ones that can press a button), named as the page script knows them. nil: not one.
  static func stampName(_ t: NSEvent.EventType) -> String? {
    switch t {
    case .leftMouseDown: return "leftMouseDown"
    case .leftMouseUp: return "leftMouseUp"
    case .rightMouseDown: return "rightMouseDown"
    case .rightMouseUp: return "rightMouseUp"
    case .otherMouseDown: return "otherMouseDown"
    case .otherMouseUp: return "otherMouseUp"
    case .keyDown: return "keyDown"
    case .keyUp: return "keyUp"
    default: return nil
    }
  }

  /// The events of a posted request that a window answers (`ScreenInputEvent.answers`): a release, a key-up, a scroll.
  static func isAnswerType(_ t: NSEvent.EventType) -> Bool {
    switch t {
    case .leftMouseUp, .rightMouseUp, .otherMouseUp, .keyUp, .scrollWheel: return true
    default: return false
    }
  }

  static var world: WKContentWorld { WKContentWorld.world(name: ProtectedInputScript.worldName) }

  /// Adds the page script and its answer handler to a web view's configuration.
  static func install(in cfg: WKWebViewConfiguration, flight: SyntheticInput.Flight = SyntheticInput.flight) {
    let w = world
    cfg.userContentController.addUserScript(
      WKUserScript(source: ProtectedInputScript.source, injectionTime: .atDocumentStart, forMainFrameOnly: true, in: w))
    cfg.userContentController.add(DropCounter(flight: flight), contentWorld: w, name: ProtectedInputScript.handlerName)
  }

  /// Tells the page who sent the next event, before the event is delivered. The message and the event go to the web process in this
  /// order (one connection); if the message cannot be sent the page holds no fresh stamp for the event and refuses it.
  @MainActor
  static func stamp(_ wv: WKWebView?, _ origin: SyntheticInput.Origin, _ type: String, token: Int64 = 0, keyCode: UInt16 = 0) {
    let kind = origin == .human ? "human" : "synthetic"
    // every value is a fixed name or a number, never text from outside
    wv?.evaluateJavaScript(
      "window.__talosGuardStamp && window.__talosGuardStamp('\(kind)','\(type)',\(token),\(keyCode))", in: nil, in: world
    ) { _ in }
  }

  /// Asks the page to answer `token` once the event just delivered has run through its handlers (the page tells the app, after any
  /// drop it reported for that token).
  @MainActor
  static func ack(_ wv: WKWebView?, token: Int64) {
    wv?.evaluateJavaScript("window.__talosGuardAck && window.__talosGuardAck(\(token))", in: nil, in: world) { _ in }
  }

  /// A native window that answers prompts: the popup, a sheet, an alert or open panel, anything while a modal session runs.
  @MainActor
  static func isPromptWindow(_ w: NSWindow?) -> Bool {
    guard let w else { return false }
    return w is NeedsYouPanel || w is PairingPanel || w.isSheet || w.sheetParent != nil || w is NSPanel && w.worksWhenModal
      || NSApp.modalWindow != nil
  }

  /// A terminal view takes the event: the key goes to the first responder, a mouse event to the view under the pointer. Every terminal
  /// in Talos is a SwiftTerm `TerminalView` (the agent's pane, the owner's shell, the sign-in pane), and each answers on-pane prompts
  /// or runs commands as the owner.
  @MainActor
  static func isTerminalTarget(_ event: NSEvent, in window: NSWindow? = nil) -> Bool {
    guard let w = window ?? event.window else { return false }
    switch event.type {
    case .keyDown, .keyUp: return w.firstResponder is TerminalView
    default:
      var v = w.contentView?.superview?.hitTest(event.locationInWindow)
      while let x = v {
        if x is TerminalView { return true }
        v = x.superview
      }
      return false
    }
  }

  /// Decides one mouse or key event for the whole app. false: drop it. A synthetic event aimed at a prompt window or a terminal is
  /// dropped and reported against its token; an event of ours aimed at any other native window is answered ("handled") as it is let
  /// through. Events for the Talos web page are answered by the page (`WebNSWindow`).
  @MainActor
  static func admit(_ event: NSEvent, flight: SyntheticInput.Flight = SyntheticInput.flight) -> Bool {
    let t = token(of: event)
    if (isPromptWindow(event.window) || isTerminalTarget(event)) && origin(of: event, flight: flight) == .synthetic {
      flight.drop(t)
      return false
    }
    if t != 0, isAnswerType(event.type), !(event.window is WebNSWindow) { flight.handled(t) }
    return true
  }

  /// The same drop, for a window's own `sendEvent` (the monitor is the first line, this is the second): a synthetic event aimed at a
  /// terminal view goes no further. false: drop it.
  @MainActor
  static func admitAtTerminal(_ event: NSEvent, in window: NSWindow, flight: SyntheticInput.Flight = SyntheticInput.flight) -> Bool {
    guard stampName(event.type) != nil, isTerminalTarget(event, in: window), origin(of: event, flight: flight) == .synthetic else { return true }
    flight.drop(token(of: event))
    return false
  }

  private nonisolated(unsafe) static var monitor: Any?

  /// An AppKit local monitor sees every event the app dispatches, modal sessions included, before any window does.
  @MainActor
  static func installMonitor(flight: SyntheticInput.Flight = SyntheticInput.flight) {
    guard monitor == nil else { return }
    let mask: NSEvent.EventTypeMask = [
      .leftMouseDown, .leftMouseUp, .rightMouseDown, .rightMouseUp, .otherMouseDown, .otherMouseUp, .keyDown, .keyUp, .scrollWheel,
    ]
    // AppKit calls a local monitor on the main thread; the event is handed through an unchecked box only to satisfy the checker
    monitor = NSEvent.addLocalMonitorForEvents(matching: mask) { event in
      nonisolated(unsafe) let e = event
      let ok = MainActor.assumeIsolated { admit(e, flight: flight) }
      return ok ? e : nil
    }
  }
}

/// What the page script tells the app: an answer for a token, or an event it cancelled (with the token of the stamp it held).
final class DropCounter: NSObject, WKScriptMessageHandler {
  private let flight: SyntheticInput.Flight
  init(flight: SyntheticInput.Flight) { self.flight = flight }
  func userContentController(_ c: WKUserContentController, didReceive message: WKScriptMessage) {
    guard message.frameInfo.isMainFrame, let body = message.body as? [String: Any] else { return }
    func int(_ k: String) -> Int64 { (body[k] as? NSNumber)?.int64Value ?? 0 }
    if body["ack"] != nil { flight.handled(int("ack")) } else if body["dropped"] != nil { flight.drop(int("token")) }
  }
}

extension SafeTerminalView {
  /// Whether a mouse or key event is the owner's own: a terminal takes nothing else.
  func permits(_ event: NSEvent) -> Bool {
    if SyntheticInputGuard.origin(of: event) == .human { return true }
    SyntheticInput.flight.drop(SyntheticInputGuard.token(of: event))
    return false
  }
}

/// Notification observers that end with their owner.
final class ObserverBag: @unchecked Sendable {
  var tokens: [NSObjectProtocol] = []
  deinit { for t in tokens { NotificationCenter.default.removeObserver(t) } }
}

/// The Talos window. Every key event passes `intercept` first, so a key the page's own screen owns (Ctrl+1 … Ctrl+9 on the Terminal
/// screen, typed into the embedded terminal) never reaches the terminal, which would send it to the session as a control byte.
/// The hook decides narrowly and returns false for everything else, which then goes the usual way.
final class WebNSWindow: NSWindow {
  var intercept: ((NSEvent) -> Bool)?
  /// Called with the origin, name, token and key code of every mouse press or key event, before it is delivered to the page.
  var stamp: ((SyntheticInput.Origin, String, Int64, UInt16) -> Void)?
  /// Called after an event of ours (it has a token) was delivered, for the events a request waits on.
  var answer: ((Int64) -> Void)?

  /// When a person last clicked (the release) or pressed Return or Space in this window, while it was the key window. Written by
  /// `sendEvent` below and nowhere else, from an event's own origin (`SyntheticInput`); `private`, so no message, page script or other
  /// code can set it. The run channel spends it with `takeHumanActivation()`: one click or key vouches for one thing.
  private var activation = HumanActivation()
  /// The clock the stamp is taken on: monotonic, and it counts sleep. Tests move it (`setActivationClockForTest`).
  private var activationClock: () -> Double = Monotonic.now
  /// When the app last became active or this window last became key, on `activationClock`: a press this soon after is the click that brought
  /// the window forward, not a person pressing a button in it (`PaneRun.activationSettleSeconds`). Written by the two notifications below.
  private var lastBroughtForwardAt: Double?
  private let observers = ObserverBag()

  override init(contentRect: NSRect, styleMask style: NSWindow.StyleMask, backing: NSWindow.BackingStoreType, defer flag: Bool) {
    super.init(contentRect: contentRect, styleMask: style, backing: backing, defer: flag)
    let nc = NotificationCenter.default
    let note: (Notification) -> Void = { [weak self] _ in MainActor.assumeIsolated { self?.lastBroughtForwardAt = self?.activationClock() } }
    observers.tokens = [
      nc.addObserver(forName: NSApplication.didBecomeActiveNotification, object: nil, queue: nil, using: note),
      nc.addObserver(forName: NSWindow.didBecomeKeyNotification, object: self, queue: nil, using: note),
    ]
  }

  /// Whether the mouse press that is down now began in the key window. The click that only brings this window to the front does not
  /// count: it was not aimed at anything in the window.
  private var pressBeganInKeyWindow = false

  /// Return, the numeric pad's Enter and Space: the keys that press a focused button.
  private static let activationKeys: Set<UInt16> = [36, 76, 49]

  /// Spends the stamp: true when a person's click or Return/Space reached this window no more than `PaneRun.clickSeconds` ago and no
  /// earlier call has used it.
  func takeHumanActivation() -> Bool { activation.take(now: activationClock()) }

  #if DEBUG
    private var keyOverride: (() -> Bool)?
    func setActivationClockForTest(_ c: @escaping () -> Double) { activationClock = c }
    func setActivationKeyForTest(_ k: @escaping () -> Bool) { keyOverride = k }
  #endif

  private func isKeyForActivation() -> Bool {
    #if DEBUG
      if let k = keyOverride { return k() }
    #endif
    return isKeyWindow
  }

  /// Whether the event is aimed at the page: for a key, the first responder is the web view (or inside it); for a mouse event, the view
  /// under the pointer is. The native terminal pane and its tab strip are laid over the web view and do not count: Return in a shell is
  /// not a person pressing Run.
  private func isAimedAtThePage(_ event: NSEvent) -> Bool {
    guard let content = contentView else { return false }
    var v: NSView? = event.type == .keyDown ? firstResponder as? NSView : content.superview?.hitTest(event.locationInWindow)
    while let x = v {
      if x is TerminalView || x is WindowBackgroundView { return false }
      if x === content { return true }
      v = x.superview
    }
    return false
  }

  private func noteHumanActivation(_ event: NSEvent) {
    guard SyntheticInputGuard.origin(of: event) == .human, isAimedAtThePage(event) else {
      if event.type == .leftMouseDown || event.type == .leftMouseUp { pressBeganInKeyWindow = false }
      return
    }
    switch event.type {
    case .leftMouseDown:
      // in a window that is key, and that did not become key (or whose app did not become active) a moment ago
      let settled = lastBroughtForwardAt.map { activationClock() - $0 > PaneRun.activationSettleSeconds } ?? true
      pressBeganInKeyWindow = isKeyForActivation() && settled
    case .leftMouseUp:
      let counts = pressBeganInKeyWindow
      pressBeganInKeyWindow = false
      if counts { activation.record(at: activationClock()) }
    case .keyDown:
      if !event.isARepeat, Self.activationKeys.contains(event.keyCode), isKeyForActivation() { activation.record(at: activationClock()) }
    default: break
    }
  }

  override func sendEvent(_ event: NSEvent) {
    guard SyntheticInputGuard.admitAtTerminal(event, in: self) else { return }
    noteHumanActivation(event)
    if event.type == .keyDown, intercept?(event) == true { return }
    // The page learns who sent the event first; with no way to tell, the page is told "synthetic" (fail closed).
    let t = SyntheticInputGuard.token(of: event)
    if let name = SyntheticInputGuard.stampName(event.type) {
      let code: UInt16 = (event.type == .keyDown || event.type == .keyUp) ? event.keyCode : 0
      stamp?(SyntheticInputGuard.origin(of: event), name, t, code)
    }
    super.sendEvent(event)
    if t != 0, SyntheticInputGuard.isAnswerType(event.type) { answer?(t) }
  }
}

extension WebController {
  /// Every mouse press and key event the window gets is stamped on the page first, and an event of ours is answered after it
  /// (`WebNSWindow.sendEvent`).
  func wireInputStamps(_ w: WebNSWindow) {
    w.stamp = { [weak self] origin, name, token, code in SyntheticInputGuard.stamp(self?.webView, origin, name, token: token, keyCode: code) }
    w.answer = { [weak self] token in SyntheticInputGuard.ack(self?.webView, token: token) }
  }
}
