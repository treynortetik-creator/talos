import BridgeGuard
import WebKit

/// What a trivial script asked of the page came back as.
enum PagePulse: Equatable {
    /// The page ran it and has content.
    case answered
    /// A document is there and it is empty: the web process was started again with nothing in it.
    case blank
    /// The script could not run: the page's web process is gone.
    case failed
    /// Nothing came back in time: the web process is alive and not answering.
    case silent
}

/// The page can be dead or stuck while the shell thinks it is fine. iOS can kill the web content process while the app is in
/// the background (WebKit does not always report that), and a web process that does not wake up leaves a black view that never
/// answers a touch, with `webView.url` still the relay URL, so `needsRetry` says "fine". On every return to the front this
/// asks the page a trivial question and acts only when it is not there:
///  - no URL (and no load running): load the start URL;
///  - the process is gone: leave it to the load that follows a process death for a moment, then load the page again if
///    nothing is loading;
///  - the document is empty and nothing is loading: load the page again;
///  - no answer: ask once more, with more time (a page that is busy waking up answers late). Only a second silence means
///    the process is stuck, and a load would queue behind it, so the web view is built again.
///
/// While a check has gone on longer than `noticeDelay` the owner sees "Reconnecting…" (`waiting`), never a bare black view.
///
/// A check belongs to one foreground: leaving the front (`cancel`) voids it, and so does an answer that arrives while the app is
/// not active. One check at a time and at most one remedy per foreground, so a page that stays dead cannot loop. Every effect is
/// injected, so the decision is unit-tested without a real web process (AppTests/WebViewRevivalTests).
@MainActor
final class WebViewRevival {
    /// How long the page has the first time, and the second time, before it counts as silent.
    static let firstTimeout: TimeInterval = 2
    static let secondTimeout: TimeInterval = 5
    /// A check that is still open after this long shows the notice. A live page answers well inside it, so it never flashes.
    static let noticeDelay: TimeInterval = 0.4

    /// Runs a trivial script and calls back once, within the given time.
    typealias Ping = (TimeInterval, @escaping (PagePulse) -> Void) -> Void

    private let hasPage: () -> Bool
    private let isBusy: () -> Bool
    private let isActive: () -> Bool
    private let ping: Ping
    private let hop: (@escaping () -> Void) -> Void
    private let after: (TimeInterval, @escaping () -> Void) -> Void
    private let waiting: (Bool) -> Void
    private let reload: () -> Void
    private let rebuild: () -> Void
    private var generation = 0
    private var checking = false
    private var noticeUp = false

    /// - hasPage: the web view has a URL (nil after a process death that took the document with it).
    /// - isBusy: a load is running or the offline page is up. A load that is already going is never replaced by a reload; it does
    ///   not stop the check for a stuck process, which a loading page cannot hide from.
    /// - isActive: the app is in front and taking input.
    /// - hop: runs the closure after one turn of the run loop.
    /// - after: runs the closure after the given time.
    /// - waiting: true while a check has been open for longer than `noticeDelay` (the "Reconnecting…" notice), then false.
    /// - reload: loads the page again, on the route it was on.
    /// - rebuild: replaces the web view (and its web process) with a new one.
    init(hasPage: @escaping () -> Bool, isBusy: @escaping () -> Bool, isActive: @escaping () -> Bool,
         ping: @escaping Ping, hop: @escaping (@escaping () -> Void) -> Void,
         after: @escaping (TimeInterval, @escaping () -> Void) -> Void, waiting: @escaping (Bool) -> Void,
         reload: @escaping () -> Void, rebuild: @escaping () -> Void) {
        self.hasPage = hasPage
        self.isBusy = isBusy
        self.isActive = isActive
        self.ping = ping
        self.hop = hop
        self.after = after
        self.waiting = waiting
        self.reload = reload
        self.rebuild = rebuild
    }

    /// The app came to the front. Does nothing unless the page is dead or stuck.
    func appDidForeground() {
        guard !checking else { return }
        if !hasPage(), !isBusy() { return reload() } // nothing to ask: there is no document
        checking = true
        generation += 1
        let gen = generation
        after(Self.noticeDelay) { [weak self] in
            guard let self, gen == self.generation, self.checking, !self.noticeUp else { return }
            self.noticeUp = true
            self.waiting(true)
        }
        ask(gen, timeout: Self.firstTimeout, second: false)
    }

    /// The check is over (answered, acted on or void): the notice goes.
    private func lowerNotice() {
        guard noticeUp else { return }
        noticeUp = false
        waiting(false)
    }

    /// The app is leaving the front (or has): whatever is being asked is void, and so is any answer still on its way.
    func cancel() {
        generation += 1
        checking = false
        lowerNotice()
    }

    private func ask(_ gen: Int, timeout: TimeInterval, second: Bool) {
        ping(timeout) { [weak self] pulse in
            guard let self, gen == self.generation, self.checking else { return } // one answer per check is acted on
            guard self.isActive() else { return self.cancel() } // a timeout that lands in the background says nothing about the page
            switch pulse {
            case .answered:
                self.checking = false
                self.lowerNotice()
            case .blank:
                // An empty document that nothing is filling. A load that is running is watched by the shell and left alone.
                self.checking = false
                if !self.isBusy() { self.reload() }
                self.lowerNotice()
            case .failed:
                self.checking = false
                self.hop { [weak self] in
                    // A process death starts its own load; only a page nothing is loading is ours to load. The notice stays
                    // up over this turn, so it does not blink between the check and the load.
                    guard let self, gen == self.generation else { return }
                    if self.isActive(), !self.isBusy() { self.reload() }
                    self.lowerNotice()
                }
            case .silent:
                if second {
                    self.checking = false
                    self.rebuild()
                    self.lowerNotice()
                } else {
                    self.ask(gen, timeout: Self.secondTimeout, second: true)
                }
            }
        }
    }

    /// How an `evaluateJavaScript` answer reads. The script (BridgeGuard.livenessScript) cannot throw and always returns a
    /// string, so a page that is there never produces an error: any error means there is no page to run it. That matters
    /// because WebKit does not use its "process terminated" code here: a web view whose process died answers with
    /// `javaScriptResultTypeIsUnsupported` (seen on iOS 27.2, AppTests/WebViewLivenessTests), which the first version of this
    /// check read as "the page is there". With no error, only the script's own "page" answer is a live page; anything else is an
    /// empty document.
    static func pulse(result: Any?, error: Error?) -> PagePulse {
        guard error == nil else { return .failed }
        return BridgeGuard.isLivePage(probeResult: result) ? .answered : .blank
    }

    /// One ping, answered once: by the script, or `.silent` after `timeout`. `evaluate` runs the script and reports its answer;
    /// `after` runs a closure later. A late answer after the timeout (or a second answer) is ignored.
    static func ping(
        timeout: TimeInterval,
        evaluate: (@escaping (Any?, Error?) -> Void) -> Void,
        after: (TimeInterval, @escaping () -> Void) -> Void,
        _ done: @escaping (PagePulse) -> Void
    ) {
        var answered = false
        func answer(_ pulse: PagePulse) {
            guard !answered else { return }
            answered = true
            done(pulse)
        }
        evaluate { answer(pulse(result: $0, error: $1)) }
        after(timeout) { answer(.silent) }
    }

    /// The liveness script (BridgeGuard.livenessScript) against the web view.
    static func ping(_ webView: WKWebView, timeout: TimeInterval, _ done: @escaping (PagePulse) -> Void) {
        ping(
            timeout: timeout,
            evaluate: { reply in webView.evaluateJavaScript(BridgeGuard.livenessScript) { result, error in reply(result, error) } },
            after: { delay, run in DispatchQueue.main.asyncAfter(deadline: .now() + delay, execute: run) },
            done)
    }
}
