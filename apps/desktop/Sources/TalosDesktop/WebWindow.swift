import AppKit
import Foundation
import TalosDesktopCore
import WebKit

/// The Talos window. Every key event passes `intercept` first, so a key the page's own screen owns (Ctrl+1 … Ctrl+9 on the Terminal
/// screen, typed into the embedded terminal) never reaches the terminal, which would send it to the session as a control byte.
/// The hook decides narrowly and returns false for everything else, which then goes the usual way.
final class WebNSWindow: NSWindow {
  var intercept: ((NSEvent) -> Bool)?

  override func sendEvent(_ event: NSEvent) {
    if event.type == .keyDown, intercept?(event) == true { return }
    super.sendEvent(event)
  }
}

/// The Talos web app in a normal window (DESKTOP-SPEC 5.1). The view is never torn down: closing the window orders it out,
/// so the page keeps its socket and its notifications. Thin by design: every screen is the web app; this file is glue.
@MainActor
final class WebController: NSObject, ObservableObject, WKNavigationDelegate, WKUIDelegate, NSWindowDelegate, NativeBridgeDelegate {
  static let shared = WebController()

  @Published private(set) var relay: RelayOrigin?
  @Published private(set) var signedIn = false {
    didSet {
      if !signedIn { companionGone() }
      applyTerminal()
    }
  }
  @Published private(set) var needsYou = 0
  /// Every write that makes this false (a new document committing, a crashed or replaced web view, the watchdog) also drops
  /// the companion feed, so the pet never shows the last frame of a page that is gone.
  @Published private(set) var pageReady = false {
    didSet {
      if !pageReady {
        pageFeatures = []
        failPendingAcks()
        companionGone()
        // The room the page asked for belonged to the document that is gone; a new document asks again.
        terminalRect = nil
        terminal.close()
        stopTerminalSessions()
      }
    }
  }
  @Published private(set) var threads: [WebToNative.Thread] = []
  /// What the page said it can do at `ready` (`companion/1` and the rest). Empty until the page is ready.
  private(set) var pageFeatures: [String] = []
  /// The companion's feed (DESKTOP-COMPANION-SPEC 7.1). A plain property and a callback, not `@Published`: `TalosApp` observes
  /// this controller, and a published feed would rebuild the menu bar scene on every frame. nil when the page is gone, signed
  /// out, silent for 90 s, a wake from sleep happened, a frame failed decoding, or the page does not have `companion/1`.
  var companionFeed: CompanionFeed? { companionGate.feed }
  /// Called on every change of `companionFeed`, including to nil. An equal frame does not call it.
  var onCompanionFeed: ((CompanionFeed?) -> Void)?
  /// The Talos window is the key window (Done must not fire while the owner is looking at the page).
  var windowIsKey: Bool { window?.isKeyWindow == true }
  /// The thread the window shows right now, by the page's own routing (`companion_state.viewing`; a card page counts as its
  /// thread), while the window is on screen. nil otherwise. Whether anyone is reading it is `windowIsKey`.
  var viewedThread: String? {
    guard let w = window, w.isVisible, w.isKeyWindow || w.occlusionState.contains(.visible) else { return nil }
    return companionFeed?.viewing
  }
  /// What the status list needs to know about the page (spec 4.2): down (not loaded or not signed in), an older page without
  /// `companion/1`, or ready for the feed.
  var companionPageStatus: CompanionPageStatus {
    guard pageReady, signedIn else { return .down }
    return pageFeatures.contains("companion/1") ? .ready : .noFeed
  }
  private var companionGate = CompanionFeedGate()
  private var staleTimer: Timer?
  private var wakeObserver: NSObjectProtocol?
  private var activeObserver: NSObjectProtocol?
  private var replyTracker = LastReplyTracker()
  private var replyDone: (@MainActor (LastReplyTracker.Outcome) -> Void)?
  /// A native notification request from the page (WP-D4 shows it).
  var onNotify: ((_ title: String, _ body: String, _ navigate: String, _ tag: String?) -> Void)?

  /// The agent terminal laid over the page's Terminal screen (`terminal_view`), and the room the page last asked for. The
  /// terminal shows only while the window is on screen and the page is signed in; the room is kept across a hidden window.
  let terminal = EmbeddedTerminal()

  private(set) var terminalRect: TerminalViewRect?
  /// What the Terminal screen's tabs read: the Terminals window's list, and what Resume does. Tests hand in their own.
  struct TerminalSessionSource {
    var snapshot: () -> (entries: [SwitcherEntry], workers: WorkersFile?)?
    var resume: (String) -> TerminalSessions.ResumeOutcome
    @MainActor static let live = TerminalSessionSource(
      snapshot: { TerminalWindowController.shared.switcherSnapshot() },
      resume: { SessionList.resumeOutcome(TerminalWindowController.shared.requestResume($0)) })
  }
  var terminalSessionSource = TerminalSessionSource.live
  /// The page tells us about its tabs only when it said it can read them (`terminal-tabs/1` in `ready`).
  static let tabsFeature = "terminal-tabs/1"
  var sessionsTimer: Timer?
  /// Choose… for a thread's folder: the Mac's open panel (replaced in tests, which show none) and whether one is up (WebWindowFolder.swift).
  var folderPanel: (FolderPanelSpec) -> String? = { WebController.runOpenPanel($0) }
  var pickingFolder = false
  var lastSessionsSent: [TerminalSessions.Item]?
  /// Tests: whether the list is being kept current right now.
  var terminalSessionsTimerRunningForTest: Bool { sessionsTimer != nil }

  var window: NSWindow?
  private(set) var webView: WKWebView?
  private var bridge: NativeBridge?
  private var activity: NSObjectProtocol?
  private var queued: [NativeToWeb] = []
  private var config: WKWebViewConfiguration?
  /// The last load failed (relay down at launch, network not up yet, web process gone): the window sits hidden for days,
  /// so it retries by itself and `show()` reloads at once.
  @Published private(set) var loadFailed = false {
    didSet { if loadFailed != oldValue { updateFailureOverlay() } }
  }
  private var failureOverlay: NSView?
  private var retryAttempt = 0
  private var retryTimer: Timer?
  private var watchdog: Timer?
  static let retryDelays: [TimeInterval] = [2, 5, 15, 30, 60]

  static let version: String = (Bundle.main.infoDictionary?["CFBundleShortVersionString"] as? String) ?? "dev"
  /// The build number (`CFBundleVersion`), nil when the bundle has none (`swift run`).
  static let build: String? = Bundle.main.infoDictionary?["CFBundleVersion"] as? String

  /// desktop.json `relay_url`, else `TALOS_APP_RELAY_URL` in `$TALOS_APP_HOME/bridge.env`.
  static func resolveRelay(configured: String, home: String = NSHomeDirectory()) -> RelayOrigin? {
    let appHome = ProcessInfo.processInfo.environment["TALOS_APP_HOME"].flatMap { $0.isEmpty ? nil : $0 } ?? home + "/.config/talos/app"
    let env = try? String(contentsOfFile: appHome + "/bridge.env", encoding: .utf8)
    return RelayConfig.resolve(configured: configured, bridgeEnv: env)
  }

  /// Opens a link in the default browser. Tests replace it with a spy.
  var openExternal: (URL) -> Void = { NSWorkspace.shared.open($0) }

  // MARK: attachments (audit D13)

  /// Where a link that leaves the window goes. An attachment on the relay (`/media/:id`) used to go to the default browser,
  /// which has no session and got a raw 401. The app downloads it itself, with the window's own sign-in, behind a save panel.
  /// Agent pages (`/media/:id/page`) and every other link still go to the browser.
  func routeExternal(_ u: URL) {
    guard let relay, let wv = webView, WebPolicy.isMediaFile(u, relay: relay) else { return openExternal(u) }
    wv.startDownload(using: URLRequest(url: u)) { [weak self] d in d.delegate = self }
  }

  /// Asks where to save. Tests replace it with a fixed folder.
  var chooseDestination: (_ filename: String, _ done: @escaping @MainActor (URL?) -> Void) -> Void = { name, done in
    let p = NSSavePanel()
    p.nameFieldStringValue = name
    p.canCreateDirectories = true
    NSApp.activate(ignoringOtherApps: true)
    p.begin { r in
      let url = r == .OK ? p.url : nil
      Task { @MainActor in done(url) }
    }
  }
  /// A file that could not be saved is said out loud, never silent.
  var downloadProblem: (String) -> Void = { text in
    NSApp.activate(ignoringOtherApps: true)
    let a = NSAlert()
    a.messageText = "Couldn't save the file"
    a.informativeText = text
    a.runModal()
  }
  var downloadSaved: (URL) -> Void = { NSWorkspace.shared.activateFileViewerSelecting([$0]) }
  private var downloadTargets: [ObjectIdentifier: (part: URL, final: URL)] = [:]
  private var downloadDeclined: Set<ObjectIdentifier> = []

  func configure(relayUrl: String) { configure(relay: Self.resolveRelay(configured: relayUrl)) }

  func configure(relay r: RelayOrigin?) {
    guard r != relay else { return }
    relay = r
    if let wv = webView, let r { wv.load(URLRequest(url: r.url)) }
    else if r != nil { prepare() }  // set after launch (Settings): the page must start loading now, not at the next Show Talos
    if let r { bridge?.relay = r }
  }

  var hasRelay: Bool { relay != nil }

  var pageState: PageState { PageState.resolve(pageReady: pageReady, signedIn: signedIn, loadFailed: loadFailed) }

  /// Try now: reload at once instead of waiting for the next retry.
  func retryNow() {
    retryAttempt = 0
    reload()
  }

  /// A failed load used to leave a grey, blank window. The overlay says what is happening and offers Try now (audit D46).
  private func updateFailureOverlay() {
    failureOverlay?.removeFromSuperview()
    failureOverlay = nil
    guard loadFailed, let host = webView else { return }
    let label = NSTextField(labelWithString: PageState.unreachableLine)
    label.font = .systemFont(ofSize: 15, weight: .medium)
    let button = NSButton(title: "Try now", target: self, action: #selector(retryNowClicked))
    // Help cannot load from a server that is down, so the fixes that need no server are written here (PageState.outageHelp).
    let help = NSTextField(wrappingLabelWithString: PageState.outageHelp.joined(separator: "\n\n"))
    help.font = .systemFont(ofSize: 13)
    help.textColor = .secondaryLabelColor
    help.isSelectable = true
    help.preferredMaxLayoutWidth = 420
    help.identifier = NSUserInterfaceItemIdentifier("outage-help")
    let stack = NSStackView(views: [label, button, help])
    stack.orientation = .vertical
    stack.spacing = 12
    stack.translatesAutoresizingMaskIntoConstraints = false
    let box = NSVisualEffectView()
    box.material = .windowBackground
    box.blendingMode = .withinWindow
    box.state = .active
    box.translatesAutoresizingMaskIntoConstraints = false
    box.addSubview(stack)
    host.addSubview(box)
    NSLayoutConstraint.activate([
      box.leadingAnchor.constraint(equalTo: host.leadingAnchor), box.trailingAnchor.constraint(equalTo: host.trailingAnchor),
      box.topAnchor.constraint(equalTo: host.topAnchor), box.bottomAnchor.constraint(equalTo: host.bottomAnchor),
      stack.centerXAnchor.constraint(equalTo: box.centerXAnchor), stack.centerYAnchor.constraint(equalTo: box.centerYAnchor),
    ])
    failureOverlay = box
  }

  @objc private func retryNowClicked() { retryNow() }

  /// Tests: the overlay is in the view tree.
  var failureOverlayShownForTest: Bool { failureOverlay?.superview != nil }
  func setLoadFailedForTest(_ v: Bool) { loadFailed = v }
  /// Tests: what the watchdog does to a page that stopped answering.
  func replaceWebViewForTest() { replaceWebView() }
  /// Tests: the words the failure overlay shows.
  var failureOverlayTextForTest: [String] {
    func texts(_ v: NSView) -> [String] { (v as? NSTextField).map { [$0.stringValue] } ?? v.subviews.flatMap(texts) }
    return failureOverlay.map(texts) ?? []
  }

  // MARK: window

  /// Builds the window and starts loading, without showing it, so the page's socket is up before anyone opens it.
  func prepare() {
    guard let relay, window == nil else { return }
    build(relay)
  }

  func show() {
    guard let relay else { return }
    if window == nil { build(relay) }
    if loadFailed { reload() }
    NSApp.activate(ignoringOtherApps: true)
    window?.makeKeyAndOrderFront(nil)
    applyTerminal()
  }

  private func build(_ relay: RelayOrigin) {
    let cfg = WKWebViewConfiguration()
    cfg.websiteDataStore = .default()
    cfg.preferences.inactiveSchedulingPolicy = .none  // keep the socket and notifications alive while hidden
    cfg.applicationNameForUserAgent = WebPolicy.userAgentApplicationName(version: Self.version)
    let bridge = NativeBridge(relay: relay)
    bridge.delegate = self
    self.bridge = bridge
    cfg.userContentController.addScriptMessageHandler(bridge, contentWorld: .page, name: "talos")

    config = cfg
    let wv = makeWebView()
    webView = wv

    let w = WebNSWindow(
      contentRect: NSRect(x: 0, y: 0, width: 1120, height: 780),
      styleMask: [.titled, .closable, .miniaturizable, .resizable], backing: .buffered, defer: false)
    w.title = "Talos"
    w.contentView = wv
    w.isReleasedWhenClosed = false
    w.delegate = self
    w.intercept = { [weak self] e in self?.interceptKey(e) ?? false }
    w.center()
    w.setFrameAutosaveName("TalosWebWindow")
    window = w
    wv.load(URLRequest(url: relay.url))
    startWatchdog()
    // Timers don't count sleep, and a page that slept may have missed frames: after a wake the feed is gone until the next
    // frame. The notification posts on the workspace's center; on `NotificationCenter.default` it never arrives.
    wakeObserver = NSWorkspace.shared.notificationCenter.addObserver(
      forName: NSWorkspace.didWakeNotification, object: nil, queue: .main
    ) { [weak self] _ in
      Task { @MainActor in self?.companionGone() }
    }
    // He may have changed Talos in System Settings > Notifications and come back: tell the page again.
    activeObserver = NotificationCenter.default.addObserver(
      forName: NSApplication.didBecomeActiveNotification, object: nil, queue: .main
    ) { [weak self] _ in
      Task { @MainActor in self?.pushNotifyPermission() }
    }
  }

  /// Tells the page what macOS says about notifications (Settings > Notifications). Only to a page that has said `ready`.
  func pushNotifyPermission() {
    guard pageReady else { return }
    Notifier.shared.currentPermission { [weak self] p in
      guard let self, self.pageReady, let p else { return }
      self.deliver(.notifyPermission(p))
    }
  }

  private func makeWebView() -> WKWebView {
    let wv = WKWebView(frame: .zero, configuration: config ?? WKWebViewConfiguration())
    wv.navigationDelegate = self
    wv.uiDelegate = self
    wv.allowsBackForwardNavigationGestures = true
    wv.setValue(false, forKey: "drawsBackground")
    return wv
  }

  /// A web process that stopped answering can't be reloaded in place (OBSERVED: the load never starts), so the view is
  /// replaced: a new view on the same configuration and data store gets a fresh web process; the old one is released.
  private func replaceWebView() {
    guard let relay, let w = window else { return }
    let fresh = makeWebView()
    w.contentView = fresh
    webView?.navigationDelegate = nil
    webView?.uiDelegate = nil
    webView = fresh
    pageReady = false
    failureOverlay = nil
    if loadFailed { updateFailureOverlay() }
    fresh.load(URLRequest(url: relay.url))
  }

  /// A web-content crash while the window is hidden can go unannounced (OBSERVED: no delegate call reaches us, and a
  /// pending script never answers). So every 1.5 s, when nothing is loading, the app asks the page for `1`; no answer within
  /// 1 s twice in a row means the page is gone and it reloads. A healthy page answers in milliseconds.
  private func startWatchdog() {
    watchdog?.invalidate()
    watchdog = Timer.scheduledTimer(withTimeInterval: 1.5, repeats: true) { [weak self] _ in
      Task { @MainActor in self?.heartbeat() }
    }
  }

  private var missedBeats = 0
  private var beatInFlight = false

  private func heartbeat() {
    guard let wv = webView, !wv.isLoading, !beatInFlight else { return }
    beatInFlight = true
    var answered = false
    wv.evaluateJavaScript("1") { [weak self] _, error in
      Task { @MainActor in
        answered = true
        guard let self else { return }
        self.beatInFlight = false
        if error == nil { self.missedBeats = 0 }
      }
    }
    Task { @MainActor [weak self] in
      try? await Task.sleep(nanoseconds: 1_000_000_000)
      guard let self, !answered else { return }
      self.beatInFlight = false
      self.missedBeats += 1
      if self.missedBeats >= 2 {
        self.missedBeats = 0
        self.pageReady = false
        self.loadFailed = true
        self.replaceWebView()
      }
    }
  }

  /// Closing only hides the window; the page keeps running.
  func windowShouldClose(_ sender: NSWindow) -> Bool {
    terminal.close()  // a hidden window keeps no tmux viewer; `show()` brings it back
    sender.orderOut(nil)
    // willClose never posts for a window that only hides, so the Dock icon is told here (a hidden window does not count).
    ActivationPolicyController.shared.refresh(excluding: sender)
    return false
  }

  /// The page sends the new room a moment after a resize. Until then the terminal is cut to what the window has left.
  func windowDidResize(_ notification: Notification) { applyTerminal() }

  // MARK: agent terminal

  /// Tests: a web view that is in no window, and whether the window counts as on screen.
  var windowVisibleForTest: Bool?
  func useWebViewForTest(_ wv: WKWebView, windowVisible: Bool, window w: NSWindow? = nil) {
    webView = wv
    windowVisibleForTest = windowVisible
    if let w { window = w }
    (window as? WebNSWindow)?.intercept = { [weak self] e in self?.interceptKey(e) ?? false }
  }

  /// Lays the terminal over the room the page asked for, or takes it away: nothing asked, the window is hidden, the page is
  /// not signed in, or what is left of the room inside the window is too small.
  private func applyTerminal() {
    if !signedIn { stopTerminalSessions() }
    guard let wv = webView,
      let frame = TerminalViewRect.placement(
        asked: terminalRect, pageReady: pageReady, signedIn: signedIn,
        windowVisible: windowVisibleForTest ?? (window?.isVisible == true), in: wv.bounds.size, flipped: wv.isFlipped,
        minimum: EmbeddedTerminal.minimumSize)
    else { return terminal.close() }
    terminal.show(in: wv, frame: frame)
  }

  // The Edit menu (Cut, Copy, Paste, Select All, Undo) comes from `AppMenu`, which installs it for the whole app; this window
  // no longer adds its own.

  // MARK: native -> page

  /// Sends now when the page has said `ready`; otherwise holds the message and sends it once, when the page is ready.
  func sendWhenReady(_ m: NativeToWeb, reveal: Bool = true) {
    if pageReady { deliver(m) } else { queued.append(m) }
    if reveal { show() }
  }

  /// Whether he delivers replies himself (`companion_replies`): kept here so every new document hears it after its `ready`.
  private(set) var companionReplies = false
  private var companionRepliesEpoch = 0
  func setCompanionReplies(_ on: Bool, shown: [HeldReply] = [], epoch: Int = 0) {
    guard on != companionReplies || !shown.isEmpty || (on && epoch != companionRepliesEpoch) else { return }
    companionReplies = on
    companionRepliesEpoch = epoch
    if pageReady { deliver(.companionReplies(on: on, shown: shown, epoch: on ? epoch : nil)) }
  }

  /// Tests: also records what the page sent after the gate.
  var testHook: ((WebToNative) -> Void)?
  func deliverForTest(_ m: NativeToWeb) { deliver(m) }

  /// What the page said to a message that was handed to it.
  /// - taken: the page accepted it (and, for a page that does work first, finished it).
  /// - notTaken: the page refused it, threw, has no receiver, or answered anything but a real `true`. Nothing was kept.
  /// - lost: the page went away before it answered. It may or may not have kept the message.
  enum AckOutcome: Equatable { case taken, notTaken, lost }

  /// Hands a message to the page now and reports what it answered. No queueing: `.notTaken` means nothing was handed over
  /// or the page said no, so the caller keeps the owner's text. A page that isn't ready, or a message the page's own rules
  /// refuse (not signed in), is `.notTaken`. The page is asked through `receiveAck` when it has it: that answers with a promise
  /// that settles when the work is done (a message is signed and stored), and `callAsyncJavaScript` waits for it. An older page
  /// has only `receive`, a plain boolean. A page that goes away before it answers (a new document, a crash, the watchdog
  /// replacing the view) ends the wait as `.lost`, once.
  func sendAcknowledged(_ m: NativeToWeb, completion: @escaping @MainActor (AckOutcome) -> Void) {
    guard pageReady, let wv = webView, let js = m.acknowledgedJavascript() else { return completion(.notTaken) }
    let id = UUID()
    pendingAcks[id] = completion
    wv.callAsyncJavaScript(js, arguments: [:], in: nil, in: .page) { [weak self] outcome in
      let answer = Self.ackOutcome(outcome)
      Task { @MainActor in self?.finishAck(id, answer) }
    }
  }

  /// What a script's answer means. `as? Bool` also accepts the number 1; only a real JavaScript `true` is the page saying it took
  /// the message. An error from WebKit that says the page is gone is `lost` (the message may have been saved), any other is not
  /// taken. The controller also ends pending acks as `lost` when it learns the page went away (`failPendingAcks`); this is the
  /// other route, for an error WebKit raises on the script itself. Without it that error would read as `notTaken`.
  nonisolated static func ackOutcome(_ outcome: Result<Any, Error>) -> AckOutcome {
    switch outcome {
    case .success(let result):
      if let n = result as? NSNumber, CFGetTypeID(n) == CFBooleanGetTypeID(), n.boolValue { return .taken }
      return .notTaken
    case .failure(let error):
      return pageWentAway(error) ? .lost : .notTaken
    }
  }

  /// WebKit's own errors for a script that can never answer because its page is gone.
  private nonisolated static func pageWentAway(_ error: Error) -> Bool {
    let e = error as NSError
    guard e.domain == WKError.errorDomain else { return false }
    return [WKError.Code.webContentProcessTerminated.rawValue, WKError.Code.webViewInvalidated.rawValue].contains(e.code)
  }

  private var pendingAcks: [UUID: @MainActor (AckOutcome) -> Void] = [:]

  private func finishAck(_ id: UUID, _ answer: AckOutcome) {
    pendingAcks.removeValue(forKey: id)?(answer)
  }

  private func failPendingAcks() {
    let all = pendingAcks
    pendingAcks = [:]
    for done in all.values { done(.lost) }
  }

  /// Tests: every message handed to the page, as the page would receive it.
  var deliveredForTest: ((NativeToWeb) -> Void)?

  /// False when nothing was handed over: the message fails the page's own rules, or there is no page.
  @discardableResult
  func deliver(_ m: NativeToWeb) -> Bool {
    guard let js = m.javascript(), let wv = webView else { return false }
    deliveredForTest?(m)
    wv.evaluateJavaScript(js, completionHandler: nil)  // main frame only: a frame never sees talosNative
    return true
  }

  // MARK: page -> native

  func nativeMessage(_ m: WebToNative) {
    testHook?(m)
    switch m {
    case .ready(let signedIn, let features):
      pageFeatures = features
      pageReady = true
      setSignedIn(signedIn)  // also lays the terminal out: `signedIn` is set on every ready
      if terminalRect != nil { startTerminalSessions() }
      let pending = queued
      queued = []
      for q in pending { deliver(q) }
      pushNotifyPermission()
      if companionReplies { deliver(.companionReplies(on: true, shown: [], epoch: companionRepliesEpoch)) }  // a reloaded page starts at off: tell it again
    case .badge(let n): needsYou = n
    case .threads(let t): threads = t
    case .openExternal(let u): routeExternal(u)
    case .notify(let title, let body, let navigate, let tag):
      if window?.isKeyWindow != true { onNotify?(title, body, navigate, tag) }
    case .haptic, .pairStatus: break
    case .companionState(let f):
      // Only a signed-in page that advertised `companion/1` feeds the pet; anything else is ignored. `pageFeatures` is empty
      // until the page's `ready` and again as soon as a new document commits, so this also drops a frame that arrives
      // before `ready` or from the document that was just replaced.
      guard signedIn, pageFeatures.contains("companion/1") else { break }
      if companionGate.accept(f, at: .now) { onCompanionFeed?(f) }
      armCompanionStale()
    case .companionInvalid: companionGone()
    case .companionReply(let r):
      if let outcome = replyTracker.accept(r) { completeReply(outcome) }  // not the current request: dropped
    case .terminalView(let r, let session):
      terminalRect = r
      terminal.select(session)
      // A null room is "no terminal to show now" (a panel stands there, or a dialog is open): the screen is still open and its
      // list must keep following the sessions. Only `terminal_leave` stops the timer.
      startTerminalSessions()
      applyTerminal()
    case .terminalLeave: pauseTerminalSessions()
    case .terminalResume(let id): terminalResume(id)
    case .pickFolder(let req, let start): pickFolder(req: req, start: start)
    }
  }

  // MARK: companion feed

  /// Drops the feed, the stale timer and any reply request in flight. Safe to call at any time.
  func companionGone() {
    staleTimer?.invalidate()
    staleTimer = nil
    if companionGate.clear() { onCompanionFeed?(nil) }
    if replyTracker.cancel() != nil { completeReply(.unavailable) }
  }

  /// One timer, re-armed by each frame: the feed goes after 90 s of silence. `at` is a test seam.
  private func armCompanionStale() {
    staleTimer?.invalidate()
    staleTimer = nil
    guard let left = companionGate.untilStale(at: .now) else { return }
    let seconds = Double(left.components.seconds) + Double(left.components.attoseconds) / 1e18
    staleTimer = Timer.scheduledTimer(withTimeInterval: max(0.05, seconds), repeats: false) { [weak self] _ in
      Task { @MainActor in self?.checkCompanionStale() }
    }
  }

  /// Tests: a shorter silence limit, so the real timer path runs in a second instead of 90.
  func useCompanionStaleLimitForTest(_ limit: Duration) { companionGate = CompanionFeedGate(limit: limit) }

  func checkCompanionStale(at now: ContinuousClock.Instant = .now) {
    if companionGate.expireIfStale(at: now) {
      staleTimer?.invalidate()
      staleTimer = nil
      onCompanionFeed?(nil)
    } else {
      armCompanionStale()
    }
  }

  /// Asks the page for the newest agent reply in a thread, as plain text. Called on a click only. The outcome comes once:
  /// the text, nothing to show, no answer in 3 s, the page can't be asked (not ready, not signed in, no `companion/1`,
  /// refused, or it went away), or a newer click replaced this one.
  func requestLastReply(thread: String, completion: @escaping @MainActor (LastReplyTracker.Outcome) -> Void) {
    // A thread id the page would refuse never leaves: `NativeToWeb.validated` makes no script for it, so `sendAcknowledged`
    // answers false and the request ends as unavailable.
    guard pageReady, signedIn, pageFeatures.contains("companion/1") else { return completion(.unavailable) }
    let (req, old) = replyTracker.begin(thread: thread)
    if old != nil { completeReply(.superseded) }
    replyDone = completion
    sendAcknowledged(.companionReplyRequest(req: req, threadId: thread)) { [weak self] ack in
      if ack != .taken { self?.finishReply(req: req, .unavailable) }
    }
    Task { @MainActor [weak self] in
      try? await Task.sleep(for: LastReplyTracker.timeout)
      self?.finishReply(req: req, .timedOut)
    }
  }

  /// The reply card closed: nobody is waiting for this answer any more.
  func cancelLastReply() {
    if replyTracker.cancel() != nil { completeReply(.superseded) }
  }

  private func finishReply(req: String, _ outcome: LastReplyTracker.Outcome) {
    if replyTracker.expire(req: req) { completeReply(outcome) }
  }

  private func completeReply(_ outcome: LastReplyTracker.Outcome) {
    let done = replyDone
    replyDone = nil
    done?(outcome)
  }

  private func setSignedIn(_ v: Bool) {
    signedIn = v
    // Signed in: keep the app out of idle App Nap so the socket and notifications stay live.
    if v, activity == nil {
      activity = ProcessInfo.processInfo.beginActivity(options: [.userInitiatedAllowingIdleSystemSleep], reason: "Talos is signed in")
    } else if !v, let a = activity {
      ProcessInfo.processInfo.endActivity(a)
      activity = nil
    }
  }

  // MARK: navigation policy

  func webView(
    _ webView: WKWebView, decidePolicyFor navigationAction: WKNavigationAction,
    decisionHandler: @escaping @MainActor @Sendable (WKNavigationActionPolicy) -> Void
  ) {
    guard let relay, let url = navigationAction.request.url else { return decisionHandler(.cancel) }
    let main = navigationAction.targetFrame?.isMainFrame ?? true
    let d = main ? WebPolicy.decide(url, relay: relay) : WebPolicy.decideSubframe(url, relay: relay)
    switch d {
    case .allow: decisionHandler(.allow)
    case .openExternally(let u):
      routeExternal(u)
      decisionHandler(.cancel)
    case .deny: decisionHandler(.cancel)
    }
  }

  /// A relay that is down still answers through its host's edge (Railway: 502/503), and WebKit commits that error page as a
  /// normal load, so no failure was ever reported and the window sat on "Connecting" (audit D46). A main-frame 5xx is a
  /// failed load: cancel it and take the same retry path as a refused connection.
  func webView(
    _ webView: WKWebView, decidePolicyFor navigationResponse: WKNavigationResponse,
    decisionHandler: @escaping @MainActor @Sendable (WKNavigationResponsePolicy) -> Void
  ) {
    if navigationResponse.isForMainFrame, PageState.isServerDown(status: (navigationResponse.response as? HTTPURLResponse)?.statusCode) {
      noteServerDown()
      return decisionHandler(.cancel)
    }
    decisionHandler(.allow)
  }

  private func noteServerDown() {
    loadFailed = true
    let delay = Self.retryDelays[min(retryAttempt, Self.retryDelays.count - 1)]
    retryAttempt += 1
    scheduleRetry(after: delay)
  }

  /// A new document has not said `ready` yet. Cleared only once the new document commits: a navigation that never commits
  /// (a 204, a dropped connection) leaves the old page up and ready, and must not strand the next message.
  func webView(_ webView: WKWebView, didCommit navigation: WKNavigation!) {
    pageReady = false
    loadFailed = false
    retryAttempt = 0
    retryTimer?.invalidate()
  }

  func webView(_ webView: WKWebView, didFinish navigation: WKNavigation!) {
    loadFailed = false
    retryAttempt = 0
  }

  func webView(_ webView: WKWebView, didFailProvisionalNavigation navigation: WKNavigation!, withError error: Error) {
    noteLoadFailure(error)
  }

  func webView(_ webView: WKWebView, didFail navigation: WKNavigation!, withError error: Error) {
    noteLoadFailure(error)
  }

  /// WebKit reloads a crashed page only while the view is visible; a hidden window would stay blank until someone opened it.
  func webViewWebContentProcessDidTerminate(_ webView: WKWebView) {
    pageReady = false
    loadFailed = true
    scheduleRetry(after: 1)
  }

  private func noteLoadFailure(_ error: Error) {
    let e = error as NSError
    if e.code == NSURLErrorCancelled { return }  // our own policy cancelled it (an external link), not a failure
    if e.domain == "WebKitErrorDomain", e.code == 102 { return }  // frame load interrupted by a policy change
    loadFailed = true
    let delay = Self.retryDelays[min(retryAttempt, Self.retryDelays.count - 1)]
    retryAttempt += 1
    scheduleRetry(after: delay)
  }

  private func scheduleRetry(after delay: TimeInterval) {
    retryTimer?.invalidate()
    retryTimer = Timer.scheduledTimer(withTimeInterval: delay, repeats: false) { [weak self] _ in
      Task { @MainActor in self?.reload() }
    }
  }

  private func reload() {
    guard let relay, let wv = webView else { return }
    retryTimer?.invalidate()
    wv.load(URLRequest(url: relay.url))
  }

  /// target=_blank / window.open: never a new web view; the link goes through the same policy, in the browser.
  func webView(
    _ webView: WKWebView, createWebViewWith configuration: WKWebViewConfiguration,
    for navigationAction: WKNavigationAction, windowFeatures: WKWindowFeatures
  ) -> WKWebView? {
    if let relay, let url = navigationAction.request.url {
      switch WebPolicy.decide(url, relay: relay) {
      case .allow: webView.load(navigationAction.request)
      case .openExternally(let u): routeExternal(u)
      case .deny: break
      }
    }
    return nil
  }

  /// The microphone for the relay's own page only (dictation, voice notes, live calls); never the camera, an iframe, an
  /// agent page or another origin (WebPolicy.grantsMedia). Until 2026-11-03 every request was refused (DESKTOP-SPEC 5.1).
  func webView(
    _ webView: WKWebView, requestMediaCapturePermissionFor origin: WKSecurityOrigin, initiatedByFrame frame: WKFrameInfo,
    type: WKMediaCaptureType, decisionHandler: @escaping @MainActor @Sendable (WKPermissionDecision) -> Void
  ) {
    let kind: WebPolicy.MediaKind
    switch type {
    case .microphone: kind = .microphone
    case .camera: kind = .camera
    default: kind = .cameraAndMicrophone
    }
    let path = webView.url.flatMap { URLComponents(url: $0, resolvingAgainstBaseURL: false)?.percentEncodedPath }
    let sender = WebPolicy.Sender(
      isMainFrame: frame.isMainFrame, scheme: origin.protocol, host: origin.host,
      port: origin.port == 0 ? nil : origin.port, mainFramePath: path)
    guard let relay else { return decisionHandler(.deny) }  // the same relay navigation uses: none means no microphone
    decisionHandler(WebPolicy.grantsMedia(kind, sender: sender, mainFrameURL: webView.url, relay: relay) ? .grant : .deny)
  }

  /// File attachments in the composer.
  func webView(
    _ webView: WKWebView, runOpenPanelWith parameters: WKOpenPanelParameters, initiatedByFrame frame: WKFrameInfo,
    completionHandler: @escaping @MainActor @Sendable ([URL]?) -> Void
  ) {
    let p = NSOpenPanel()
    p.allowsMultipleSelection = parameters.allowsMultipleSelection
    p.canChooseDirectories = parameters.allowsDirectories
    p.begin { r in completionHandler(r == .OK ? p.urls : nil) }
  }

  func webView(
    _ webView: WKWebView, runJavaScriptConfirmPanelWithMessage message: String, initiatedByFrame frame: WKFrameInfo,
    completionHandler: @escaping @MainActor @Sendable (Bool) -> Void
  ) {
    let a = NSAlert()
    a.messageText = String(message.prefix(500))
    a.addButton(withTitle: "OK")
    a.addButton(withTitle: "Cancel")
    completionHandler(a.runModal() == .alertFirstButtonReturn)
  }

  func webView(
    _ webView: WKWebView, runJavaScriptAlertPanelWithMessage message: String, initiatedByFrame frame: WKFrameInfo,
    completionHandler: @escaping @MainActor @Sendable () -> Void
  ) {
    let a = NSAlert()
    a.messageText = String(message.prefix(500))
    a.runModal()
    completionHandler()
  }

  // MARK: sign out / forget

  /// Sign out keeps the device key (IndexedDB): the next sign-in needs a new setup code but no re-pair (5.2 step 5).
  func signOut() async {
    guard let relay, let wv = webView else { return }
    // The terminal goes first: it sits over the page, and nothing of the session may stay on screen while the logout runs.
    // Signed out at once as well, or a `terminal_view` the page sends during the logout would open it again.
    terminalRect = nil
    setSignedIn(false)
    // End the session on the relay first (through the page, which carries the cookie and the CSRF rules), so the session
    // row doesn't live on until its TTL and an in-flight response can't put the cookie back; the local delete is the fallback.
    let logout = "try { await fetch('/api/auth/logout', { method: 'POST', credentials: 'include', headers: { 'content-type': 'application/json', 'x-talos-csrf': '1' }, body: '{}' }) } catch (e) {} return true"
    _ = try? await wv.callAsyncJavaScript(logout, contentWorld: .page)
    let store = wv.configuration.websiteDataStore
    let cookies = await store.httpCookieStore.allCookies()
    for c in cookies where Self.cookie(c, belongsTo: relay) { await store.httpCookieStore.deleteCookie(c) }
    setSignedIn(false)
    wv.load(URLRequest(url: relay.url))
  }

  /// The device id this web view signed in as, from the relay's own `/api/me` (the same-origin page already holds the
  /// cookie). nil when signed out or the page can't say.
  func thisDeviceId() async -> String? {
    guard let wv = webView else { return nil }
    let js = "try { const r = await fetch('/api/me', { credentials: 'include' }); if (!r.ok) return null; const j = await r.json(); return typeof j.device_id === 'string' ? j.device_id : null } catch (e) { return null }"
    guard let id = (try? await wv.callAsyncJavaScript(js, contentWorld: .page)) as? String, DevicesList.isDeviceId(id) else { return nil }
    return id
  }

  /// Wipes every kind of site data for the relay host, cookies and IndexedDB included.
  func wipeSiteData() async {
    guard let relay, let wv = webView else { return }
    let store = wv.configuration.websiteDataStore
    let types = WKWebsiteDataStore.allWebsiteDataTypes()
    let records = await store.dataRecords(ofTypes: types)
    let mine = records.filter { r in
      let d = r.displayName.lowercased()
      return d == relay.host || relay.host.hasSuffix("." + d) || d.hasSuffix("." + relay.host)
    }
    await store.removeData(ofTypes: types, for: mine)
    setSignedIn(false)
    wv.load(URLRequest(url: relay.url))
  }

  static func cookie(_ c: HTTPCookie, belongsTo relay: RelayOrigin) -> Bool {
    let d = c.domain.hasPrefix(".") ? String(c.domain.dropFirst()) : c.domain
    return d.lowercased() == relay.host
  }
}

extension WebController {
  /// "Forget this Mac" (DESKTOP-SPEC 5.2 step 5): revoke the device THIS window signed in as, by its id, with the Mac's own
  /// CLI, then wipe the relay's site data (cookies, IndexedDB, the device key). The name "Mac app" is device-supplied text
  /// and several devices can share it (a dev build beside the installed app), so it is never the key; if the page can't
  /// say which device it is, the owner is asked before every pinned "Mac app" is revoked. The wipe happens only after the
  /// revoke worked, and the result says what really happened.
  func forgetThisMac(config: DesktopConfig) {
    let a = NSAlert()
    a.messageText = "Forget this Mac?"
    a.informativeText = "This revokes this window's device and deletes its sign-in and device key. You will need a new setup code to sign in again."
    a.addButton(withTitle: "Forget this Mac")
    a.addButton(withTitle: "Cancel")
    guard a.runModal() == .alertFirstButtonReturn else { return }
    Task {
      let id = await self.thisDeviceId()
      let outcome = await Task.detached { Self.revoke(config: config, id: id) }.value
      var note = outcome.note
      var wipe = outcome.ok
      if outcome.kind == .needsName {
        let ask = NSAlert()
        ask.messageText = "Couldn't tell which device this window is"
        ask.informativeText = "Revoke every pinned \"Mac app\" device on this Mac? (Another Mac app on this Mac would need a new setup code too.)"
        ask.addButton(withTitle: "Revoke them all")
        ask.addButton(withTitle: "Cancel")
        if ask.runModal() == .alertFirstButtonReturn {
          let byName = await Task.detached { Self.revokeByName(config: config) }.value
          note = byName.note
          wipe = byName.ok
        } else {
          note = "Nothing was revoked and nothing was deleted."
          wipe = false
        }
      }
      if wipe { await self.wipeSiteData() }
      let done = NSAlert()
      done.messageText = wipe ? "Forgot this Mac" : "Didn't forget this Mac"
      done.informativeText = note
      done.runModal()
    }
  }

  struct RevokeOutcome: Sendable {
    enum Kind: Sendable { case revoked, needsName, failed }
    var kind: Kind
    var note: String
    var ok: Bool { kind == .revoked }
  }

  nonisolated static func revoke(config: DesktopConfig, id: String?) -> RevokeOutcome {
    guard let r = TalosAppCLI.resolve(config: config) else {
      return RevokeOutcome(kind: .failed, note: "Couldn't run talos-app, so nothing was revoked and nothing was deleted.")
    }
    guard let id else { return RevokeOutcome(kind: .needsName, note: "") }
    guard let out = TalosAppCLI.run(r, ["devices", "revoke", id]) else {
      return RevokeOutcome(kind: .failed, note: "talos-app didn't answer, so nothing was deleted. Try again.")
    }
    if out.status == 0 { return RevokeOutcome(kind: .revoked, note: "Revoked this device.") }
    let why = out.text.trimmingCharacters(in: .whitespacesAndNewlines).prefix(200)
    return RevokeOutcome(kind: .failed, note: "Revoking failed (\(why)). Nothing was deleted; run it again.")
  }

  nonisolated static func revokeByName(config: DesktopConfig) -> RevokeOutcome {
    guard let r = TalosAppCLI.resolve(config: config), let list = TalosAppCLI.run(r, ["devices"]) else {
      return RevokeOutcome(kind: .failed, note: "Couldn't run talos-app, so nothing was revoked and nothing was deleted.")
    }
    if list.status != 0 {
      let why = list.text.trimmingCharacters(in: .whitespacesAndNewlines).prefix(160)
      return RevokeOutcome(kind: .failed, note: "talos-app couldn't read the device list (\(why)). Nothing was deleted.")
    }
    let ids = DevicesList.macAppIds(DevicesList.parse(list.text))
    if ids.isEmpty { return RevokeOutcome(kind: .failed, note: "No pinned \"Mac app\" device was found, so nothing was deleted.") }
    var failed = 0
    for id in ids where TalosAppCLI.run(r, ["devices", "revoke", id])?.status != 0 { failed += 1 }
    return failed == 0
      ? RevokeOutcome(kind: .revoked, note: "Revoked \(ids.count) device(s).")
      : RevokeOutcome(kind: .failed, note: "\(failed) revoke(s) failed; nothing was deleted. Run them again.")
  }
}


extension WebController: WKDownloadDelegate {
  func download(
    _ download: WKDownload, decideDestinationUsing response: URLResponse, suggestedFilename: String,
    completionHandler: @escaping @MainActor @Sendable (URL?) -> Void
  ) {
    let id = ObjectIdentifier(download)
    switch DownloadRules.verdict(status: (response as? HTTPURLResponse)?.statusCode, suggestedFilename: suggestedFilename) {
    case .fail(let why):
      downloadDeclined.insert(id)
      downloadProblem(why)
      completionHandler(nil)
    case .save(let name):
      chooseDestination(name) { [weak self] url in
        guard let self else { return completionHandler(nil) }
        guard let url else {
          self.downloadDeclined.insert(id)  // the owner pressed Cancel: not an error
          return completionHandler(nil)
        }
        // Download beside the target and swap it in when the bytes are all there: the old file survives a dropped download.
        // (The save panel already asked about replacing it.)
        let part = url.deletingLastPathComponent().appendingPathComponent(".talos-\(UUID().uuidString.prefix(8)).part")
        self.downloadTargets[id] = (part, url)
        completionHandler(part)
      }
    }
  }

  func downloadDidFinish(_ download: WKDownload) {
    let id = ObjectIdentifier(download)
    guard let t = downloadTargets.removeValue(forKey: id) else { return }
    do {
      if FileManager.default.fileExists(atPath: t.final.path) {
        _ = try FileManager.default.replaceItemAt(t.final, withItemAt: t.part)
      } else {
        try FileManager.default.moveItem(at: t.part, to: t.final)
      }
      downloadSaved(t.final)
    } catch {
      try? FileManager.default.removeItem(at: t.part)
      downloadProblem("Talos couldn't put the file in place (\(error.localizedDescription)). Try again.")
    }
  }

  func download(_ download: WKDownload, didFailWithError error: Error, resumeData: Data?) {
    let id = ObjectIdentifier(download)
    if let t = downloadTargets.removeValue(forKey: id) { try? FileManager.default.removeItem(at: t.part) }
    if downloadDeclined.remove(id) != nil { return }  // already said, or the owner's Cancel
    if (error as NSError).code == NSURLErrorCancelled { return }
    downloadProblem("Talos couldn't finish saving it (\(error.localizedDescription)). Try again.")
  }
}
