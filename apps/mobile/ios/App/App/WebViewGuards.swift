import BridgeGuard
import Capacitor
import SafariServices
import UIKit
import WebKit

// The web view's guards and helpers, moved out of TalosBridgeViewController.swift unchanged (to keep that file under the size budget):
// the "Reconnecting..." cover, the share-media handler, the media fetcher, the bridge message handler and the navigation gate.

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
    private let pageLoadAllowed: () -> Bool
    private let retry: () -> Void
    private let processDied: () -> Void
    private let didCommit: () -> Void
    private let didFinish: () -> Void

    init(
        inner: NSObject, guardian: BridgeGuard, trust: RelayTrust,
        openInSafari: @escaping (URL) -> Void, showMedia: @escaping (URL) -> Void,
        pageDidReset: @escaping () -> Void = {},
        pageLoadAllowed: @escaping () -> Bool = { true },
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
        self.pageLoadAllowed = pageLoadAllowed
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
        // No relay page loads before the first Mac check has answered, or while the relay is failed or hard-blocked (Capacitor's own first
        // load, a reload, a retry and a link in the page all pass here).
        if let url = navigationAction.request.url, guardian.isRelayURL(url), navigationAction.targetFrame?.isMainFrame ?? true,
           !pageLoadAllowed() {
            decisionHandler(.cancel)
            return
        }
        // The empty page that replaces a cleared relay page (`clearPage`), in EVERY build, release included: it holds nothing, but
        // Capacitor's allow-list would refuse it, and then the relay's page would stay in the web view under the fail and block screens.
        if navigationAction.request.url?.absoluteString == "about:blank", navigationAction.targetFrame?.isMainFrame ?? true {
            decisionHandler(.allow)
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

    // MARK: Camera and microphone always refused (voice input archived, docs/archived/voice.md); motion: trusted frame only
    // (Capacitor's own handler grants everything, so the method must exist and must never reach it)

    func webView(
        _ webView: WKWebView,
        requestMediaCapturePermissionFor origin: WKSecurityOrigin,
        initiatedByFrame frame: WKFrameInfo,
        type: WKMediaCaptureType,
        decisionHandler: @escaping (WKPermissionDecision) -> Void
    ) {
        decisionHandler(.deny)
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
