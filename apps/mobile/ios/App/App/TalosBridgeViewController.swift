import BridgeGuard
import Capacitor
import Network
import TalosRelayCore
import UIKit
import WebKit

/// The shell's only view controller. It locks the native bridge to the relay origin (IOS-SPEC rev 2, item I14):
///  1. Capacitor's "bridge" WKScriptMessageHandler is wrapped, so plugin calls are dropped unless they come from the
///     top frame, on the relay origin, at a path outside /media/.
///  2. Anything that is not a relay page leaves this web view: other hosts open OUTSIDE Talos through the system (a Drive or Docs
///     link in its app, the rest in Safari with the owner's own sign-ins; the owner, 2026-11-20), relay /media/
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
    /// Runs this relay's attests and writes the result into `relayContext.trust` (BYOR phase 4b). nil for a page that is no paired relay.
    private(set) var attestCoordinator: AttestCoordinator?
    /// Who runs the attests. Only a DEBUG build (the tests) can replace it; a release build always makes the real one.
    #if DEBUG
    static var attester: @MainActor () -> AttestRunning = { LiveAttester() }
    #else
    static let attester: @MainActor () -> AttestRunning = { LiveAttester() }
    #endif
    private let repinPrompt = RepinPrompt()
    private var trustBanner: TrustBannerView?
    private var trustBlock: TrustBlockView?
    private var attestTimer: Timer?
    /// Fires once at last-verified + 24 h so the block screen shows on time even when no check runs (a check that cannot answer is not needed for it).
    private var hardBlockTimer: Timer?
    /// `<origin>/enroll#<code>` waits here until the first attest has answered: the code goes to the page only after a pass.
    private var pendingFirstPage: URL?
    private var launchLoadDone = false
    /// For tests: the address the last `loadRelay` asked the web view for.
    private(set) var lastRelayLoad: URL?
    private var pathMonitor: NWPathMonitor?
    private var launchWatchdog: Timer?
    private var revival: WebViewRevival?
    private var launchStarted = Date()
    private var shareInFlight = false
    private var relayPageFinished = false
    var relayPageFinishedForTests: Bool { relayPageFinished }
    /// For tests: what a finish sees as the web view's url. A real web view's url changes with the real (unreachable) load, so a
    /// test that must be exact sets it.
    var shownURLForTests: URL?
    var relayPageCommittedForTests: Bool { relayPageCommitted }
    /// The navigation `loadRelay` started, until it finishes or the next `loadRelay`. A finish or commit for any OTHER navigation while it is
    /// pending is an earlier load's late news (Capacitor's offline page, which the gate's cancelled first load leaves behind):
    /// `webView.url` already names the relay by then, so the url alone cannot tell them apart.
    private(set) var relayNavigation: WKNavigation?
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
        attestTimer?.invalidate()
        attestTimer = nil
        hardBlockTimer?.invalidate()
        hardBlockTimer = nil
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
            if guardian?.isRelayURL(page) == true {
                // Nothing loads before the first attest has answered (BYOR phase 4b): the code goes only to a relay that just passed.
                if attestCoordinator == nil { loadRelay(startingAt: page) } else { pendingFirstPage = page }
            }
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
            openOutside: { [weak self] url in self?.openOutside(url) },
            showMedia: { [weak self] url in self?.showMedia(url, guardian: guardian) },
            pageDidReset: {
                TalosAudioPlugin.resetSession()
                TalosPushCenter.shared.pageLeft()
            },
            pageLoadAllowed: { [weak trust] in trust?.allowsPageLoad ?? false },
            retry: { [weak self] in self?.retryIfNeeded(tapped: true) },
            processDied: { [weak self] in self?.webProcessDied() },
            didCommit: { [weak self] nav in self?.pageDidCommit(nav) },
            didFinish: { [weak self] nav in self?.pageDidFinish(nav) }
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
        if let profile = context.active.profile {
            startAttests(profile: profile, context: context)
        } else {
            startLaunchWatchdog()
        }
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

    // MARK: Mac check (BYOR phase 4b, docs/specs/BYOR-phase4-frame.md sections 4 to 7)

    /// The relay starts unverified. A check runs at launch before anything loads, on foreground, on a network change, on a timer while
    /// in front, and when the page asks (`TalosRelay.recheck`). The result decides whether the page loads and what native code may do.
    private func startAttests(profile: RelayProfile, context: RelayContext) {
        let store = webView?.configuration.websiteDataStore.httpCookieStore
        let coordinator = AttestCoordinator(
            profile: profile, trust: context.trust, runner: TalosBridgeViewController.attester(),
            cookie: { [weak store] in
                guard let store else { return nil }
                return await PairedSessionCookie.header(store: store, origin: profile.origin)
            },
            store: { TalosBridgeViewController.runtime().store() },
            confirmRepin: { [weak self] host, _ in
                guard let self else { return .decline }
                return await self.repinPrompt.ask(host: host) { self.topPresenter() }
            },
            changed: { [weak self] in self?.trustChanged() },
            remove: { [weak self] in self?.removeRelay() })
        attestCoordinator = coordinator
        attestTimer = Timer.scheduledTimer(withTimeInterval: AttestSchedule.timerInterval, repeats: true) { [weak self] _ in
            MainActor.assumeIsolated {
                if UIApplication.shared.applicationState == .active { self?.runAttest(.timer) }
            }
        }
        // The launch spinner covers the wait; the offline page cannot show in the middle of the check, because the watchdog starts
        // only when the page load does (loadRelay).
        runAttest(.launch)
    }

    private func runAttest(_ trigger: AttestCoordinator.Trigger) {
        guard let coordinator = attestCoordinator else { return }
        Task { @MainActor in await coordinator.run(trigger) }
    }

    /// An attest has answered (any answer): show what the trust state says, and run the first load once.
    private func trustChanged() {
        guard let trust = relayContext?.trust, trust.settled else { return }
        if !launchLoadDone {
            launchLoadDone = true
            let page = pendingFirstPage
            pendingFirstPage = nil
            // The setup code goes only to a relay that has just passed; unverified loads the ordinary start page, read-only.
            loadRelay(startingAt: trust.state == .pass ? page : nil)
        }
        refreshTrustUI()
    }

    private var trustBlockedBefore = false

    /// Banner for unverified, full-screen native screen (no page) for failed and hard-block. Leaving a block brings the page back.
    func refreshTrustUI() {
        guard let trust = relayContext?.trust, trust.settled else { return }
        let host = relayContext?.active.profile?.label ?? ""
        let now = Date()
        let state = trust.state
        switch state {
        case .pass:
            removeBanner(); removeBlock()
        case let .unverified(lastVerified, reason):
            removeBlock()
            showBanner(TrustWords.banner(lastVerified: lastVerified, reason: reason, host: host, now: now))
        case let .failed(reason):
            removeBanner()
            showBlock(title: TrustWords.failTitle, text: TrustWords.failBody(host: host), retry: false)
            CAPLog.print("Talos: this relay failed the Mac check (\(reason))")
        case let .hardBlock(lastVerified):
            removeBanner()
            showBlock(title: TrustWords.blockTitle, text: TrustWords.blockBody(lastVerified: lastVerified, host: host, now: now), retry: true)
        }
        let blocked = !state.loadsPage
        if blocked, !trustBlockedBefore { clearPage() }
        if !blocked, trustBlockedBefore { loadRelay() }
        trustBlockedBefore = blocked
        trustBanner?.retry.isEnabled = true
        scheduleHardBlockRefresh(trust)
    }

    private func scheduleHardBlockRefresh(_ trust: RelayTrust) {
        hardBlockTimer?.invalidate()
        hardBlockTimer = nil
        guard let delay = RelayTrust.secondsUntilHardBlock(lastVerified: trust.lastVerifiedAt, now: Date()) else { return }
        hardBlockTimer = Timer.scheduledTimer(withTimeInterval: delay, repeats: false) { [weak self] _ in
            MainActor.assumeIsolated { self?.refreshTrustUI() }
        }
    }

    /// For tests: what the native trust surfaces show.
    var isShowingTrustBanner: Bool { trustBanner?.superview != nil }
    var trustBannerText: String? { trustBanner?.message.text }
    var isShowingTrustBlock: Bool { trustBlock?.superview != nil }
    var trustBlockIsFail: Bool { trustBlock?.accessibilityIdentifier == "trust.fail" }
    var isRepinPromptShowing: Bool { repinPrompt.isShowing }
    var repinPromptForTests: RepinPrompt { repinPrompt }
    /// For tests: the launch watchdog is counting.
    var isLaunchWatchdogRunning: Bool { launchWatchdog?.isValid == true }
    /// For tests: why a watchdog is not running (a page finished, the app is off screen, or it never started).
    /// The app's state as the watchdog sees it. A test sets it: a simulator test host that is not in front reports .background,
    /// which pauses the watchdog by design, so a test about the watchdog cannot leave it to the machine.
    static var applicationState: @MainActor () -> UIApplication.State = { UIApplication.shared.applicationState }
    var watchdogStateForTests: String {
        "running=\(isLaunchWatchdogRunning) paused=\(watchdogPaused) finished=\(relayPageFinished) fallback=\(showingFallback) appState=\(UIApplication.shared.applicationState.rawValue)"
    }

    private func showBanner(_ text: String) {
        launchSpinner.stopAnimating()
        if trustBanner == nil {
            let banner = TrustBannerView(onRetry: { [weak self] in self?.retryTapped() }, onRemove: { [weak self] in self?.removeRelay() })
            banner.translatesAutoresizingMaskIntoConstraints = false
            view.addSubview(banner)
            NSLayoutConstraint.activate([
                banner.topAnchor.constraint(equalTo: view.topAnchor),
                banner.leadingAnchor.constraint(equalTo: view.leadingAnchor),
                banner.trailingAnchor.constraint(equalTo: view.trailingAnchor),
            ])
            trustBanner = banner
        }
        if trustBanner?.message.text != text { UIAccessibility.post(notification: .announcement, argument: text) }
        trustBanner?.message.text = text
        if let banner = trustBanner { view.bringSubviewToFront(banner) }
        applyBannerInset()
    }

    private func removeBanner() {
        trustBanner?.removeFromSuperview()
        trustBanner = nil
        applyBannerInset()
    }

    /// The banner sits over the top of the web view, so the page is moved down by its height: the page's own header and links stay
    /// reachable under it (the page is read-only, not hidden).
    private func applyBannerInset() {
        guard let scroll = webView?.scrollView else { return }
        view.layoutIfNeeded()
        let top = trustBanner?.frame.height ?? 0
        guard scroll.contentInset.top != top else { return }
        let wasAtTop = scroll.contentOffset.y <= -scroll.contentInset.top + 1
        scroll.contentInset.top = top
        scroll.verticalScrollIndicatorInsets.top = top
        if wasAtTop { scroll.contentOffset.y = -top }
    }

    override func viewDidLayoutSubviews() {
        super.viewDidLayoutSubviews()
        if trustBanner != nil { applyBannerInset() }
    }

    private func showBlock(title: String, text: String, retry: Bool) {
        launchSpinner.stopAnimating()
        launchWatchdog?.invalidate()
        launchWatchdog = nil
        removeBlock()
        let block = TrustBlockView(
            title: title, text: text, onRetry: retry ? { [weak self] in self?.retryTapped() } : nil, onRemove: { [weak self] in self?.removeRelay() })
        block.frame = view.bounds
        block.autoresizingMask = [.flexibleWidth, .flexibleHeight]
        view.addSubview(block)
        trustBlock = block
    }

    private func removeBlock() {
        trustBlock?.removeFromSuperview()
        trustBlock = nil
    }

    /// The page goes: nothing of the relay stays in the web view under a block screen.
    private func clearPage() {
        webView?.stopLoading()
        webView?.loadHTMLString("", baseURL: nil)
        relayPageFinished = false
        showingFallback = false
    }

    private func retryTapped() {
        trustBanner?.retry.isEnabled = false
        runAttest(.retry)
    }

    /// Remove goes straight to the native Add-relay sheet (the phone's list loses this relay first).
    private func removeRelay() {
        guard let profile = relayContext?.active.profile,
              let scene = view.window?.windowScene?.delegate as? SceneDelegate, scene.window?.rootViewController === self else { return }
        Task { @MainActor in await scene.removeRelayThenAdd(id: profile.id) }
    }

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
        guard let relayURL, let webView, relayContext?.trust.allowsPageLoad ?? true else { return }
        var target = startingAt ?? relayURL
        if keepingRoute, let current = webView.url, guardian?.isRelayURL(current) == true, !BridgeGuard.isMediaPath(current) {
            target = current
        }
        lastRelayLoad = target
        relayPageFinished = false
        relayPageCommitted = false
        showingFallback = false
        launchSpinner.startAnimating()
        if recovering {
            self.recovering = true
            updateReconnectNotice()
        }
        relayNavigation = webView.load(URLRequest(url: target))
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
        attestCoordinator?.stop()
        repinPrompt.cancel()
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
                self?.runAttest(.foreground)
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
            DispatchQueue.main.async {
                self?.retryIfNeeded()
                self?.runAttest(.network)
            }
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
        if Self.applicationState() == .background {
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
    fileprivate func pageDidCommit(_ navigation: WKNavigation?) {
        if isEarlierNavigation(navigation) { return }
        guard let guardian, let url = shownURLForTests ?? webView?.url, guardian.isRelayURL(url),
              !relayPageFinished, !relayPageCommitted else { return }
        relayPageCommitted = true
        startLaunchWatchdog()
    }

    /// True for a navigation that is not the pending relay load, while one is pending.
    private func isEarlierNavigation(_ navigation: WKNavigation?) -> Bool {
        guard let pending = relayNavigation else { return false }
        return navigation !== pending
    }

    fileprivate func pageDidFinish(_ navigation: WKNavigation?) {
        // While the relay load is pending, only ITS finish is the relay page finishing. Any other navigation's finish is an
        // earlier page's late news: it must not stop the spinner or the watchdog or mark the relay finished. The relay load
        // failing does not change that (the pending navigation stays until the next `loadRelay` or its own finish), so the
        // offline page Capacitor shows for the failure is told apart by its url, never by "the relay load is over".
        let isRelayLoad = relayNavigation == nil || navigation === relayNavigation
        if isRelayLoad { relayNavigation = nil }
        let shown = shownURLForTests ?? webView?.url
        if !isRelayLoad, let shown, guardian?.isRelayURL(shown) == true { return }
        launchSpinner.stopAnimating()
        // A page is on screen again, the relay's or the offline page (which has its own "Try again").
        hasShownAPage = true
        recovering = false
        updateReconnectNotice()
        guard let guardian, let url = shown else { return }
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
        ) { [weak self] external in self?.openOutside(external) }
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

    /// How a link leaves Talos. The system decides where it goes: a universal link (a Google Drive or Docs link, say) opens in its
    /// app, anything else in Safari, signed in as the owner is there. Never an in-app browser: SFSafariViewController shares no
    /// sign-in with Safari and keeps a Drive link out of the Drive app, so the owner met a Google sign-in inside Talos
    /// (2026-11-20). Tests replace it.
    var openURL: (URL) -> Void = { UIApplication.shared.open($0, options: [:], completionHandler: nil) }

    /// A web link that is not a relay page: out of Talos, through `openURL`. Only http and https; any other scheme is refused.
    func openOutside(_ url: URL) {
        guard let scheme = url.scheme?.lowercased(), scheme == "http" || scheme == "https" else { return }
        openURL(url)
    }
}
