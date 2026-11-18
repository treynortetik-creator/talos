import BridgeGuard
import Capacitor
import Network
import SafariServices
import TalosRelayCore
import UIKit
import WebKit

/// The shell's only view controller. It locks the native bridge to the relay origin (IOS-SPEC rev 2, item I14):
///  1. Capacitor's "bridge" WKScriptMessageHandler is wrapped, so plugin calls are dropped unless they come from the
///     top frame, on the relay origin, at a path outside /media/.
///  2. Anything that is not a relay page leaves this web view: other hosts go to SFSafariViewController, relay /media/
///     pages (agent-written HTML, "Open in new tab", downloads) go to a bridge-less in-app viewer that shares the
///     session cookie. Capacitor's prompt() cookie channel and the camera/mic grant are limited to the trusted frame.
/// The relay origin is the active `RelayProfile` (RelayRuntime), saved only by the native scan. A DEBUG build with no profile may
/// use the build-time `server.url` instead; a release build with none shows the native first-run screen and loads no page. It is
/// never read from page content.
final class TalosBridgeViewController: CAPBridgeViewController {
    private var navigationGate: NavigationGate?
    private var keyboardHideObserver: NSObjectProtocol?
    private var foregroundObserver: NSObjectProtocol?
    private var leavingObservers: [NSObjectProtocol] = []
    private var guardian: BridgeGuard?
    private var relayURL: URL?
    /// The active relay, its guard and the shared trust object, made once when the web view is built. nil while nothing is paired.
    private(set) var relayContext: RelayContext?
    /// Where the active relay is read from. Only a DEBUG build (the tests) can replace it; a release build always uses the Keychain list.
    #if DEBUG
    static var runtime: @MainActor () -> RelayRuntime = { .live }
    #else
    static let runtime: @MainActor () -> RelayRuntime = { .live }
    #endif
    /// The bridge and share handlers this controller installed, kept so a test can see they hold the context's trust object.
    private(set) var guardedMessageHandler: GuardedMessageHandler?
    private(set) var shareMessageHandler: ShareMediaMessageHandler?
    /// Loaded once instead of the start page: `<origin>/enroll#<code>` after a scan, so the page continues pairing. Set by the scene
    /// before the view loads and kept in memory only.
    var firstPage: URL?
    private var firstRunView: FirstRunView?
    private var pathMonitor: NWPathMonitor?
    private var launchWatchdog: Timer?
    private var revival: WebViewRevival?
    private var launchStarted = Date()
    private var shareInFlight = false
    private var relayPageFinished = false
    private var relayPageCommitted = false
    /// True once the offline page is what the web view shows. Network-return and foreground retries act only then, so the
    /// initial launch load is never restarted by the notifications that fire at launch.
    private var showingFallback = false
    /// Native launch spinner (audit D49): shown from launch until the first page finishes, so the owner never sees a
    /// blank view while the relay answers.
    private let launchSpinner = UIActivityIndicatorView(style: .large)
    /// "Reconnecting…" over the web view while the page is being brought back (its web process died, froze or came back
    /// empty), so the owner never looks at a bare black view with nothing to tap. Up while either flag below is set.
    private let reconnectNotice = ReconnectNoticeView()
    /// A resume check has been waiting on the page for longer than `WebViewRevival.noticeDelay`.
    private var revivalWaiting = false
    /// A load that brings a lost page back is running: from the load to the next page that finishes (relay or offline).
    private var recovering = false
    /// Set by the scene before the view loads when this controller replaces one whose web process was stuck: the notice is up
    /// from the first frame until the first page finishes.
    var startsReconnecting = false
    /// True once any page (relay or offline) has finished in this web view.
    private var hasShownAPage = false
    /// The launch watchdog was running when the app left the screen (see `pauseLaunchWatchdog`).
    private var watchdogPaused = false

    deinit { stopWatching() }

    /// Observers, the network monitor and the launch timer. Also run when this controller is replaced, so a stale one cannot act.
    private func stopWatching() {
        if let keyboardHideObserver { NotificationCenter.default.removeObserver(keyboardHideObserver) }
        if let foregroundObserver { NotificationCenter.default.removeObserver(foregroundObserver) }
        keyboardHideObserver = nil
        foregroundObserver = nil
        leavingObservers.forEach(NotificationCenter.default.removeObserver)
        leavingObservers = []
        pathMonitor?.cancel()
        pathMonitor = nil
        launchWatchdog?.invalidate()
        launchWatchdog = nil
    }

    override func viewDidLoad() {
        super.viewDidLoad()
        // Same colour as the launch screen and the offline page, so launch -> app has no white flash.
        view.backgroundColor = UIColor(red: 0x14 / 255, green: 0x11 / 255, blue: 0x10 / 255, alpha: 1)
        launchSpinner.color = UIColor(red: 0xF3 / 255, green: 0xE6 / 255, blue: 0xCF / 255, alpha: 1)
        launchSpinner.translatesAutoresizingMaskIntoConstraints = false
        launchSpinner.hidesWhenStopped = true
        view.addSubview(launchSpinner)
        NSLayoutConstraint.activate([
            launchSpinner.centerXAnchor.constraint(equalTo: view.centerXAnchor),
            launchSpinner.centerYAnchor.constraint(equalTo: view.centerYAnchor, constant: 120),
        ])
        launchSpinner.startAnimating()
        reconnectNotice.frame = view.bounds
        reconnectNotice.autoresizingMask = [.flexibleWidth, .flexibleHeight]
        reconnectNotice.isHidden = true
        view.addSubview(reconnectNotice)
        if startsReconnecting {
            recovering = true
            updateReconnectNotice()
        }
        if relayContext == nil {
            showFirstRun()
        } else if let page = firstPage {
            firstPage = nil
            if guardian?.isRelayURL(page) == true { loadRelay(startingAt: page) }
        }
    }

    /// Shows or hides the notice from the two flags. VoiceOver is told when it appears.
    private func updateReconnectNotice() {
        let show = revivalWaiting || recovering
        guard show == reconnectNotice.isHidden else { return }
        reconnectNotice.isHidden = !show
        if show {
            view.bringSubviewToFront(reconnectNotice)
            reconnectNotice.start()
            UIAccessibility.post(notification: .announcement, argument: ReconnectNoticeView.text)
        } else {
            reconnectNotice.stop()
        }
    }

    /// For tests: whether the notice is on screen.
    var isShowingReconnectNotice: Bool { !reconnectNotice.isHidden }

    /// ` TalosIOS/<marketing version>+<build number>`, appended to the web view's user agent (audit D62), the way the Mac app
    /// appends `TalosDesktop/<version>`. The page reads it for "Copy diagnostics". Anything outside `[A-Za-z0-9.-]` is
    /// dropped and a missing value becomes "0", so the token can never break the page's parser.
    static func userAgentSuffix(info: [String: Any]? = Bundle.main.infoDictionary) -> String {
        func clean(_ v: Any?) -> String {
            let kept = String((v as? String ?? "").unicodeScalars.filter {
                CharacterSet(charactersIn: "abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789.-").contains($0)
            }.prefix(20))
            return kept.isEmpty ? "0" : kept
        }
        return "TalosIOS/\(clean(info?["CFBundleShortVersionString"]))+\(clean(info?["CFBundleVersion"]))"
    }

    /// The start URL, the navigation allow-list and the offline page come from the active relay, not from capacitor.config.json. With
    /// no usable relay there is no server URL, so no relay page can load. A web view that is built after a relay is saved is built
    /// by a new controller, so this runs once per relay.
    override func instanceDescriptor() -> InstanceDescriptor {
        let descriptor = super.instanceDescriptor()
        let runtime = TalosBridgeViewController.runtime()
        let context = RelayContext(active: runtime.active(buildTimeURL: descriptor.serverURL.flatMap(URL.init(string:))))
        relayContext = context
        if let active = context?.active {
            if active.profile != nil {
                descriptor.serverURL = active.origin.absoluteString
                descriptor.allowedNavigationHostnames = [ActiveRelay.navigationHost(of: active.origin)]
                descriptor.errorPath = "offline.html"
            }
        } else {
            // Nothing is paired: no server URL, and the web view is pointed at an empty folder, so not even the bundled page loads.
            descriptor.serverURL = nil
            descriptor.appLocation = TalosBridgeViewController.emptyAppFolder()
        }
        // Stores no relay owns (a removed or replaced relay) go now, before this web view is built. A store a web view still holds
        // is kept and tried again later and at the next launch. The old shared store goes once, the first time a paired relay is
        // active in a release build.
        let clearsDefault = context?.active.profile != nil && !runtime.allowBuildTime
        Task { @MainActor in
            if clearsDefault { await runtime.clearDefaultStoreOnce() }
            for _ in 0..<3 where await runtime.sweepOrphans() > 0 { try? await Task.sleep(nanoseconds: 3_000_000_000) }
        }
        return descriptor
    }

    /// A folder with nothing in it, so the web view of a controller with no relay has no page to load.
    private static func emptyAppFolder() -> URL {
        let url = FileManager.default.temporaryDirectory.appendingPathComponent("talos-no-relay", isDirectory: true)
        try? FileManager.default.createDirectory(at: url, withIntermediateDirectories: true)
        return url
    }

    /// Capacitor builds the web view from this configuration, so the suffix is in place before the first request.
    override func webViewConfiguration(for instanceConfiguration: InstanceConfiguration) -> WKWebViewConfiguration {
        let configuration = super.webViewConfiguration(for: instanceConfiguration)
        // One data store per relay: cookies and storage never cross relays. The build-time fallback keeps the default store.
        if let id = relayContext?.active.dataStoreId { configuration.websiteDataStore = WKWebsiteDataStore(forIdentifier: id) }
        let suffix = TalosBridgeViewController.userAgentSuffix()
        if let existing = configuration.applicationNameForUserAgent, !existing.isEmpty {
            configuration.applicationNameForUserAgent = "\(existing) \(suffix)"
        } else {
            configuration.applicationNameForUserAgent = suffix
        }
        return configuration
    }

    override func capacitorDidLoad() {
        super.capacitorDidLoad()
        // The app's own plugins. Registered before the guard below so a missing origin still leaves them gated
        // (TalosPluginGate refuses when there is no active relay).
        bridge?.registerPluginInstance(TalosAudioPlugin())
        bridge?.registerPluginInstance(TalosSharePlugin())
        bridge?.registerPluginInstance(TalosPushPlugin())
        bridge?.registerPluginInstance(TalosCrashPlugin())
        bridge?.registerPluginInstance(TalosSnapshotPlugin())
        bridge?.registerPluginInstance(TalosPickerPlugin())
        bridge?.registerPluginInstance(TalosRelayPlugin())
        #if DEBUG
        // Test hook (no camera in the simulator): a launch argument opens the Add relay sheet once and feeds it a link.
        if DebugAddRelay.link != nil, !DebugAddRelay.opened {
            DebugAddRelay.opened = true
            DispatchQueue.main.asyncAfter(deadline: .now() + 2) { [weak self] in
                if let host = self { AddRelayViewController.present(from: host) }
            }
        }
        #endif
        // The stock Keyboard plugin (resize: native) shrinks the web view to what the keyboard leaves. If a hide
        // notification ever arrives with the frame left short (upstream #12, #23), put it back to the window. Never
        // reproduced here; this only restores a frame that is already wrong. Done before the origin guard.
        keyboardHideObserver = NotificationCenter.default.addObserver(
            forName: UIResponder.keyboardDidHideNotification, object: nil, queue: .main
        ) { [weak self] _ in
            guard let web = self?.webView, let bounds = web.window?.bounds, web.frame != bounds else { return }
            web.frame = bounds
        }
        guard let bridge = bridge as? CapacitorBridge, let webView = webView else { return }
        guard let context = relayContext else {
            // No relay is paired: leave the bridge closed. The web view points at an empty folder (instanceDescriptor), and viewDidLoad
            // puts the native scan screen over it.
            bridge.webViewDelegationHandler.contentController.removeScriptMessageHandler(forName: "bridge")
            webView.stopLoading()
            return
        }
        let guardian = context.guardian
        let trust = context.trust

        // 1. Wrap the bridge message handler.
        let handler = bridge.webViewDelegationHandler
        handler.contentController.removeScriptMessageHandler(forName: "bridge")
        let guarded = GuardedMessageHandler(inner: handler, guardian: guardian, trust: trust)
        guardedMessageHandler = guarded
        handler.contentController.add(guarded, name: "bridge")

        // 1b. The page's "share this attachment" message. A separate handler (not a Capacitor plugin call) so the only thing
        //     it can ever do is fetch one relay /media/<id> file and open the system share sheet.
        handler.contentController.removeScriptMessageHandler(forName: ShareMediaMessageHandler.name)
        let share = ShareMediaMessageHandler(guardian: guardian, trust: trust) { [weak self] url, name in self?.shareMedia(url, name: name) }
        shareMessageHandler = share
        handler.contentController.add(share, name: ShareMediaMessageHandler.name)

        // 2. Route navigations, popups, prompts and permissions. WKWebView holds its delegates weakly, so the gate
        //    lives on self.
        let gate = NavigationGate(
            inner: handler, guardian: guardian, trust: trust,
            openInSafari: { [weak self] url in self?.openInSafari(url) },
            showMedia: { [weak self] url in self?.showMedia(url, guardian: guardian) },
            pageDidReset: {
                TalosAudioPlugin.resetSession()
                TalosPushCenter.shared.pageLeft()
            },
            retry: { [weak self] in self?.retryIfNeeded(tapped: true) },
            processDied: { [weak self] in self?.webProcessDied() },
            didCommit: { [weak self] in self?.pageDidCommit() },
            didFinish: { [weak self] in self?.pageDidFinish() }
        )
        navigationGate = gate
        webView.navigationDelegate = gate
        webView.uiDelegate = gate
        self.guardian = guardian
        relayURL = context.active.origin
        revival = WebViewRevival(
            hasPage: { [weak webView] in webView?.url != nil },
            isBusy: { [weak self] in
                guard let self, let web = self.webView else { return true }
                return web.isLoading || self.showingFallback
            },
            isActive: { UIApplication.shared.applicationState == .active },
            ping: { [weak webView] timeout, done in
                guard let webView else { return done(.answered) }
                WebViewRevival.ping(webView, timeout: timeout, done)
            },
            hop: { DispatchQueue.main.async(execute: $0) },
            after: { delay, run in DispatchQueue.main.asyncAfter(deadline: .now() + delay, execute: run) },
            waiting: { [weak self] waiting in
                guard let self else { return }
                // Before the first page of this web view the launch spinner is already up: a slow first answer is a launch.
                self.revivalWaiting = waiting && self.hasShownAPage
                self.updateReconnectNotice()
            },
            reload: { [weak self] in self?.loadRelay(keepingRoute: true, recovering: true) },
            rebuild: { [weak self] in self?.rebuildWebView() })
        startRetryTriggers()
        startLaunchWatchdog()
    }

    // MARK: First run

    /// Nothing is paired: the web view stays empty under a native screen whose button opens the Add-relay sheet. The origin is
    /// set only by the scan inside that sheet. (This controller's view is the web view, so the screen is a subview of it.)
    private func showFirstRun() {
        launchSpinner.stopAnimating()
        let screen = FirstRunView { [weak self] in
            guard let self, self.presentedViewController == nil else { return }
            AddRelayViewController.present(from: self)
        }
        screen.frame = view.bounds
        screen.autoresizingMask = [.flexibleWidth, .flexibleHeight]
        view.addSubview(screen)
        firstRunView = screen
    }

    /// For tests: whether the native first-run screen is up.
    var isShowingFirstRun: Bool { firstRunView?.superview != nil && firstRunView?.isHidden == false }

    // MARK: Retry and launch fallback (audit D3, D49)

    /// Reload the relay when the web view is not showing a relay page: offline page, blank view, nothing loaded.
    /// Tap (talos-retry link), network return and app foreground all land here.
    private func retryIfNeeded(tapped: Bool = false) {
        guard let guardian, let webView, tapped || showingFallback,
              guardian.needsRetry(currentURL: webView.url) else { return }
        loadRelay()
    }

    /// Loads the start URL (the one Capacitor loaded at launch) and starts the launch watchdog again. `keepingRoute`: a page
    /// that is on a relay page (not /media/) is loaded where it was, so a process that died does not take the owner back to the start.
    /// `recovering`: the page was lost (not the owner's own retry), so "Reconnecting…" covers the view until a page finishes.
    private func loadRelay(keepingRoute: Bool = false, recovering: Bool = false, startingAt: URL? = nil) {
        guard let relayURL, let webView else { return }
        var target = startingAt ?? relayURL
        if keepingRoute, let current = webView.url, guardian?.isRelayURL(current) == true, !BridgeGuard.isMediaPath(current) {
            target = current
        }
        relayPageFinished = false
        relayPageCommitted = false
        showingFallback = false
        launchSpinner.startAnimating()
        if recovering {
            self.recovering = true
            updateReconnectNotice()
        }
        webView.load(URLRequest(url: target))
        startLaunchWatchdog()
    }

    /// The web process died (WebKit said so). Capacitor's own answer is a bare `reload()`: nothing watches it, no spinner shows,
    /// and with no URL left it does nothing, so a relay that is slow to answer left an empty view for as long as it took. The
    /// page is loaded through `loadRelay` instead (it replaces that reload): the notice is up, and the launch watchdog falls to
    /// the offline page, with its "Try again", if the relay does not answer.
    private func webProcessDied() {
        loadRelay(keepingRoute: true, recovering: true)
    }

    /// The web process does not answer, so a load would queue behind it: put a new controller (a new web view and web process)
    /// in the window. Only the controller that is on screen may do it, so a stale one cannot replace its successor.
    private func rebuildWebView() {
        guard let scene = view.window?.windowScene?.delegate as? SceneDelegate, scene.window?.rootViewController === self else { return }
        TalosAudioPlugin.resetSession()
        // A notification tap handed to this page a moment ago may never have been acted on: the new page gets it again.
        TalosPushCenter.shared.requeueRecentlyDelivered()
        scene.replaceBridgeViewController()
    }

    /// This controller is being replaced: stop everything that could still act for it and let go of its web view, so the old web
    /// view (and with it the stuck web process) is not kept alive by a message handler or a delegate.
    func retire() {
        stopWatching()
        guard let webView else { return }
        webView.stopLoading()
        webView.navigationDelegate = nil
        webView.uiDelegate = nil
        webView.configuration.userContentController.removeAllScriptMessageHandlers()
        webView.removeFromSuperview()
    }

    private func startRetryTriggers() {
        foregroundObserver = NotificationCenter.default.addObserver(
            forName: UIApplication.didBecomeActiveNotification, object: nil, queue: .main
        ) { [weak self] _ in
            MainActor.assumeIsolated {
                // The offline page or a blank view is retried first. The page is checked either way: a stuck web process cannot
                // hide behind a load that is running or the offline page.
                self?.resumeLaunchWatchdog()
                self?.retryIfNeeded()
                self?.revival?.appDidForeground()
            }
        }
        // Leaving the front voids a check that is still waiting for an answer. In the background the launch watchdog stops too.
        leavingObservers = [UIApplication.willResignActiveNotification, UIApplication.didEnterBackgroundNotification].map { name in
            NotificationCenter.default.addObserver(forName: name, object: nil, queue: .main) { [weak self] _ in
                MainActor.assumeIsolated {
                    self?.revival?.cancel()
                    if name == UIApplication.didEnterBackgroundNotification { self?.pauseLaunchWatchdog() }
                }
            }
        }
        let monitor = NWPathMonitor()
        monitor.pathUpdateHandler = { [weak self] path in
            guard path.status == .satisfied else { return }
            DispatchQueue.main.async { self?.retryIfNeeded() }
        }
        monitor.start(queue: DispatchQueue(label: "app.talos.shell.path"))
        pathMonitor = monitor
    }

    /// If no relay page has finished within `BridgeGuard.launchTimeout`, show the offline page rather than a spinner
    /// or blank view for as long as the relay stalls.
    private func startLaunchWatchdog() {
        launchWatchdog?.invalidate()
        launchWatchdog = nil
        // A load that starts while the app is off screen (a web process that died there) is watched from the return to the front.
        if UIApplication.shared.applicationState == .background {
            watchdogPaused = true
            return
        }
        watchdogPaused = false
        launchStarted = Date()
        launchWatchdog = Timer.scheduledTimer(
            withTimeInterval: BridgeGuard.launchLimit(relayPageCommitted: relayPageCommitted), repeats: false
        ) { [weak self] _ in
            guard let self else { return }
            let elapsed = Date().timeIntervalSince(self.launchStarted)
            guard BridgeGuard.shouldFallToOffline(elapsed: elapsed + 0.5, relayPageFinished: self.relayPageFinished,
                                                 relayPageCommitted: self.relayPageCommitted),
                  let errorURL = (self.bridge as? CapacitorBridge)?.config.errorPathURL else { return }
            self.launchSpinner.stopAnimating()
            self.showingFallback = true
            self.webView?.load(URLRequest(url: errorURL))
        }
    }

    /// The app left the screen: the watchdog stops. Its timer would keep counting through a suspension and fire on the way back,
    /// before the load had its time (review R1-8).
    private func pauseLaunchWatchdog() {
        guard let timer = launchWatchdog, timer.isValid else { return }
        timer.invalidate()
        launchWatchdog = nil
        watchdogPaused = true
    }

    /// Back in front: a load that was being watched and is still unfinished gets the full limit again.
    private func resumeLaunchWatchdog() {
        let restart = BridgeGuard.shouldRestartWatchdogOnReturn(
            wasWatching: watchdogPaused, relayPageFinished: relayPageFinished, showingFallback: showingFallback)
        watchdogPaused = false
        if restart { startLaunchWatchdog() }
    }

    /// The relay answered and its HTML is arriving: the load is progressing, so the 12 s stall limit no longer applies.
    /// Restart the watchdog once with the longer committed limit.
    fileprivate func pageDidCommit() {
        guard let guardian, let url = webView?.url, guardian.isRelayURL(url),
              !relayPageFinished, !relayPageCommitted else { return }
        relayPageCommitted = true
        startLaunchWatchdog()
    }

    fileprivate func pageDidFinish() {
        launchSpinner.stopAnimating()
        // A page is on screen again, the relay's or the offline page (which has its own "Try again").
        hasShownAPage = true
        recovering = false
        updateReconnectNotice()
        guard let guardian, let url = webView?.url else { return }
        if guardian.isRelayURL(url) {
            relayPageFinished = true
            showingFallback = false
            launchWatchdog?.invalidate()
        } else {
            showingFallback = true
        }
    }

    private func topPresenter() -> UIViewController {
        var top: UIViewController = self
        while let presented = top.presentedViewController { top = presented }
        return top
    }

    private func showMedia(_ url: URL, guardian: BridgeGuard) {
        guard let webView else { return }
        let viewer = MediaViewerController(
            url: url, dataStore: webView.configuration.websiteDataStore, guardian: guardian
        ) { [weak self] external in self?.openInSafari(external) }
        let nav = UINavigationController(rootViewController: viewer)
        // Over full screen, not the default card: a card closes on a swipe down, which fought every scroll of a long page
        // (the owner, 2026-11-14). The X in the bar is the only way out; a swipe down only scrolls. Not .fullScreen: that
        // takes this web view out of the window while the viewer is up (a live call would end, a stuck-page rebuild would
        // find no window scene). The viewer's root is opaque, so nothing shows through.
        nav.modalPresentationStyle = .overFullScreen
        nav.modalPresentationCapturesStatusBarAppearance = true
        topPresenter().present(nav, animated: true)
    }

    /// Fetches one relay /media/ file with the web view's own cookies, writes it to a temp file with a safe name, and opens the
    /// system share sheet (Save to Files, AirDrop, Mail). The temp folder is deleted when the sheet closes. Any failure shows an
    /// alert: the owner is never left thinking it was shared.
    private func shareMedia(_ url: URL, name: String) {
        guard let webView, let guardian, guardian.isRelayMedia(url) else { return }
        // One share at a time: a second tap while the first is downloading or its sheet is up starts nothing.
        guard !shareInFlight else { return }
        shareInFlight = true
        let store = webView.configuration.websiteDataStore.httpCookieStore
        store.getAllCookies { [weak self] cookies in
            Task { @MainActor in
                guard let self else { return }
                let folder = FileManager.default.temporaryDirectory.appendingPathComponent("share-\(UUID().uuidString)", isDirectory: true)
                do {
                    let file = try await MediaFetcher.fetch(url: url, name: name, cookies: cookies, into: folder)
                    let sheet = UIActivityViewController(activityItems: [file], applicationActivities: nil)
                    sheet.completionWithItemsHandler = { _, _, _, _ in try? FileManager.default.removeItem(at: folder) }
                    let top = self.topPresenter()
                    sheet.popoverPresentationController?.sourceView = top.view
                    sheet.popoverPresentationController?.sourceRect = CGRect(x: top.view.bounds.midX, y: top.view.bounds.maxY - 80, width: 1, height: 1)
                    top.present(sheet, animated: true) { self.finishShare() }
                } catch {
                    try? FileManager.default.removeItem(at: folder)
                    let alert = UIAlertController(
                        title: "Couldn't get the file", message: MediaFetcher.message(for: error), preferredStyle: .alert)
                    alert.addAction(UIAlertAction(title: "OK", style: .default))
                    self.topPresenter().present(alert, animated: true)
                    self.finishShare()
                }
            }
        }
    }

    /// The sheet is up or the fetch failed: allow the next share and tell the page, which shows "Preparing…" until then.
    private func finishShare() {
        shareInFlight = false
        webView?.evaluateJavaScript("window.dispatchEvent(new CustomEvent('talos:share-media-done'))", completionHandler: nil)
    }

    private func openInSafari(_ url: URL) {
        guard let scheme = url.scheme?.lowercased(), scheme == "http" || scheme == "https" else { return }
        topPresenter().present(SFSafariViewController(url: url), animated: true)
    }
}

/// The "Reconnecting…" cover: the brand background (so nothing black shows through), a spinner and one line of text.
final class ReconnectNoticeView: UIView {
    static let text = "Reconnecting…"
    private let spinner = UIActivityIndicatorView(style: .large)
    private let label = UILabel()

    override init(frame: CGRect) {
        super.init(frame: frame)
        let ink = UIColor(red: 0xF3 / 255, green: 0xE6 / 255, blue: 0xCF / 255, alpha: 1)
        backgroundColor = UIColor(red: 0x14 / 255, green: 0x11 / 255, blue: 0x10 / 255, alpha: 1)
        spinner.color = ink
        label.text = Self.text
        label.textColor = ink
        label.font = .preferredFont(forTextStyle: .body)
        label.adjustsFontForContentSizeCategory = true
        label.textAlignment = .center
        label.numberOfLines = 0
        let stack = UIStackView(arrangedSubviews: [spinner, label])
        stack.axis = .vertical
        stack.alignment = .center
        stack.spacing = 16
        stack.translatesAutoresizingMaskIntoConstraints = false
        addSubview(stack)
        NSLayoutConstraint.activate([
            stack.centerXAnchor.constraint(equalTo: centerXAnchor),
            stack.centerYAnchor.constraint(equalTo: centerYAnchor),
            stack.leadingAnchor.constraint(greaterThanOrEqualTo: leadingAnchor, constant: 24),
            stack.trailingAnchor.constraint(lessThanOrEqualTo: trailingAnchor, constant: -24),
        ])
        isAccessibilityElement = true
        accessibilityLabel = Self.text
        accessibilityTraits = .updatesFrequently
    }

    @available(*, unavailable)
    required init?(coder: NSCoder) { fatalError("not built from a storyboard") }

    func start() { spinner.startAnimating() }
    func stop() { spinner.stopAnimating() }
}

/// Receives `talosShareMedia {path, name, mime}` from the page. Same gate as plugin calls (top frame, relay origin, a page outside
/// /media/), then the path must be exactly `/media/<id>`; the URL is built from the active relay origin, never from the page.
final class ShareMediaMessageHandler: NSObject, WKScriptMessageHandler {
    static let name = "talosShareMedia"
    private let guardian: BridgeGuard
    let trust: RelayTrust
    private let share: (URL, String) -> Void

    init(guardian: BridgeGuard, trust: RelayTrust, share: @escaping (URL, String) -> Void) {
        self.guardian = guardian
        self.trust = trust
        self.share = share
    }

    func userContentController(_ userContentController: WKUserContentController, didReceive message: WKScriptMessage) {
        let frame = message.frameInfo
        let o = frame.securityOrigin
        let origin = o.host.isEmpty ? nil : Origin(scheme: o.protocol, host: o.host, port: o.port)
        let page = message.webView?.url ?? frame.request.url
        guard guardian.allowsPluginCall(isMainFrame: frame.isMainFrame, frameOrigin: origin, pageURL: page, trust: trust.state),
              let body = message.body as? [String: Any],
              let path = body["path"] as? String,
              let url = guardian.shareMediaURL(path: path)
        else {
            CAPLog.print("Talos bridge guard: dropped a share request")
            return
        }
        share(url, BridgeGuard.shareFileName(body["name"] as? String ?? ""))
    }
}

/// Downloads one relay file to a temp folder. Cookies are copied from the web view's store (only those that apply to this URL),
/// redirects are refused (a relay file is never a redirect), and a non-200 answer is an error.
enum MediaFetcher {
    struct Failure: Error { let status: Int? }
    private final class NoRedirect: NSObject, URLSessionTaskDelegate {
        func urlSession(_ s: URLSession, task: URLSessionTask, willPerformHTTPRedirection r: HTTPURLResponse,
                        newRequest: URLRequest, completionHandler: @escaping (URLRequest?) -> Void) { completionHandler(nil) }
    }

    static func fetch(url: URL, name: String, cookies: [HTTPCookie], into folder: URL) async throws -> URL {
        var request = URLRequest(url: url, cachePolicy: .reloadIgnoringLocalCacheData, timeoutInterval: 30)
        for (k, v) in HTTPCookie.requestHeaderFields(with: cookies.filter { cookieApplies($0, to: url) }) { request.setValue(v, forHTTPHeaderField: k) }
        let config = URLSessionConfiguration.ephemeral
        config.httpShouldSetCookies = false
        config.timeoutIntervalForResource = 300
        let session = URLSession(configuration: config, delegate: NoRedirect(), delegateQueue: nil)
        defer { session.finishTasksAndInvalidate() }
        let (tmp, response) = try await session.download(for: request)
        guard let http = response as? HTTPURLResponse, http.statusCode == 200 else {
            try? FileManager.default.removeItem(at: tmp)
            throw Failure(status: (response as? HTTPURLResponse)?.statusCode)
        }
        do {
            try FileManager.default.createDirectory(at: folder, withIntermediateDirectories: true)
            let dest = folder.appendingPathComponent(name, isDirectory: false)
            try FileManager.default.moveItem(at: tmp, to: dest)
            return dest
        } catch {
            // The download file would otherwise sit in the temp folder until the system clears it.
            try? FileManager.default.removeItem(at: tmp)
            throw error
        }
    }

    private static func cookieApplies(_ c: HTTPCookie, to url: URL) -> Bool {
        guard let host = url.host?.lowercased() else { return false }
        let d = c.domain.lowercased()
        let hostMatch = d.hasPrefix(".") ? (host == String(d.dropFirst()) || host.hasSuffix(d)) : host == d
        return hostMatch && (!c.isSecure || url.scheme == "https")
    }

    static func message(for error: Error) -> String {
        if let f = error as? Failure, f.status == 410 || f.status == 404 {
            return "This file expired from the relay. Ask the agent to resend it."
        }
        return "Check your connection and try again."
    }
}

/// Forwards "bridge" messages to Capacitor's handler only when the guard allows them.
final class GuardedMessageHandler: NSObject, WKScriptMessageHandler {
    private let inner: WKScriptMessageHandler
    private let guardian: BridgeGuard
    let trust: RelayTrust
    private var dropped = 0

    init(inner: WKScriptMessageHandler, guardian: BridgeGuard, trust: RelayTrust) {
        self.inner = inner
        self.guardian = guardian
        self.trust = trust
    }

    func userContentController(_ userContentController: WKUserContentController, didReceive message: WKScriptMessage) {
        // Capacitor's own cookie and HTTP plugins are never reachable (BridgeGuard.blockedPluginIds).
        guard !BridgeGuard.blocksPluginCall(body: message.body) else {
            dropped += 1
            CAPLog.print("Talos bridge guard: dropped call #\(dropped) to a blocked plugin")
            return
        }
        let frame = message.frameInfo
        let o = frame.securityOrigin
        let origin = o.host.isEmpty ? nil : Origin(scheme: o.protocol, host: o.host, port: o.port)
        // The top frame's URL decides the path; frameInfo.request is the fallback.
        let page = message.webView?.url ?? frame.request.url
        guard guardian.allowsPluginCall(isMainFrame: frame.isMainFrame, frameOrigin: origin, pageURL: page, trust: trust.state) else {
            dropped += 1
            let who = origin.map { "\($0.scheme)://\($0.host)" } ?? "unknown origin"
            CAPLog.print("Talos bridge guard: dropped call #\(dropped) from \(who)")
            return
        }
        inner.userContentController(userContentController, didReceive: message)
    }
}

/// Sits in front of Capacitor's WKNavigationDelegate / WKUIDelegate. It owns every decision that could hand control to
/// untrusted content (navigation, popups, the prompt() cookie channel, camera/mic) and forwards the rest, including
/// delegate methods added by later Capacitor versions, to the original handler.
final class NavigationGate: NSObject, WKNavigationDelegate, WKUIDelegate {
    private let inner: NSObject
    private let guardian: BridgeGuard
    let trust: RelayTrust
    private let openInSafari: (URL) -> Void
    private let showMedia: (URL) -> Void
    private let pageDidReset: () -> Void
    private let retry: () -> Void
    private let processDied: () -> Void
    private let didCommit: () -> Void
    private let didFinish: () -> Void

    init(
        inner: NSObject, guardian: BridgeGuard, trust: RelayTrust,
        openInSafari: @escaping (URL) -> Void, showMedia: @escaping (URL) -> Void,
        pageDidReset: @escaping () -> Void = {},
        retry: @escaping () -> Void = {},
        processDied: @escaping () -> Void = {},
        didCommit: @escaping () -> Void = {},
        didFinish: @escaping () -> Void = {}
    ) {
        self.inner = inner
        self.guardian = guardian
        self.trust = trust
        self.openInSafari = openInSafari
        self.showMedia = showMedia
        self.pageDidReset = pageDidReset
        self.retry = retry
        self.processDied = processDied
        self.didCommit = didCommit
        self.didFinish = didFinish
    }

    override func responds(to aSelector: Selector!) -> Bool {
        super.responds(to: aSelector) || inner.responds(to: aSelector)
    }

    override func forwardingTarget(for aSelector: Selector!) -> Any? {
        inner.responds(to: aSelector) ? inner : super.forwardingTarget(for: aSelector)
    }

    /// Top frame, relay origin, outside /media/: the same predicate that gates the bridge.
    private func trusted(_ frame: WKFrameInfo, _ webView: WKWebView) -> Bool {
        let o = frame.securityOrigin
        let origin = o.host.isEmpty ? nil : Origin(scheme: o.protocol, host: o.host, port: o.port)
        return guardian.allowsPluginCall(
            isMainFrame: frame.isMainFrame, frameOrigin: origin, pageURL: webView.url ?? frame.request.url, trust: trust.state)
    }

    private func frameParts(_ frame: WKFrameInfo, _ webView: WKWebView) -> (Bool, Origin?, URL?) {
        let o = frame.securityOrigin
        return (frame.isMainFrame, o.host.isEmpty ? nil : Origin(scheme: o.protocol, host: o.host, port: o.port),
                webView.url ?? frame.request.url)
    }

    private func promptChannelAllowed(_ frame: WKFrameInfo, _ webView: WKWebView) -> Bool {
        let p = frameParts(frame, webView)
        return guardian.allowsPromptChannel(isMainFrame: p.0, frameOrigin: p.1, pageURL: p.2, trust: trust.state)
    }

    private func devicePermission(_ frame: WKFrameInfo, _ webView: WKWebView) -> BridgeGuard.Permission {
        let p = frameParts(frame, webView)
        return guardian.devicePermission(isMainFrame: p.0, frameOrigin: p.1, pageURL: p.2, trust: trust.state)
    }

    private func route(_ url: URL) {
        if guardian.isRelayMedia(url) { showMedia(url) } else { openInSafari(url) }
    }

    // MARK: Navigation

    func webView(
        _ webView: WKWebView,
        decidePolicyFor navigationAction: WKNavigationAction,
        decisionHandler: @escaping (WKNavigationActionPolicy) -> Void
    ) {
        // The offline page's "Try again" is a talos-retry:// link: handled here, never loaded (audit D3).
        if let url = navigationAction.request.url, BridgeGuard.isRetryURL(url) {
            if guardian.allowsRetry(url: url, isMainFrame: navigationAction.sourceFrame.isMainFrame, currentURL: webView.url) {
                retry()
            }
            decisionHandler(.cancel)
            return
        }
        if let url = navigationAction.request.url,
           guardian.shouldOpenInSafari(
               url: url,
               isNewWindow: navigationAction.targetFrame == nil,
               isMainFrameTarget: navigationAction.targetFrame?.isMainFrame ?? true
           ) {
            route(url)
            decisionHandler(.cancel)
            return
        }
        guard let ui = inner as? WKNavigationDelegate else { return decisionHandler(.allow) }
        ui.webView?(webView, decidePolicyFor: navigationAction, decisionHandler: decisionHandler)
    }

    /// A relay page that answers with a server error is a failed load, not a loaded page: it is cancelled, WebKit reports the
    /// load as failed and Capacitor shows the offline page, so the retries (tap, network return, foreground) apply. If that
    /// ever does not happen, the launch watchdog still falls to the offline page, since no relay page finished.
    func webView(
        _ webView: WKWebView,
        decidePolicyFor navigationResponse: WKNavigationResponse,
        decisionHandler: @escaping (WKNavigationResponsePolicy) -> Void
    ) {
        if navigationResponse.isForMainFrame, let url = navigationResponse.response.url, guardian.isRelayURL(url),
           BridgeGuard.isFailedPageLoad(statusCode: (navigationResponse.response as? HTTPURLResponse)?.statusCode) {
            return decisionHandler(.cancel)
        }
        (inner as? WKNavigationDelegate)?.webView?(webView, decidePolicyFor: navigationResponse, decisionHandler: decisionHandler)
            ?? decisionHandler(.allow)
    }

    // MARK: The page went away: a new document committed (reload, navigation) or the web process died. Whatever audio it
    // had asked for is over, so the session is released (TalosAudio idle).

    func webView(_ webView: WKWebView, didCommit navigation: WKNavigation!) {
        pageDidReset()
        didCommit()
        (inner as? WKNavigationDelegate)?.webView?(webView, didCommit: navigation)
    }

    func webView(_ webView: WKWebView, didFinish navigation: WKNavigation!) {
        didFinish()
        (inner as? WKNavigationDelegate)?.webView?(webView, didFinish: navigation)
    }

    func webViewWebContentProcessDidTerminate(_ webView: WKWebView) {
        pageDidReset()
        // Capacitor resets its bridge and calls reload(); the shell's own watched load follows and replaces that reload.
        (inner as? WKNavigationDelegate)?.webViewWebContentProcessDidTerminate?(webView)
        processDied()
    }

    // MARK: Popups

    func webView(
        _ webView: WKWebView,
        createWebViewWith configuration: WKWebViewConfiguration,
        for navigationAction: WKNavigationAction,
        windowFeatures: WKWindowFeatures
    ) -> WKWebView? {
        let url = navigationAction.request.url
        switch guardian.popupAction(url: url, sourceIsTrusted: trusted(navigationAction.sourceFrame, webView)) {
        case .showMedia, .openInBrowser: if let url { route(url) }
        case .openMail: if let url { UIApplication.shared.open(url, options: [:], completionHandler: nil) }
        case .refuse: break
        }
        // Every other scheme (tel:, other apps' URL schemes, javascript:, data:) is refused: a page cannot launch apps.
        return nil
    }

    // MARK: prompt() cookie channel (Capacitor answers CapacitorCookies.get/set here, for any frame)

    func webView(
        _ webView: WKWebView,
        runJavaScriptTextInputPanelWithPrompt prompt: String,
        defaultText: String?,
        initiatedByFrame frame: WKFrameInfo,
        completionHandler: @escaping (String?) -> Void
    ) {
        // Capacitor's cookie and HTTP plugins are refused here too: its handler answers CapacitorCookies.* for any enabled state.
        guard !BridgeGuard.blocksPrompt(prompt), promptChannelAllowed(frame, webView), let ui = inner as? WKUIDelegate
        else { return completionHandler(nil) }
        ui.webView?(
            webView, runJavaScriptTextInputPanelWithPrompt: prompt, defaultText: defaultText,
            initiatedByFrame: frame, completionHandler: completionHandler) ?? completionHandler(nil)
    }

    // MARK: Camera, microphone, motion: trusted frame only (Capacitor's own handler grants everything)

    func webView(
        _ webView: WKWebView,
        requestMediaCapturePermissionFor origin: WKSecurityOrigin,
        initiatedByFrame frame: WKFrameInfo,
        type: WKMediaCaptureType,
        decisionHandler: @escaping (WKPermissionDecision) -> Void
    ) {
        decisionHandler(devicePermission(frame, webView) == .grant ? .grant : .deny)
    }

    func webView(
        _ webView: WKWebView,
        requestDeviceOrientationAndMotionPermissionFor origin: WKSecurityOrigin,
        initiatedByFrame frame: WKFrameInfo,
        decisionHandler: @escaping (WKPermissionDecision) -> Void
    ) {
        decisionHandler(devicePermission(frame, webView) == .grant ? .grant : .deny)
    }
}
