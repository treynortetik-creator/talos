import BridgeGuard
import Capacitor
import Network
import SafariServices
import UIKit
import WebKit

/// The shell's only view controller. It locks the native bridge to the relay origin (IOS-SPEC rev 2, item I14):
///  1. Capacitor's "bridge" WKScriptMessageHandler is wrapped, so plugin calls are dropped unless they come from the
///     top frame, on the relay origin, at a path outside /media/.
///  2. Anything that is not a relay page leaves this web view: other hosts go to SFSafariViewController, relay /media/
///     pages (agent-written HTML, "Open in new tab", downloads) go to a bridge-less in-app viewer that shares the
///     session cookie. Capacitor's prompt() cookie channel and the camera/mic grant are limited to the trusted frame.
/// The relay origin is the build-time `server.url` baked into capacitor.config.json. It is never read from page content.
final class TalosBridgeViewController: CAPBridgeViewController {
    private var navigationGate: NavigationGate?
    private var keyboardHideObserver: NSObjectProtocol?
    private var foregroundObserver: NSObjectProtocol?
    private var leavingObservers: [NSObjectProtocol] = []
    private var guardian: BridgeGuard?
    private var relayURL: URL?
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
    }

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

    /// Capacitor builds the web view from this configuration, so the suffix is in place before the first request.
    override func webViewConfiguration(for instanceConfiguration: InstanceConfiguration) -> WKWebViewConfiguration {
        let configuration = super.webViewConfiguration(for: instanceConfiguration)
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
        // (TalosPluginGate refuses when no relay origin is compiled in).
        bridge?.registerPluginInstance(TalosAudioPlugin())
        bridge?.registerPluginInstance(TalosSharePlugin())
        bridge?.registerPluginInstance(TalosPushPlugin())
        bridge?.registerPluginInstance(TalosCrashPlugin())
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
        guard let guardian = BridgeGuard(relayURL: bridge.config.serverURL) else {
            // No usable origin: leave the bridge closed rather than open.
            bridge.webViewDelegationHandler.contentController.removeScriptMessageHandler(forName: "bridge")
            return
        }

        // 1. Wrap the bridge message handler.
        let handler = bridge.webViewDelegationHandler
        handler.contentController.removeScriptMessageHandler(forName: "bridge")
        handler.contentController.add(GuardedMessageHandler(inner: handler, guardian: guardian), name: "bridge")

        // 1b. The page's "share this attachment" message. A separate handler (not a Capacitor plugin call) so the only thing
        //     it can ever do is fetch one relay /media/<id> file and open the system share sheet.
        handler.contentController.removeScriptMessageHandler(forName: ShareMediaMessageHandler.name)
        handler.contentController.add(
            ShareMediaMessageHandler(guardian: guardian) { [weak self] url, name in self?.shareMedia(url, name: name) },
            name: ShareMediaMessageHandler.name)

        // 2. Route navigations, popups, prompts and permissions. WKWebView holds its delegates weakly, so the gate
        //    lives on self.
        let gate = NavigationGate(
            inner: handler, guardian: guardian,
            openInSafari: { [weak self] url in self?.openInSafari(url) },
            showMedia: { [weak self] url in self?.showMedia(url, guardian: guardian) },
            pageDidReset: { TalosAudioPlugin.resetSession() },
            retry: { [weak self] in self?.retryIfNeeded(tapped: true) },
            didCommit: { [weak self] in self?.pageDidCommit() },
            didFinish: { [weak self] in self?.pageDidFinish() }
        )
        navigationGate = gate
        webView.navigationDelegate = gate
        webView.uiDelegate = gate
        self.guardian = guardian
        relayURL = bridge.config.serverURL
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
            reload: { [weak self] in self?.loadRelay(keepingRoute: true) },
            rebuild: { [weak self] in self?.rebuildWebView() })
        startRetryTriggers()
        startLaunchWatchdog()
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
    private func loadRelay(keepingRoute: Bool = false) {
        guard let relayURL, let webView else { return }
        var target = relayURL
        if keepingRoute, let current = webView.url, guardian?.isRelayURL(current) == true, !BridgeGuard.isMediaPath(current) {
            target = current
        }
        relayPageFinished = false
        relayPageCommitted = false
        showingFallback = false
        launchSpinner.startAnimating()
        webView.load(URLRequest(url: target))
        startLaunchWatchdog()
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
                self?.retryIfNeeded()
                self?.revival?.appDidForeground()
            }
        }
        // Leaving the front voids a check that is still waiting for an answer.
        leavingObservers = [UIApplication.willResignActiveNotification, UIApplication.didEnterBackgroundNotification].map {
            NotificationCenter.default.addObserver(forName: $0, object: nil, queue: .main) { [weak self] _ in
                MainActor.assumeIsolated { self?.revival?.cancel() }
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
        topPresenter().present(UINavigationController(rootViewController: viewer), animated: true)
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

/// Receives `talosShareMedia {path, name, mime}` from the page. Same gate as plugin calls (top frame, relay origin, a page outside
/// /media/), then the path must be exactly `/media/<id>`; the URL is built from the compiled-in relay origin, never from the page.
final class ShareMediaMessageHandler: NSObject, WKScriptMessageHandler {
    static let name = "talosShareMedia"
    private let guardian: BridgeGuard
    private let share: (URL, String) -> Void

    init(guardian: BridgeGuard, share: @escaping (URL, String) -> Void) {
        self.guardian = guardian
        self.share = share
    }

    func userContentController(_ userContentController: WKUserContentController, didReceive message: WKScriptMessage) {
        let frame = message.frameInfo
        let o = frame.securityOrigin
        let origin = o.host.isEmpty ? nil : Origin(scheme: o.protocol, host: o.host, port: o.port)
        let page = message.webView?.url ?? frame.request.url
        guard guardian.allowsPluginCall(isMainFrame: frame.isMainFrame, frameOrigin: origin, pageURL: page),
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
    private var dropped = 0

    init(inner: WKScriptMessageHandler, guardian: BridgeGuard) {
        self.inner = inner
        self.guardian = guardian
    }

    func userContentController(_ userContentController: WKUserContentController, didReceive message: WKScriptMessage) {
        let frame = message.frameInfo
        let o = frame.securityOrigin
        let origin = o.host.isEmpty ? nil : Origin(scheme: o.protocol, host: o.host, port: o.port)
        // The top frame's URL decides the path; frameInfo.request is the fallback.
        let page = message.webView?.url ?? frame.request.url
        guard guardian.allowsPluginCall(isMainFrame: frame.isMainFrame, frameOrigin: origin, pageURL: page) else {
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
    private let openInSafari: (URL) -> Void
    private let showMedia: (URL) -> Void
    private let pageDidReset: () -> Void
    private let retry: () -> Void
    private let didCommit: () -> Void
    private let didFinish: () -> Void

    init(
        inner: NSObject, guardian: BridgeGuard,
        openInSafari: @escaping (URL) -> Void, showMedia: @escaping (URL) -> Void,
        pageDidReset: @escaping () -> Void = {},
        retry: @escaping () -> Void = {},
        didCommit: @escaping () -> Void = {},
        didFinish: @escaping () -> Void = {}
    ) {
        self.inner = inner
        self.guardian = guardian
        self.openInSafari = openInSafari
        self.showMedia = showMedia
        self.pageDidReset = pageDidReset
        self.retry = retry
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
            isMainFrame: frame.isMainFrame, frameOrigin: origin, pageURL: webView.url ?? frame.request.url)
    }

    private func frameParts(_ frame: WKFrameInfo, _ webView: WKWebView) -> (Bool, Origin?, URL?) {
        let o = frame.securityOrigin
        return (frame.isMainFrame, o.host.isEmpty ? nil : Origin(scheme: o.protocol, host: o.host, port: o.port),
                webView.url ?? frame.request.url)
    }

    private func promptChannelAllowed(_ frame: WKFrameInfo, _ webView: WKWebView) -> Bool {
        let p = frameParts(frame, webView)
        return guardian.allowsPromptChannel(isMainFrame: p.0, frameOrigin: p.1, pageURL: p.2)
    }

    private func devicePermission(_ frame: WKFrameInfo, _ webView: WKWebView) -> BridgeGuard.Permission {
        let p = frameParts(frame, webView)
        return guardian.devicePermission(isMainFrame: p.0, frameOrigin: p.1, pageURL: p.2)
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
        (inner as? WKNavigationDelegate)?.webViewWebContentProcessDidTerminate?(webView)
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
        guard promptChannelAllowed(frame, webView), let ui = inner as? WKUIDelegate else { return completionHandler(nil) }
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
