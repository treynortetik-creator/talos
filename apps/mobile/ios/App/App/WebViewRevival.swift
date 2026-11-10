import WebKit

/// What a trivial script asked of the page came back as.
enum PagePulse: Equatable {
    /// The page ran it (a script error still means the page is there).
    case answered
    /// WebKit says the page's web process is gone.
    case failed
    /// Nothing came back in time: the web process is alive and not answering.
    case silent
}

/// The page can be dead or stuck while the shell thinks it is fine. iOS can kill the web content process while the app is in
/// the background (WebKit does not always report that), and a web process that does not wake up leaves a black view that never
/// answers a touch, with `webView.url` still the relay URL, so `needsRetry` says "fine". On every return to the front this
/// asks the page a trivial question and acts only when it is not there:
///  - no URL (and no load running): load the start URL;
///  - the process is gone: leave it to Capacitor's own reload for a moment, then load the page again if nothing is loading;
///  - no answer: ask once more, with more time (a page that is busy waking up answers late). Only a second silence means
///    the process is stuck, and a load would queue behind it, so the web view is built again.
///
/// A check belongs to one foreground: leaving the front (`cancel`) voids it, and so does an answer that arrives while the app is
/// not active. One check at a time and at most one remedy per foreground, so a page that stays dead cannot loop. Every effect is
/// injected, so the decision is unit-tested without a real web process (AppTests/WebViewRevivalTests).
@MainActor
final class WebViewRevival {
    /// How long the page has the first time, and the second time, before it counts as silent.
    static let firstTimeout: TimeInterval = 2
    static let secondTimeout: TimeInterval = 5

    /// Runs a trivial script and calls back once, within the given time.
    typealias Ping = (TimeInterval, @escaping (PagePulse) -> Void) -> Void

    private let hasPage: () -> Bool
    private let isBusy: () -> Bool
    private let isActive: () -> Bool
    private let ping: Ping
    private let hop: (@escaping () -> Void) -> Void
    private let reload: () -> Void
    private let rebuild: () -> Void
    private var generation = 0
    private var checking = false

    /// - hasPage: the web view has a URL (nil after a process death that took the document with it).
    /// - isBusy: a load is running or the offline page is up. A load that is already going is never replaced by a reload; it does
    ///   not stop the check for a stuck process, which a loading page cannot hide from.
    /// - isActive: the app is in front and taking input.
    /// - hop: runs the closure after one turn of the run loop.
    /// - reload: loads the page again, on the route it was on.
    /// - rebuild: replaces the web view (and its web process) with a new one.
    init(hasPage: @escaping () -> Bool, isBusy: @escaping () -> Bool, isActive: @escaping () -> Bool,
         ping: @escaping Ping, hop: @escaping (@escaping () -> Void) -> Void,
         reload: @escaping () -> Void, rebuild: @escaping () -> Void) {
        self.hasPage = hasPage
        self.isBusy = isBusy
        self.isActive = isActive
        self.ping = ping
        self.hop = hop
        self.reload = reload
        self.rebuild = rebuild
    }

    /// The app came to the front. Does nothing unless the page is dead or stuck.
    func appDidForeground() {
        guard !checking else { return }
        if !hasPage(), !isBusy() { return reload() } // nothing to ask: there is no document
        checking = true
        generation += 1
        ask(generation, timeout: Self.firstTimeout, second: false)
    }

    /// The app is leaving the front (or has): whatever is being asked is void, and so is any answer still on its way.
    func cancel() {
        generation += 1
        checking = false
    }

    private func ask(_ gen: Int, timeout: TimeInterval, second: Bool) {
        ping(timeout) { [weak self] pulse in
            guard let self, gen == self.generation else { return }
            guard self.isActive() else { return self.cancel() } // a timeout that lands in the background says nothing about the page
            switch pulse {
            case .answered:
                self.checking = false
            case .failed:
                self.checking = false
                self.hop { [weak self] in
                    // Capacitor reloads a terminated page itself; only a page nothing is loading is ours to load.
                    guard let self, gen == self.generation, self.isActive(), !self.isBusy() else { return }
                    self.reload()
                }
            case .silent:
                if second {
                    self.checking = false
                    self.rebuild()
                } else {
                    self.ask(gen, timeout: Self.secondTimeout, second: true)
                }
            }
        }
    }

    /// How an `evaluateJavaScript` result reads: only WebKit's own "the web process is gone" errors mean the page is not there.
    static func pulse(for error: Error?) -> PagePulse {
        guard let error else { return .answered }
        let e = error as NSError
        let gone = [WKError.webContentProcessTerminated.rawValue, WKError.webViewInvalidated.rawValue]
        return e.domain == WKError.errorDomain && gone.contains(e.code) ? .failed : .answered
    }

    /// One ping, answered once: by the script, or `.silent` after `timeout`. `evaluate` runs the script and reports its error;
    /// `after` runs a closure later. A late answer after the timeout (or a second answer) is ignored.
    static func ping(
        timeout: TimeInterval,
        evaluate: (@escaping (Error?) -> Void) -> Void,
        after: (TimeInterval, @escaping () -> Void) -> Void,
        _ done: @escaping (PagePulse) -> Void
    ) {
        var answered = false
        func answer(_ pulse: PagePulse) {
            guard !answered else { return }
            answered = true
            done(pulse)
        }
        evaluate { answer(pulse(for: $0)) }
        after(timeout) { answer(.silent) }
    }

    /// `evaluateJavaScript("1")` against the web view.
    static func ping(_ webView: WKWebView, timeout: TimeInterval, _ done: @escaping (PagePulse) -> Void) {
        ping(
            timeout: timeout,
            evaluate: { reply in webView.evaluateJavaScript("1") { _, error in reply(error) } },
            after: { delay, run in DispatchQueue.main.asyncAfter(deadline: .now() + delay, execute: run) },
            done)
    }
}
